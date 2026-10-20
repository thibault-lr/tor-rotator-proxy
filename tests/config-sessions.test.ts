import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionRotation } from "../src/tor.ts";
import { loadConfig } from "./helpers.ts";

test("the exported config reads endpoints once and derives sixteen sessions per Tor", () => {
  assert.deepEqual(loadConfig({}).proxyBind, { host: "127.0.0.1", port: 5566 });
  const config = loadConfig({
    PROXY_BIND: "[::1]:5566",
    TOR_SOCKS_ADDRS: "[::1]:9050, tor-two:9050",
  });
  assert.deepEqual(config.proxyBind, { host: "::1", port: 5566 });
  assert.deepEqual(config.torEndpoints, [
    { host: "::1", port: 9050 },
    { host: "tor-two", port: 9050 },
  ]);
  assert.equal(config.sessionCount, 32);
  assert.equal(config.sessionTtlMs, 300_000);
  assert.equal(config.maxConnections, 256);
  assert.deepEqual(
    loadConfig({
      SESSION_COUNT: "0",
      LOG_LEVEL: "debug",
      MAX_CONNECTIONS: "0",
    }),
    loadConfig({}),
  );
});

test("configuration rejects invalid endpoints without revealing their values", () => {
  for (const env of [
    { PROXY_BIND: "localhost:5566" },
    { PROXY_BIND: "127.0.0.1:0" },
    { TOR_SOCKS_ADDRS: "" },
    { TOR_SOCKS_ADDRS: "tor:9050," },
    { TOR_SOCKS_ADDRS: "tor" },
    { TOR_SOCKS_ADDRS: "tor:65536" },
    { TOR_SOCKS_ADDRS: "tor:0" },
    { TOR_SOCKS_ADDRS: "a".repeat(256) + ":9050" },
    { TOR_SOCKS_ADDRS: "credential-marker@host:9050" },
    { TOR_SOCKS_ADDRS: "tor:9050/path" },
    { TOR_SOCKS_ADDRS: "tor:9050?token=credential-marker" },
    { TOR_SOCKS_ADDRS: "tor:9050#credential-marker" },
    { TOR_SOCKS_ADDRS: Array(17).fill("tor:9050").join(",") },
  ]) {
    assert.throws(
      () => loadConfig(env),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Expected/);
        assert.ok(!error.message.includes("credential-marker"));
        assert.ok(!Object.hasOwn(error, "cause"));
        return true;
      },
    );
  }
});

test("rotation reuses credentials in order until their staggered renewal", () => {
  const next = createSessionRotation(3, 60_000, 0);
  const first = [next(0), next(0), next(0)];
  assert.deepEqual(
    first.map(({ id }) => id),
    [0, 1, 2],
  );
  assert.equal(new Set(first.map(({ username }) => username)).size, 3);
  assert.equal(new Set(first.map(({ password }) => password)).size, 3);
  assert.deepEqual([next(19_999), next(19_999), next(19_999)], first);
  const renewed = next(20_000);
  assert.notEqual(renewed.username, first[0]!.username);
  assert.notEqual(renewed.password, first[0]!.password);
  assert.deepEqual(next(20_000), first[1]);
  assert.deepEqual(next(20_000), first[2]);
  const afterIdle = [next(125_000), next(125_000), next(125_000)];
  assert.deepEqual([next(139_999), next(139_999), next(139_999)], afterIdle);
  assert.notEqual(next(140_000).username, afterIdle[0]!.username);
  assert.deepEqual(next(140_000), afterIdle[1]);
  assert.deepEqual(next(140_000), afterIdle[2]);
  assert.notEqual(
    createSessionRotation(1, 60_000, 0)(0).username,
    first[0]!.username,
  );
});

test("rotation rejects invalid size and renewal intervals", () => {
  for (const count of [0, -1, 257, 0.5, NaN, Infinity]) {
    assert.throws(() => createSessionRotation(count, 60_000));
  }
  for (const ttl of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => createSessionRotation(1, ttl));
  }
});
