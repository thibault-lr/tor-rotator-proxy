import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";

import { config as defaultConfig } from "../src/config.ts";
import { createProxy } from "../src/server.ts";
import type { Config } from "../src/types.ts";

export type Route = {
  host: string;
  port: number;
  addressType: number;
  username: string;
  password: string;
};

// Read a fixture frame without consuming the following bytes.
export function readExactly(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("readable", read);
      socket.off("error", fail);
      socket.off("end", ended);
      socket.off("close", ended);
    };
    const fail = (cause: Error) => {
      cleanup();
      reject(new Error("SOCKS handshake read failed", { cause }));
    };
    const ended = () => fail(new Error("SOCKS socket closed during handshake"));
    const read = () => {
      const chunk: Buffer | null = socket.read(size);
      if (chunk !== null) {
        cleanup();
        resolve(chunk);
      } else if (socket.destroyed || socket.readableEnded) {
        ended();
      }
    };
    socket.on("readable", read);
    socket.once("error", fail);
    socket.once("end", ended);
    socket.once("close", ended);
    read();
  });
}

export async function handshake(socket: Socket, reply = 0): Promise<Route> {
  assert.deepEqual(await readExactly(socket, 4), Buffer.from([5, 2, 0, 2]));
  socket.write(Buffer.from([5, 2]));
  const auth = await readExactly(socket, 2);
  assert.equal(auth[0], 1);
  const username = (await readExactly(socket, auth[1]!)).toString();
  const passwordSize = (await readExactly(socket, 1))[0]!;
  const password = (await readExactly(socket, passwordSize)).toString();
  socket.write(Buffer.from([1, 0]));
  const command = await readExactly(socket, 4);
  assert.deepEqual(command.subarray(0, 3), Buffer.from([5, 1, 0]));
  const addressType = command[3]!;
  const size =
    addressType === 3
      ? (await readExactly(socket, 1))[0]!
      : addressType === 1
        ? 4
        : 16;
  const address = await readExactly(socket, size);
  const host = addressType === 3 ? address.toString() : address.toString("hex");
  const port = (await readExactly(socket, 2)).readUInt16BE();
  // A fragmented reply plus possible early origin bytes exercises the real stream boundary.
  for (const byte of [5, reply, 0, 1, 127, 0, 0, 1, 0, 80]) {
    socket.write(Buffer.from([byte]));
  }
  return { host, port, addressType, username, password };
}

export async function readHeaders(socket: Socket) {
  let headers = "";
  while (!headers.endsWith("\r\n\r\n")) {
    assert.ok(headers.length < 16_384);
    headers += (await readExactly(socket, 1)).toString("latin1");
  }
  return headers;
}

export function header(headers: string, name: string) {
  const line = headers
    .split("\r\n")
    .find((entry) => entry.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line?.slice(line.indexOf(":") + 1).trim();
}

export async function untilClosed(socket: Socket) {
  if (socket.closed) {
    return;
  }
  if (socket.readableEnded) {
    socket.end();
  } else {
    socket.once("end", () => socket.end());
  }
  socket.resume();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

export async function readToEnd(socket: Socket) {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function harness(
  t: TestContext,
  serve: (socket: Socket) => Promise<void>,
  overrides: Partial<Config> = {},
) {
  const backendSockets = new Set<Socket>();
  const clients = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let closing = false;
  let acceptedRoutes = 0;
  const backend = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    backendSockets.add(socket);
    acceptedRoutes++;
    socket.once("close", () => backendSockets.delete(socket));
    const work = serve(socket)
      .catch((cause) => {
        if (!closing) {
          errors.push(cause);
        }
      })
      .finally(() => {
        pending.delete(work);
        socket.destroy();
      });
    pending.add(work);
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const config: Config = {
    ...defaultConfig,
    proxyBind: { host: "127.0.0.1", port: 0 },
    torEndpoints: [{ host: "127.0.0.1", port: address.port }],
    sessionCount: 2,
    shutdownGraceMs: 150,
    ...overrides,
  };
  const proxy = createProxy(config);
  proxy.server.listen(config.proxyBind.port, config.proxyBind.host);
  await once(proxy.server, "listening");
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  const proxyPort = proxyAddress.port;
  t.after(async () => {
    closing = true;
    for (const client of clients) {
      client.destroy();
    }
    await proxy.stop();
    for (const socket of backendSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await Promise.all(pending);
    assert.equal(await connectionCount(proxy.server), 0);
    assert.deepEqual(errors, []);
  });
  async function connect() {
    const socket = createConnection({
      host: "127.0.0.1",
      port: proxyPort,
      allowHalfOpen: true,
    });
    socket.on("error", () => {});
    socket.setTimeout(4_000, () =>
      socket.destroy(new Error("Test socket deadline exceeded")),
    );
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    await once(socket, "connect");
    return socket;
  }
  async function tunnel(
    target = "never-resolve-locally.invalid:443",
    extra = "",
    head = Buffer.alloc(0),
  ) {
    const socket = await connect();
    socket.write(
      Buffer.concat([
        Buffer.from(
          "CONNECT " +
            target +
            " HTTP/1.1\r\nHost: " +
            target +
            "\r\n" +
            extra +
            "\r\n",
        ),
        head,
      ]),
    );
    const response = await readHeaders(socket);
    assert.equal(response, "HTTP/1.1 200 Connection Established\r\n\r\n");
    return socket;
  }
  return {
    config,
    backendSockets,
    acceptedRoutes: () => acceptedRoutes,
    proxy,
    proxyPort,
    connect,
    tunnel,
    backendPort: address.port,
  };
}

export function connectionCount(server: Server) {
  return new Promise<number>((resolve, reject) =>
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = {}): Config {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { config } from "./src/config.ts"; process.stdout.write(JSON.stringify(config));',
    ],
    { cwd: new URL("../", import.meta.url), env, encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return JSON.parse(result.stdout);
}
