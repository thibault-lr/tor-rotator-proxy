import {
  STATUS_CODES,
  type IncomingHttpHeaders,
  request,
  ServerResponse,
  type IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";

import { setConnectionTimeouts } from "./timeouts.ts";
import {
  ConnectTimeoutError,
  openTorConnection,
  type createSessionRotation,
} from "./tor.ts";
import type { Config, Target } from "./types.ts";

type RequestTarget = Target & { authority: string; path: string };
type TorConnection = {
  upstream: Socket;
  signal: AbortSignal;
  destination: RequestTarget;
  closed: Promise<void>;
};

type RequestContext = {
  config: Config;
  nextSession: ReturnType<typeof createSessionRotation>;
  signal: AbortSignal;
  close: () => void;
};

export async function handleHttpRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
) {
  const opened = await connectToTarget(incoming, response, context);
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

export async function handleConnectRequest(
  incoming: IncomingMessage,
  head: Buffer,
  context: RequestContext,
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
    opened = await connectToTarget(incoming, client, context);
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

export function validateRequest(
  incoming: IncomingMessage,
  output: ServerResponse | Socket,
) {
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
  return destination;
}

async function connectToTarget(
  incoming: IncomingMessage,
  output: ServerResponse | Socket,
  context: RequestContext,
): Promise<TorConnection | undefined> {
  const { config, nextSession, signal, close } = context;
  const destination = validateRequest(incoming, output);
  if (!destination) {
    return;
  }
  const session = nextSession();
  let upstream: Socket;
  try {
    upstream = await openTorConnection(
      config.torEndpoints[session.id % config.torEndpoints.length]!,
      destination,
      session,
      config.connectTimeoutMs,
      signal,
    );
  } catch (cause) {
    if (!signal.aborted) {
      respond(
        output,
        cause instanceof ConnectTimeoutError ? 504 : 502,
        "Tor could not open the destination stream\n",
      );
    }
    return;
  }
  if (signal.aborted || upstream.destroyed) {
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
    close,
  );
  return { upstream, signal, destination, closed };
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
    signal: opened.signal,
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

export function respond(
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
