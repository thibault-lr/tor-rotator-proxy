import {
  createServer,
  ServerResponse,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { Socket } from "node:net";

import { config as baseConfig } from "./config.ts";
import {
  handleHttpRequest,
  handleConnectRequest,
  validateRequest,
  respond,
  setConnectionTimeouts,
} from "./proxy.ts";
import { createSessionRotation } from "./tor.ts";
import type { Config } from "./types.ts";

type ClientConnection = {
  socket: Socket;
  abortController: AbortController;
  requestStarted: boolean;
  headerDeadline: NodeJS.Timeout;
};

type ProxyState = {
  config: Config;
  draining: boolean;
  nextSession: ReturnType<typeof createSessionRotation>;
  connections: Map<Socket, ClientConnection>;
  pendingRequests: Set<Promise<void>>;
};

export function createProxy(config: Config = baseConfig) {
  const state: ProxyState = {
    config,
    draining: false,
    nextSession: createSessionRotation(
      config.sessionCount,
      config.sessionTtlMs,
    ),
    connections: new Map(),
    pendingRequests: new Set(),
  };

  const server = createServer({
    maxHeaderSize: 16 * 1_024,
    highWaterMark: 16 * 1_024,
    headersTimeout: config.headerTimeoutMs,
    requestTimeout: 0,
    connectionsCheckingInterval: Math.min(1_000, config.headerTimeoutMs),
    joinDuplicateHeaders: true,
  });
  server.maxHeadersCount = 100;

  // One plain HTTP request per connection bound pipelined SOCKS work
  server.maxRequestsPerSocket = 1;

  server.on("connection", (socket) => acceptConnection(socket, state));
  server.on("clientError", (cause, socket) => {
    if ("code" in cause && cause.code === "ERR_HTTP_REQUEST_TIMEOUT") {
      socket.destroy();
      return;
    }
    if (!socket.destroyed && socket.writable) {
      respond(socket, 400, "Invalid HTTP request\n");
    }
  });
  server.on("request", (incoming, response) => {
    response.shouldKeepAlive = false;
    const context = startRequest(incoming, response, state);
    if (context) {
      trackRequest(
        state,
        handleHttpRequest(incoming, response, context),
        response,
      );
    }
  });
  server.on("connect", (incoming, _socket, head) => {
    const context = startRequest(incoming, incoming.socket, state);
    if (context) {
      trackRequest(
        state,
        handleConnectRequest(incoming, head, context),
        incoming.socket,
      );
    }
  });
  server.on("upgrade", (incoming) => {
    if (startRequest(incoming, incoming.socket, state)) {
      validateRequest(incoming, incoming.socket);
    }
  });
  return { server, stop: () => stopProxy(server, state) };
}

function acceptConnection(socket: Socket, state: ProxyState) {
  const { config, connections } = state;
  socket.on("error", () => {});
  socket.setNoDelay(true);
  if (state.draining || connections.size >= config.maxConnections) {
    respond(socket, 503, "Proxy admission limit reached\n", {
      "retry-after": "1",
    });
    setTimeout(() => socket.destroy(), 50).unref();
    return;
  }

  const connection: ClientConnection = {
    socket,
    abortController: new AbortController(),
    requestStarted: false,
    headerDeadline: setTimeout(
      () => closeConnection(connection),
      config.headerTimeoutMs,
    ).unref(),
  };
  connections.set(socket, connection);
  setConnectionTimeouts(socket, config.idleTimeoutMs, config.maxStreamMs, () =>
    closeConnection(connection),
  );
  socket.once("close", () => {
    clearTimeout(connection.headerDeadline);
    closeConnection(connection);
    connections.delete(socket);
  });
}

function closeConnection(connection: ClientConnection) {
  if (connection.abortController.signal.aborted) {
    return;
  }
  connection.abortController.abort();
  connection.socket.destroy();
}

function trackRequest(
  state: ProxyState,
  work: Promise<void>,
  output: ServerResponse | Socket,
) {
  const { pendingRequests } = state;
  const handled = work
    .catch(() => {
      console.error("Unexpected proxy request failure");
      if (output instanceof ServerResponse) {
        respond(output, 502, "Upstream response failed\n");
      } else {
        output.destroy();
      }
    })
    .finally(() => pendingRequests.delete(handled));
  pendingRequests.add(handled);
}

function startRequest(
  incoming: IncomingMessage,
  output: ServerResponse | Socket,
  state: ProxyState,
) {
  const { connections } = state;
  const connection = connections.get(incoming.socket);
  if (!connection) {
    return;
  }
  clearTimeout(connection.headerDeadline);

  // CONNECT bypasses Node's HTTP request limit, including after a pipelined GET.
  if (connection.requestStarted) {
    closeConnection(connection);
    return;
  }
  connection.requestStarted = true;
  if (state.draining) {
    respond(output, 503, "Proxy is shutting down\n");
    return;
  }
  return {
    config: state.config,
    nextSession: state.nextSession,
    signal: connection.abortController.signal,
    close: () => closeConnection(connection),
  };
}

async function stopProxy(server: Server, state: ProxyState) {
  state.draining = true;
  const active = [...state.connections.values()];
  const closed = active
    .filter(({ socket }) => !socket.closed)
    .map(
      ({ socket }) =>
        new Promise<void>((resolve) => socket.once("close", resolve)),
    );
  const deadline = setTimeout(
    () => active.forEach(closeConnection),
    state.config.shutdownGraceMs,
  ).unref();
  try {
    const stopped = server.listening
      ? new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
    await Promise.all([stopped, ...closed]);
    await Promise.all(state.pendingRequests);
  } finally {
    clearTimeout(deadline);
  }
}
