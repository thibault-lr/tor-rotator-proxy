import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";

import {
  handshake,
  harness,
  readHeaders,
  readToEnd,
  untilClosed,
} from "./helpers.ts";

test(
  "connections rotate between Tor endpoints without a fallback after refusal",
  { timeout: 5_000 },
  async (t) => {
    const visits: number[] = [];
    const credentials: string[] = [];
    const serve = async (id: number, socket: import("node:net").Socket) => {
      const route = await handshake(socket);
      assert.equal(route.host, "never-resolve-locally.invalid");
      visits.push(id);
      credentials.push(route.username);
      socket.pipe(socket);
      await untilClosed(socket);
    };
    const app = await harness(t, (socket) => serve(0, socket));
    const sockets = new Set<import("node:net").Socket>();
    const errors: unknown[] = [];
    const second = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      void serve(1, socket)
        .catch((error) => errors.push(error))
        .finally(() => socket.destroy());
    });
    second.listen(0, "127.0.0.1");
    await once(second, "listening");
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => second.close(() => resolve()));
      assert.deepEqual(errors, []);
    });
    const address = second.address();
    assert.ok(address && typeof address !== "string");
    app.config.torEndpoints.push({ host: "127.0.0.1", port: address.port });
    for (let i = 0; i < 3; i++) {
      const client = await app.tunnel();
      client.end();
      await readToEnd(client);
    }
    assert.deepEqual(visits, [0, 1, 0]);
    assert.equal(credentials[0], credentials[2]);
    await new Promise<void>((resolve) => second.close(() => resolve()));
    const client = await app.connect();
    client.write(
      "CONNECT never-resolve-locally.invalid:443 HTTP/1.1\r\nHost: test\r\n\r\n",
    );
    assert.match(await readHeaders(client), /^HTTP\/1\.1 502 /);
    await readToEnd(client);
    assert.deepEqual(visits, [0, 1, 0]);
  },
);
