import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";

import { config } from "../src/config.ts";
import { createProxy } from "../src/server.ts";

type Route = {
  host: string;
  port: number;
  addressType: number;
  username: string;
  password: string;
};

// Read a fixture frame without consuming the following bytes.
function readExactly(socket: Socket, size: number): Promise<Buffer> {
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

async function handshake(socket: Socket, reply = 0): Promise<Route> {
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

async function untilClosed(socket: Socket) {
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

export async function startTestProxy(
  t: TestContext,
  serve: (socket: Socket, route: Route) => void | Promise<void>,
) {
  const sockets = new Set<Socket>();
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  const routes: Route[] = [];
  let closing = false;
  let refuseNext = false;

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const tor = createServer({ allowHalfOpen: true }, (socket) => {
    track(socket);
    const refused = refuseNext;
    refuseNext = false;
    const work = async () => {
      const route = await handshake(socket, refused ? 5 : 0);
      routes.push(route);
      if (!refused) {
        await serve(socket, route);
      }
      await untilClosed(socket);
    };
    pending.push(
      work()
        .catch((error) => {
          if (!closing) {
            errors.push(error);
          }
        })
        .finally(() => socket.destroy()),
    );
  });
  tor.listen(0, "127.0.0.1");
  await once(tor, "listening");
  const torAddress = tor.address();
  assert.ok(torAddress && typeof torAddress !== "string");

  const proxy = createProxy({
    ...config,
    torEndpoints: [{ host: "127.0.0.1", port: torAddress.port }],
    sessionCount: 2,
    shutdownGraceMs: 100,
  });
  t.after(async () => {
    closing = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    await proxy.stop();
    await new Promise<void>((resolve) => tor.close(() => resolve()));
    await Promise.all(pending);
    assert.deepEqual(errors, []);
  });
  proxy.server.listen(0, "127.0.0.1");
  await once(proxy.server, "listening");
  const address = proxy.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  async function connect() {
    const socket = createConnection({
      host: "127.0.0.1",
      port,
      allowHalfOpen: true,
    });
    track(socket);
    socket.setTimeout(4_000, () =>
      socket.destroy(new Error("Test connection timed out")),
    );
    await once(socket, "connect");
    return socket;
  }
  return {
    routes,
    refuseNextConnection() {
      refuseNext = true;
    },
    async get(url: string, headers: Record<string, string> = {}) {
      const socket = await connect();
      const extraHeaders = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${extraHeaders}Connection: close\r\n\r\n`,
      );
      return (await readToEnd(socket)).toString();
    },
    async openTunnel() {
      const socket = await connect();
      socket.write(
        "CONNECT origin.invalid:443 HTTP/1.1\r\nHost: origin.invalid:443\r\n\r\n",
      );
      assert.equal(
        await readHeaders(socket),
        "HTTP/1.1 200 Connection Established\r\n\r\n",
      );
      return socket;
    },
  };
}
