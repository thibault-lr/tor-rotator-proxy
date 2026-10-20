import {
  createServer,
  STATUS_CODES,
  type IncomingHttpHeaders,
  request,
  ServerResponse,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";

import { config as baseConfig } from "./config.ts";
import { setConnectionTimeouts } from "./timeouts.ts";
import {
  ConnectTimeoutError,
  createSessionRotation,
  openTorConnection,
  type Target,
} from "./tor.ts";

export type Config = {
  proxyBind: Target;
  torEndpoints: Target[];
  sessionCount: number;
  sessionTtlMs: number;
  maxConnections: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxStreamMs: number;
  headerTimeoutMs: number;
  shutdownGraceMs: number;
};

type ClientConnection = {
  socket: Socket;
  abortController: AbortController;
  requestStarted: boolean;
  headerDeadline: NodeJS.Timeout;
};
type RequestTarget = Target & { authority: string; path: string };
type TorConnection = {
  upstream: Socket;
  connection: ClientConnection;
  destination: RequestTarget;
  closed: Promise<void>;
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
    trackRequest(state, handleHttpRequest(incoming, response, state), response);
  });
  server.on("connect", (incoming, _socket, head) => {
    trackRequest(
      state,
      handleConnectRequest(incoming, head, state),
      incoming.socket,
    );
  });
  server.on("upgrade", (incoming) => {
    validateRequest(incoming, incoming.socket, state);
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

async function handleHttpRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  state: ProxyState,
) {
  response.shouldKeepAlive = false;
  const opened = await connectToTarget(incoming, response, state);
  if (!opened) {
    return;
  }
  try {
    forwardHttpRequest(incoming, response, opened);
    await opened.closed;
  } finally {
    opened.upstream.destroy();
    await opened.closed;
  }
}

async function handleConnectRequest(
  incoming: IncomingMessage,
  head: Buffer,
  state: ProxyState,
) {
  const client = incoming.socket;
  const chunks = [head];
  let size = head.length;
  const collect = (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64 * 1_024) {
      client.destroy();
    } else {
      chunks.push(chunk);
    }
  };
  const disconnected = client.destroy.bind(client);
  // Read during SOCKS negotiation to detect disconnection; bound any optimistic tunnel data.
  client.on("data", collect);
  client.once("end", disconnected);
  client.resume();
  let opened: TorConnection | undefined;
  try {
    opened = await connectToTarget(incoming, client, state);
  } finally {
    client.pause();
    client.off("data", collect);
    client.off("end", disconnected);
  }
  if (!opened) {
    return;
  }
  try {
    relayTunnel(client, Buffer.concat(chunks), opened);
    await opened.closed;
  } finally {
    opened.upstream.destroy();
    await opened.closed;
  }
}

function validateRequest(
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
  let destination: RequestTarget;
  try {
    destination = parseRequestTarget(incoming);
  } catch {
    respond(
      output,
      400,
      "Expected CONNECT host:port or an absolute http:// URL\n",
    );
    return;
  }
  if (incoming.method !== "CONNECT" && incoming.headers.upgrade !== undefined) {
    respond(output, 501, "Use CONNECT for protocol upgrades\n");
    return;
  }
  return { connection, destination };
}

