import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

import { SocksClient } from "socks";

export type Target = { host: string; port: number };
export type Credentials = { username: string; password: string };
export class ConnectTimeoutError extends Error {}

export function createSessionRotation(
  count: number,
  ttlMs: number,
  now = performance.now(),
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 256 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new Error("Invalid session count or TTL");
  }
  const sessions = Array.from({ length: count }, (_, id) => ({
    expiresAt: now + (ttlMs * (id + 1)) / count,
    credentials: newCredentials(),
  }));
  let index = 0;
  return function nextSession(now = performance.now()) {
    const id = index;
    index = (index + 1) % count;
    const session = sessions[id]!;
    if (now >= session.expiresAt) {
      session.credentials = newCredentials();
      // Keep renewal staggered after idle periods.
      session.expiresAt = now + ttlMs - ((now - session.expiresAt) % ttlMs);
    }
    return { id, ...session.credentials };
  };
}

function newCredentials() {
  return {
    username: randomBytes(16).toString("hex"),
    password: randomBytes(16).toString("hex"),
  };
}

export async function openTorConnection(
  endpoint: Target,
  target: Target,
  credentials: Credentials,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = createConnection({
    ...endpoint,
    allowHalfOpen: true,
    signal,
    noDelay: true,
  });
  socket.on("error", () => {});
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    socket.destroy(new Error("Tor connection deadline exceeded"));
  }, timeoutMs);

  // socks offers unauthenticated access too; reject it to keep Tor session isolation.
  const authenticationReply: number[] = [];
  const requireAuthentication = (chunk: Buffer) => {
    for (const byte of chunk) {
      authenticationReply.push(byte);
      if (authenticationReply.length < 2) {
        continue;
      }
      socket.off("data", requireAuthentication);
      const [, method] = authenticationReply;
      if (method !== 2) {
        socket.destroy(new Error("SOCKS isolation authentication refused"));
      }
      break;
    }
  };

  try {
    await once(socket, "connect");
    socket.prependListener("data", requireAuthentication);
    const connected = await SocksClient.createConnection({
      command: "connect",
      proxy: {
        ...endpoint,
        type: 5,
        userId: credentials.username,
        password: credentials.password,
      },
      destination: target,
      timeout: timeoutMs,
      existing_socket: socket,
    });
    return connected.socket;
  } catch (cause) {
    socket.destroy();
    if (timedOut) {
      throw new ConnectTimeoutError("Tor connection deadline exceeded", {
        cause,
      });
    }
    throw new Error("Tor SOCKS connection failed", { cause });
  } finally {
    clearTimeout(deadline);
    socket.off("data", requireAuthentication);
  }
}
