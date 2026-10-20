import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  handshake,
  connectionCount,
  harness,
  header,
  readHeaders,
  readExactly,
  readToEnd,
  untilClosed,
  type Route,
} from "./helpers.ts";

test(
  "CONNECT preserves early bytes, binary streams and half-close",
  { timeout: 6_000 },
  async (t) => {
    const payload = Buffer.from(
      Array.from({ length: 65_536 }, (_, index) => index % 256),
    );
    let route: Route | undefined;
    const app = await harness(t, async (socket) => {
      route = await handshake(socket);
      socket.write(Buffer.from("early-origin"));
      const received = await readExactly(socket, payload.length);
      assert.deepEqual(received, payload);
      socket.resume();
      await once(socket, "end");
      socket.end(Buffer.concat([received, Buffer.from("after-client-eof")]));
      await untilClosed(socket);
    });
    const client = await app.tunnel(undefined, "", payload.subarray(0, 1_024));
    client.end(payload.subarray(1_024));
    const received = await readToEnd(client);
    assert.deepEqual(
      received,
      Buffer.concat([
        Buffer.from("early-origin"),
        payload,
        Buffer.from("after-client-eof"),
      ]),
    );
    assert.equal(route?.host, "never-resolve-locally.invalid");
    assert.equal(route?.port, 443);
    await delay(10);
  },
);

test(
  "origin half-close keeps CONNECT open for the remaining client upload",
  { timeout: 6_000 },
  async (t) => {
    const payload = Buffer.from("upload-after-origin-eof");
    let uploaded!: () => void;
    const received = new Promise<void>((resolve) => {
      uploaded = resolve;
    });
    const app = await harness(t, async (socket) => {
      await handshake(socket);
      socket.end("origin-eof");
      assert.deepEqual(await readExactly(socket, payload.length), payload);
      uploaded();
      await untilClosed(socket);
    });
    const client = await app.tunnel();
    const ended = once(client, "end");
    assert.equal((await readExactly(client, 10)).toString(), "origin-eof");
    client.resume();
    await ended;
    assert.ok(!client.destroyed);
    assert.equal(await connectionCount(app.proxy.server), 1);
    client.end(payload);
    await received;
    await delay(10);
  },
);

test(
  "simultaneous tunnels use distinct SOCKS credentials",
  { timeout: 6_000 },
  async (t) => {
    const routes: Route[] = [];
    const app = await harness(t, async (socket) => {
      routes.push(await handshake(socket));
      socket.pipe(socket);
      await untilClosed(socket);
    });
    const first = await app.tunnel();
    const second = await app.tunnel();
    assert.equal(app.backendSockets.size, 2);
    assert.equal(routes.length, 2);
    assert.notEqual(routes[0]!.username, routes[1]!.username);
    assert.notEqual(routes[0]!.password, routes[1]!.password);
    first.end();
    second.end();
    await Promise.all([readToEnd(first), readToEnd(second)]);
  },
);

test(
  "absolute HTTP streams bodies, retains origin auth and removes nominated headers",
  { timeout: 6_000 },
  async (t) => {
    let originHeaders = "";
    const app = await harness(t, async (socket) => {
      const route = await handshake(socket);
      assert.equal(route.host, "origin.invalid");
      assert.equal(route.port, 8_080);
      assert.match(route.username, /^[a-f0-9]{32}$/);
      originHeaders = await readHeaders(socket);
      assert.equal((await readExactly(socket, 7)).toString(), "payload");
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close, X-Private\r\nX-Private: hidden\r\nProxy-Authenticate: hidden\r\nKeep-Alive: timeout=10\r\nX-Origin: kept\r\n\r\nhello",
      );
      await untilClosed(socket);
    });
    const client = await app.connect();
    client.write(
      "POST http://origin.invalid:8080/a/../path?x=1 HTTP/1.1\r\nHost: wrong.invalid\r\nAuthorization: Bearer origin-token\r\nProxy-Authorization: obsolete\r\nX-Radar-Request-Id: test:http\r\nX-Radar-Traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\r\nTraceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\r\nTracestate: vendor=private\r\nX-Tor-Session: 1\r\nConnection: close, X-Private\r\nConnection: X-Second\r\nX-Private: hidden\r\nX-Second: hidden\r\nTE: trailers\r\nContent-Length: 7\r\n\r\npayload",
    );
    const result = (await readToEnd(client)).toString();
    assert.match(result, /^HTTP\/1\.1 200 /);
    assert.ok(result.endsWith("hello"));
    assert.equal(header(result, "x-origin"), "kept");
    for (const name of ["x-private", "proxy-authenticate", "keep-alive"]) {
      assert.equal(header(result, name), undefined);
    }
    assert.match(originHeaders, /^POST \/a\/\.\.\/path\?x=1 HTTP\/1\.1/);
    assert.equal(header(originHeaders, "host"), "origin.invalid:8080");
    assert.equal(header(originHeaders, "authorization"), "Bearer origin-token");
    for (const name of [
      "proxy-authorization",
      "x-radar-request-id",
      "x-radar-traceparent",
      "traceparent",
      "tracestate",
      "x-tor-session",
      "x-private",
      "x-second",
      "te",
    ]) {
      assert.equal(header(originHeaders, name), undefined);
    }
  },
);

