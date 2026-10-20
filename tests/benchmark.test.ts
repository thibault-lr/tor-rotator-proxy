import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";

import { readBenchmarkOptions, measureProxy } from "../script/benchmark.ts";
import { probeIp } from "../script/ip-probe.ts";

test("benchmark has only instance, duration and rate options", () => {
  assert.deepEqual(readBenchmarkOptions([]), {
    instances: [1, 2, 4],
    durationMs: 60_000,
    requestsPerSecond: 1,
  });
  for (const args of [
    ["--instances", "0"],
    ["--instances", "17"],
    ["--instances", "1,1"],
    ["--duration", "0s"],
    ["--duration", "3601s"],
    ["--duration", "NaNs"],
    ["--requestsPerSecond", "0"],
    ["--requestsPerSecond", "6"],
    ["--requestsPerSecond", "NaN"],
    ["--sessions", "2"],
    ["--target", "ifconfig"],
    ["--timeout", "10s"],
    ["--concurrency", "20"],
  ]) {
    assert.throws(() => readBenchmarkOptions(args));
  }
});

test("IP checks reject non-local proxy addresses without contacting them", async () => {
  for (const proxy of [
    "http://example.com:80",
    "https://127.0.0.1:5566",
    "http://user:secret@127.0.0.1:80",
    "http://127.0.0.1:80/path",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "invalid",
  ]) {
    assert.deepEqual(await probeIp(proxy), {
      ip: null,
      status_code: null,
      error: "invalid_proxy",
    });
  }
});

test(
  "IP checks close refused CONNECT and cancelled TLS sockets without custom headers",
  { timeout: 3_000 },
  async (t) => {
    const sockets = new Set<Socket>();
    const requests: {
      host: string | undefined;
      target: string | undefined;
      session: string | string[] | undefined;
    }[] = [];
    let refuse = true;
    const server = createServer();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("end", () => socket.end());
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (request, socket) => {
      requests.push({
        host: request.headers.host,
        target: request.url,
        session: request.headers["x-tor-session"],
      });
      socket.write(
        refuse
          ? "HTTP/1.1 503 Unavailable\r\nContent-Length: 9999\r\n\r\n"
          : "HTTP/1.1 200 Connection Established\r\n\r\n",
      );
      socket.resume();
    });
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await probeIp(proxy), {
      ip: null,
      status_code: 503,
      error: "http_503",
    });
    refuse = false;
    assert.equal(
      (await probeIp(proxy, AbortSignal.timeout(50))).error,
      "cancelled",
    );
    await Promise.all([...sockets].map((socket) => once(socket, "close")));
    assert.equal(sockets.size, 0);
    assert.deepEqual(
      requests,
      Array(2).fill({
        host: "check.torproject.org:443",
        target: "check.torproject.org:443",
        session: undefined,
      }),
    );
  },
);

test(
  "a provider refusal stops the measurement and accounts for unsent requests",
  { timeout: 3_000 },
  async (t) => {
    const server = createServer();
    server.on("connect", (_request, socket) => {
      socket.on("error", () => {});
      socket.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n");
      socket.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const report = await measureProxy(
      `http://127.0.0.1:${address.port}`,
      { durationMs: 400, requestsPerSecond: 5 },
      new AbortController().signal,
    );
    assert.equal(report.offered, 2);
    assert.equal(report.attempted, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.succeeded, 0);
    assert.equal(report.skipped_reasons.refused, 1);
    assert.deepEqual(report.ips, []);
  },
);
