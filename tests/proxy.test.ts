import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { createSessionRotation } from "../src/tor.ts";
import { readHeaders, readToEnd, startTestProxy } from "./helpers.ts";

test("forwards an HTTP request through Tor", { timeout: 5_000 }, async (t) => {
  const proxy = await startTestProxy(t, async (origin, route) => {
    assert.equal(route.host, "origin.invalid");
    assert.equal(route.port, 80);
    assert.equal(route.addressType, 3);
    const headers = await readHeaders(origin);
    assert.match(headers, /^GET \/a\/\.\.\/hello\?q=test HTTP\/1\.1/);
    assert.match(headers, /\r\ncookie: session=test\r\n/i);
    assert.match(headers, /\r\nx-tor-session: application-value\r\n/i);
    assert.doesNotMatch(headers, /proxy-authorization/i);
    origin.end(
      "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
    );
  });

  const response = await proxy.get("http://origin.invalid/a/../hello?q=test", {
    Cookie: "session=test",
    "X-Tor-Session": "application-value",
    "Proxy-Authorization": "Basic dGVzdDp0ZXN0",
  });

  assert.match(response, /^HTTP\/1\.1 429 /);
  assert.match(response, /\r\nretry-after: 60\r\n/i);
  assert.ok(response.endsWith("hello"));
});

test(
  "streams CONNECT data and closes upstream when the client disconnects",
  { timeout: 5_000 },
  async (t) => {
    let originClosed: Promise<unknown[]> | undefined;
    const proxy = await startTestProxy(t, (origin, route) => {
      assert.equal(route.host, "origin.invalid");
      assert.equal(route.port, 443);
      originClosed = once(origin, "close");
      origin.pipe(origin);
    });
    const payload = Buffer.alloc(
      256 * 1_024,
      Buffer.from([0, 1, 127, 128, 255]),
    );

    const tunnel = await proxy.openTunnel();
    tunnel.end(payload);

    assert.deepEqual(await readToEnd(tunnel), payload);
    await originClosed;

    const cancelled = await proxy.openTunnel();
    cancelled.destroy();
    await originClosed;
  },
);

test(
  "rotates SOCKS credentials between sessions",
  { timeout: 5_000 },
  async (t) => {
    const proxy = await startTestProxy(t, (origin) => {
      origin.pipe(origin);
    });

    for (let index = 0; index < 3; index++) {
      const tunnel = await proxy.openTunnel();
      tunnel.end();
      await readToEnd(tunnel);
    }

    const [first, second, reused] = proxy.routes;
    assert.ok(first && second && reused);
    assert.notEqual(first.username, second.username);
    assert.notEqual(first.password, second.password);
    assert.equal(first.username, reused.username);
    assert.equal(first.password, reused.password);

    const nextSession = createSessionRotation(1, 100, 0);
    const before = nextSession(0);
    const after = nextSession(100);
    assert.notEqual(before.username, after.username);
    assert.notEqual(before.password, after.password);
  },
);

test(
  "serves the next request after a Tor connection fails",
  { timeout: 5_000 },
  async (t) => {
    const proxy = await startTestProxy(t, async (origin) => {
      await readHeaders(origin);
      origin.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
      );
    });
    proxy.refuseNextConnection();

    const failed = await proxy.get("http://origin.invalid/");
    const next = await proxy.get("http://origin.invalid/");

    assert.equal(failed, "");
    assert.match(next, /^HTTP\/1\.1 200 /);
    assert.ok(next.endsWith("ok"));
  },
);