test(
  "legacy session headers cannot control rotation or add diagnostic headers",
  { timeout: 6_000 },
  async (t) => {
    const routes: Route[] = [];
    const app = await harness(t, async (socket) => {
      routes.push(await handshake(socket));
      await untilClosed(socket);
    });
    for (let i = 0; i < 3; i++) {
      const client = await app.tunnel(
        undefined,
        "X-Tor-Session: 1\r\nX-Radar-Request-Id: old-client\r\n",
      );
      client.end();
      await readToEnd(client);
    }
    assert.notEqual(routes[0]!.username, routes[1]!.username);
    assert.equal(routes[0]!.username, routes[2]!.username);
  },
);

test(
  "target validation refuses traffic before reaching SOCKS",
  { timeout: 6_000 },
  async (t) => {
    let calls = 0;
    const app = await harness(t, async () => {
      calls++;
    });
    for (const target of [
      "origin.invalid",
      "origin.invalid:",
      "origin.invalid:0",
      "origin.invalid:65536",
      "a".repeat(256) + ":443",
      "user@origin.invalid:443",
      "[not-ipv6]:443",
      "::1:443",
      "origin.invalid:443/path",
      "origin.invalid:443?token=1",
      "origin.invalid:443#fragment",
    ]) {
      const client = await app.connect();
      client.write("CONNECT " + target + " HTTP/1.1\r\nHost: test\r\n\r\n");
      assert.match((await readToEnd(client)).toString(), /^HTTP\/1\.1 400 /);
    }
    assert.equal(calls, 0);
  },
);

test(
  "SOCKS refusal returns a standard error without diagnostic metadata",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(t, async (socket) => {
      await handshake(socket, 5);
    });
    const client = await app.connect();
    client.write(
      "CONNECT origin.invalid:443 HTTP/1.1\r\nHost: origin.invalid:443\r\nX-Radar-Request-Id: invalid request id\r\n\r\n",
    );
    const response = await readHeaders(client);
    assert.match(response, /^HTTP\/1\.1 502 /);
    assert.doesNotMatch(response, /x-tor-|x-radar-/i);
    await readToEnd(client);
  },
);

test(
  "SOCKS deadlines return 504 and authentication downgrade is rejected",
  { timeout: 6_000 },
  async (t) => {
    for (const downgrade of [false, true]) {
      const app = await harness(
        t,
        async (socket) => {
          assert.deepEqual(
            await readExactly(socket, 4),
            Buffer.from([5, 2, 0, 2]),
          );
          if (downgrade) {
            socket.write(Buffer.from([5]));
            await delay(5);
            socket.write(Buffer.from([0]));
          }
          await untilClosed(socket);
        },
        { connectTimeoutMs: 100 },
      );
      const client = await app.connect();
      client.write(
        "CONNECT origin.invalid:443 HTTP/1.1\r\nHost: test\r\nX-Radar-Request-Id: test:failure\r\n\r\n",
      );
      const response = await readHeaders(client);
      assert.match(
        response,
        new RegExp("^HTTP/1.1 " + (downgrade ? 502 : 504) + " "),
      );
      await readToEnd(client);
    }
  },
);

test(
  "IPv4 and IPv6 addresses use the corresponding SOCKS wire types",
  { timeout: 6_000 },
  async (t) => {
    const routes: Route[] = [];
    const app = await harness(t, async (socket) => {
      routes.push(await handshake(socket));
      socket.pipe(socket);
      await untilClosed(socket);
    });
    for (const target of [
      "192.0.2.1:443",
      "[2001:db8::1]:443",
      "[::ffff:192.0.2.1]:443",
    ]) {
      const client = await app.tunnel(target);
      client.end();
      await readToEnd(client);
    }
    assert.deepEqual(
      routes.map((route) => route.addressType),
      [1, 4, 4],
    );
    assert.deepEqual(
      routes.map((route) => route.host),
      [
        "c0000201",
        "20010db8000000000000000000000001",
        "00000000000000000000ffffc0000201",
      ],
    );
  },
);