async function connectToTarget(
  incoming: IncomingMessage,
  output: ServerResponse | Socket,
  state: ProxyState,
): Promise<TorConnection | undefined> {
  const { config, nextSession } = state;
  const validated = validateRequest(incoming, output, state);
  if (!validated) {
    return;
  }
  const { connection, destination } = validated;
  const session = nextSession();
  let upstream: Socket;
  try {
    upstream = await openTorConnection(
      config.torEndpoints[session.id % config.torEndpoints.length]!,
      destination,
      session,
      config.connectTimeoutMs,
      connection.abortController.signal,
    );
  } catch (cause) {
    if (!connection.abortController.signal.aborted) {
      respond(
        output,
        cause instanceof ConnectTimeoutError ? 504 : 502,
        "Tor could not open the destination stream\n",
      );
    }
    return;
  }
  if (connection.abortController.signal.aborted || upstream.destroyed) {
    upstream.destroy();
    return;
  }
  const closed = new Promise<void>((resolve) => {
    upstream.once("close", resolve);
  });
  setConnectionTimeouts(
    upstream,
    config.idleTimeoutMs,
    config.maxStreamMs,
    () => closeConnection(connection),
  );
  return { upstream, connection, destination, closed };
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

function parseRequestTarget(incoming: IncomingMessage): RequestTarget {
  const value = incoming.url ?? "";
  const tunnel = incoming.method === "CONNECT";
  const absolute = /^http:\/\/([^/?#]+)([^#]*)$/.exec(value);
  if (!tunnel && !absolute) {
    throw new Error("Expected an absolute HTTP URL");
  }
  const authority = tunnel ? value : absolute![1]!;
  if (/[@/?#\\\s]/.test(authority) || authority.endsWith(":")) {
    throw new Error("Invalid destination");
  }
  const url = new URL(`tcp://${authority}`);
  const port = Number(url.port || (tunnel ? 0 : 80));
  if (!url.hostname || url.hostname.length > 255 || !port) {
    throw new Error("Invalid destination host or port");
  }
  // Preserve the original HTTP path and query; URL normalization would change signed requests.
  const path = tunnel ? "" : absolute![2] || "/";
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    authority,
    path: path.startsWith("?") ? "/" + path : path,
  };
}

function relayTunnel(
  client: Socket,
  head: Buffer,
  { upstream }: TorConnection,
) {
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) {
    upstream.write(head);
  }
  client.pipe(upstream);
  pipeline(upstream, client, () => {});
}

function forwardHttpRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  opened: TorConnection,
) {
  const { upstream, destination } = opened;
  const headers = stripHopHeaders(incoming.headers);
  // Old proxy controls and correlation headers must not reach the origin.
  for (const name of Object.keys(headers)) {
    if (
      /^(x-radar-|x-tor-)/.test(name) ||
      name === "traceparent" ||
      name === "tracestate"
    ) {
      delete headers[name];
    }
  }
  headers.host = destination.authority;
  headers.connection = "close";
  const outgoing = request({
    hostname: destination.host,
    port: destination.port,
    path: destination.path,
    method: incoming.method,
    headers,
    // A supplied connection bypasses the global agent; there is no direct DNS/TCP fallback.
    createConnection: () => upstream,
    signal: opened.connection.abortController.signal,
  });
  outgoing.on("response", (origin) => {
    response.writeHead(
      origin.statusCode ?? 502,
      stripHopHeaders(origin.headers),
    );
    origin.once("error", () => response.destroy());
    origin.pipe(response);
  });
  outgoing.once("error", () => {
    upstream.destroy();
    respond(response, 502, "Upstream response failed\n");
  });
  incoming.pipe(outgoing);
}

function stripHopHeaders(original: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...original };
  const connection = original.connection;
  const nominated = (
    Array.isArray(connection) ? connection.join(",") : (connection ?? "")
  ).split(",");
  for (const name of [
    ...nominated,
    "connection",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[name.trim().toLowerCase()];
  }
  return headers;
}

function respond(
  output: ServerResponse | Duplex,
  status: number,
  body: string,
  extra: Record<string, string> = {},
) {
  if (output.destroyed || output.writableEnded) {
    return;
  }
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
    ...extra,
  };
  if (output instanceof ServerResponse) {
    if (output.headersSent) {
      return output.destroy();
    }
    output.writeHead(status, headers);
    output.end(body);
  } else {
    const lines = Object.entries(headers).map(
      ([name, value]) => `${name}: ${value}`,
    );
    output.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines.join("\r\n")}\r\n\r\n${body}`,
    );
  }
}
