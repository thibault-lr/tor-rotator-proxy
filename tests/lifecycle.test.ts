import assert from "node:assert/strict";
import { once } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  handshake,
  connectionCount,
  harness,
  readHeaders,
  readExactly,
  readToEnd,
  untilClosed,
} from "./helpers.ts";

async function waitForIdle(app: Awaited<ReturnType<typeof harness>>) {
  const deadline = performance.now() + 2_500;
  while (
    ((await connectionCount(app.proxy.server)) ||
      app.backendSockets.size > 0) &&
    performance.now() < deadline
  ) {
    await delay(10);
  }
  assert.equal(await connectionCount(app.proxy.server), 0);
  assert.equal(app.backendSockets.size, 0);
}

function flood(socket: Socket) {
  const chunk = Buffer.alloc(64 * 1_024, 0xab);
  const write = () => {
    while (!socket.destroyed && socket.write(chunk)) {
      /* bounded by socket backpressure */
    }
  };
  socket.on("drain", write);
  socket.once("close", () => socket.off("drain", write));
  write();
}

test(
  "admission stays held after CONNECT and is released after closing the tunnel",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        socket.pipe(socket);
        await untilClosed(socket);
      },
      { maxConnections: 1 },
    );
    const first = await app.tunnel();
    const excess = await app.connect();
    const refusal = (await readToEnd(excess)).toString();
    assert.match(refusal, /^HTTP\/1\.1 503 /);
    assert.equal(app.backendSockets.size, 1);
    first.end();
    await readToEnd(first);
    await waitForIdle(app);
    const replacement = await app.tunnel();
    replacement.end();
    await readToEnd(replacement);
  },
);

test(
  "client cancellation aborts a pending SOCKS handshake and closes the backend socket",
  { timeout: 6_000 },
  async (t) => {
    let started!: () => void;
    const greeting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await harness(
      t,
      async (socket) => {
        await readExactly(socket, 3);
        started();
        await untilClosed(socket);
      },
      { connectTimeoutMs: 5_000 },
    );
    const client = await app.connect();
    client.write("CONNECT origin.invalid:443 HTTP/1.1\r\nHost: test\r\n\r\n");
    await greeting;
    client.destroy();
    await waitForIdle(app);
  },
);

test(
  "shutdown cancels pending SOCKS work without sending an upstream failure",
  { timeout: 6_000 },
  async (t) => {
    let started!: () => void;
    const greeting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await harness(
      t,
      async (socket) => {
        await readExactly(socket, 3);
        started();
        await untilClosed(socket);
      },
      { connectTimeoutMs: 5_000, shutdownGraceMs: 80 },
    );
    const client = await app.connect();
    client.write("CONNECT origin.invalid:443 HTTP/1.1\r\nHost: test\r\n\r\n");
    await greeting;
    await app.proxy.stop();
    await waitForIdle(app);
    assert.equal((await readToEnd(client)).length, 0);
  },
);

test(
  "shutdown refuses a first request on an already accepted connection",
  { timeout: 6_000 },
  async (t) => {
    for (const requestLine of [
      "GET http://origin.invalid/ HTTP/1.1",
      "CONNECT origin.invalid:443 HTTP/1.1",
    ]) {
      let calls = 0;
      const app = await harness(t, async () => {
        calls++;
      });
      const accepted = once(app.proxy.server, "connection");
      const client = await app.connect();
      await accepted;
      const stopped = app.proxy.stop();
      client.write(`${requestLine}\r\nHost: origin.invalid\r\n\r\n`);
      assert.match((await readToEnd(client)).toString(), /^HTTP\/1\.1 503 /);
      await stopped;
      await waitForIdle(app);
      assert.equal(calls, 0);
    }
  },
);

test(
  "shutdown closes active tunnels and completes only after connections are closed",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        socket.pipe(socket);
        await untilClosed(socket);
      },
      { shutdownGraceMs: 80 },
    );
    const client = await app.tunnel();
    assert.equal(await connectionCount(app.proxy.server), 1);
    await app.proxy.stop();
    assert.equal(await connectionCount(app.proxy.server), 0);
    await waitForIdle(app);
    assert.equal((await readToEnd(client)).length, 0);
  },
);

test(
  "independent idle deadline closes a tunnel while its client stops reading",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        flood(socket);
        await untilClosed(socket);
      },
      { idleTimeoutMs: 120, maxStreamMs: 10_000 },
    );
    const client = await app.tunnel();
    client.pause();
    await waitForIdle(app);
    client.destroy();
  },
);

test(
  "independent idle deadline also releases a blocked plain HTTP stream",
  { timeout: 6_000 },
  async (t) => {
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        await readHeaders(socket);
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Length: 1000000000\r\nConnection: close\r\n\r\n",
        );
        flood(socket);
        started();
        await untilClosed(socket);
      },
      { idleTimeoutMs: 120, maxStreamMs: 10_000 },
    );
    const client = await app.connect();
    client.write("GET http://origin.invalid/ HTTP/1.1\r\nHost: test\r\n\r\n");
    await streaming;
    client.pause();
    await waitForIdle(app);
    client.destroy();
  },
);

test(
  "maximum stream lifetime expires even while traffic continues",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        socket.pipe(socket);
        await untilClosed(socket);
      },
      { idleTimeoutMs: 500, maxStreamMs: 150 },
    );
    const client = await app.tunnel();
    const activity = setInterval(() => {
      if (!client.destroyed) {
        client.write("ping");
      }
    }, 10);
    try {
      await untilClosed(client);
    } finally {
      clearInterval(activity);
    }
    await waitForIdle(app);
  },
);

test(
  "partial headers expire without contacting SOCKS",
  { timeout: 6_000 },
  async (t) => {
    let calls = 0;
    const app = await harness(
      t,
      async () => {
        calls++;
      },
      { headerTimeoutMs: 80, idleTimeoutMs: 500 },
    );
    const client = await app.connect();
    client.write("CONNECT origin.invalid:443 HTTP/1.1\r\nHost:");
    assert.equal((await readToEnd(client)).length, 0);
    await waitForIdle(app);
    assert.equal(calls, 0);
  },
);

test(
  "optimistic CONNECT data is bounded while SOCKS is pending",
  { timeout: 6_000 },
  async (t) => {
    let started!: () => void;
    const greeting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await harness(
      t,
      async (socket) => {
        await readExactly(socket, 3);
        started();
        await untilClosed(socket);
      },
      { connectTimeoutMs: 5_000 },
    );
    const client = await app.connect();
    client.write("CONNECT origin.invalid:443 HTTP/1.1\r\nHost: test\r\n\r\n");
    await greeting;
    client.write(Buffer.alloc(128 * 1_024));
    await untilClosed(client);
    await waitForIdle(app);
  },
);