test(
  "plain HTTP upgrades are refused before SOCKS routing",
  { timeout: 6_000 },
  async (t) => {
    let calls = 0;
    const app = await harness(t, async () => {
      calls++;
    });
    const client = await app.connect();
    client.write(
      "GET http://origin.invalid/ HTTP/1.1\r\nHost: origin.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    assert.match((await readToEnd(client)).toString(), /^HTTP\/1\.1 501 /);
    assert.equal(calls, 0);
  },
);

test(
  "plain HTTP pipelining cannot multiply SOCKS work behind one admitted connection",
  { timeout: 6_000 },
  async (t) => {
    let routes = 0;
    const app = await harness(
      t,
      async (socket) => {
        await handshake(socket);
        routes++;
        const headers = await readHeaders(socket);
        assert.match(headers, /^GET \/first HTTP\/1\.1/);
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        );
        await untilClosed(socket);
      },
      { maxConnections: 1 },
    );
    const client = await app.connect();
    client.write(
      "GET http://origin.invalid/first HTTP/1.1\r\nHost: origin.invalid\r\n\r\nGET http://origin.invalid/second HTTP/1.1\r\nHost: origin.invalid\r\n\r\n",
    );
    const response = (await readToEnd(client)).toString();
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.equal(header(response, "connection"), "close");
    assert.equal(routes, 1);
    assert.equal(app.acceptedRoutes(), 1);
  },
);

test(
  "CONNECT after an HTTP request cannot bypass the per-connection limit",
  { timeout: 6_000 },
  async (t) => {
    let routes = 0;
    let routed!: () => void;
    const firstRouted = new Promise<void>((resolve) => {
      routed = resolve;
    });
    const app = await harness(t, async (socket) => {
      await handshake(socket);
      routes++;
      assert.match(await readHeaders(socket), /^GET \/first HTTP\/1\.1/);
      routed();
      await untilClosed(socket);
    });
    const client = await app.connect();
    client.write(
      "GET http://origin.invalid/first HTTP/1.1\r\nHost: origin.invalid\r\n\r\n",
    );
    await firstRouted;
    client.write(
      "CONNECT origin.invalid:443 HTTP/1.1\r\nHost: origin.invalid:443\r\n\r\n",
    );
    await readToEnd(client);
    assert.equal(routes, 1);
    assert.equal(app.acceptedRoutes(), 1);
  },
);

test(
  "Node URL parsing preserves IPv6 CONNECT destinations",
  { timeout: 6_000 },
  async (t) => {
    const app = await harness(t, async (socket) => {
      const route = await handshake(socket);
      assert.equal(route.addressType, 4);
      assert.equal(route.host, "20010db8000000000000000000000001");
      assert.equal(route.port, 443);
      socket.pipe(socket);
      await untilClosed(socket);
    });
    const client = await app.tunnel("[2001:db8::1]:443");
    client.end("payload");
    assert.equal((await readToEnd(client)).toString(), "payload");
  },
);

test(
  "an ordinary HTTP client receives API responses through the proxy without session controls",
  { timeout: 6_000 },
  async (t) => {
    const routes: Route[] = [];
    const app = await harness(t, async (socket) => {
      routes.push(await handshake(socket));
      const headers = await readHeaders(socket);
      assert.match(headers, /^GET \/data\?page=1 HTTP\/1\.1/);
      assert.equal(header(headers, "host"), "api.example.invalid");
      assert.equal(header(headers, "x-tor-session"), undefined);
      const status = routes.length === 1 ? "200 OK" : "429 Too Many Requests";
      socket.end(
        `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: 11\r\nRetry-After: 60\r\nConnection: close\r\n\r\n{"value":1}`,
      );
      await untilClosed(socket);
    });
    for (const status of [200, 429]) {
      const response = await new Promise<import("node:http").IncomingMessage>(
        (resolve, reject) => {
          get(
            {
              host: "127.0.0.1",
              port: app.proxyPort,
              path: "http://api.example.invalid/data?page=1",
              agent: false,
            },
            resolve,
          ).once("error", reject);
        },
      );
      let body = "";
      for await (const chunk of response) {
        body += chunk;
      }
      assert.equal(response.statusCode, status);
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(response.headers["retry-after"], "60");
      assert.deepEqual(JSON.parse(body), { value: 1 });
    }
    assert.equal(routes.length, 2);
    assert.ok(routes.every(({ host }) => host === "api.example.invalid"));
    assert.notEqual(routes[0]!.username, routes[1]!.username);
  },
);
