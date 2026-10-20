import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  benchmarkCompose,
  parseStats,
  readBenchmarkOptions,
  runBenchmark,
  measureProxy,
  summarizeResources,
} from "../script/benchmark.ts";
import { loadConfig } from "./helpers.ts";

const stats = (id: string, cpu: string, memory: string) =>
  JSON.stringify({ Container: id, CPUPerc: cpu, MemUsage: `${memory} / 8GiB` });

test("resource totals use simultaneous samples and preserve missing measurements", () => {
  const first = parseStats(
    [stats("a", "150.00%", "10MiB"), stats("b", "25.00%", "2GiB")].join("\n"),
    ["a", "b"],
  );
  const second = parseStats(
    [stats("a", "50.00%", "1GiB"), stats("b", "0.00%", "100kB")].join("\n"),
    ["a", "b"],
  );
  const report = summarizeResources([first, second], ["a", "b"]);
  assert.equal(report.total?.cpu_sample_mean_percent, 112.5);
  assert.equal(report.total?.cpu_sample_peak_percent, 175);
  assert.equal(
    report.total?.memory_sample_peak_bytes,
    10 * 1_048_576 + 2 * 1_073_741_824,
  );
  assert.equal(report.containers[0]?.cpu_sample_mean_percent, 100);
  assert.equal(summarizeResources([], ["a"]).total, null);
  for (const output of [
    "",
    stats("a", "0%", "1MiB"),
    [stats("a", "0%", "1MiB"), stats("a", "0%", "1MiB")].join("\n"),
    stats("foreign", "0%", "1MiB"),
    stats("a", "NaN%", "1MiB"),
    stats("a", "1%", "unknown"),
  ]) {
    assert.throws(() => parseStats(output, ["a", "b"]));
  }
});

test("benchmark plans count real Tor containers with separate state and no admin service", () => {
  assert.deepEqual(readBenchmarkOptions([]).instances, [1, 2, 4]);
  for (const value of ["", "0", "17", "1,1", "1.5", "1,2,", "1;echo"]) {
    assert.throws(() => readBenchmarkOptions(["--instances", value]));
  }
  assert.throws(() => readBenchmarkOptions(["--duration", "1s"]));
  assert.throws(() => readBenchmarkOptions(["--requestsPerSecond", "6"]));
  const config = benchmarkCompose(3, "isolated", "/fixture");
  assert.equal(Object.keys(config.services).length, 4);
  assert.deepEqual(config.services.proxy.ports, ["127.0.0.1::5566"]);
  assert.equal(loadConfig(config.services.proxy.environment).sessionCount, 48);
  assert.equal(
    config.services.proxy.environment.TOR_SOCKS_ADDRS,
    "tor1:9050,tor2:9050,tor3:9050",
  );
  assert.ok(!JSON.stringify(config).includes("4444"));
});

test("interruption preserves attempted probes and counts unsent requests", async (t) => {
  const server = createServer();
  let began!: () => void;
  const connected = new Promise<void>((resolve) => {
    began = resolve;
  });
  server.on("connect", (_request, socket) => {
    socket.on("error", () => {});
    socket.resume();
    socket.on("end", () => socket.end());
    began();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const stop = new AbortController();
  const work = measureProxy(
    `http://127.0.0.1:${address.port}`,
    { durationMs: 10_000, requestsPerSecond: 1 },
    stop.signal,
  );
  await connected;
  stop.abort();
  const report = await work;
  assert.equal(report.interrupted, true);
  assert.equal(report.offered, 10);
  assert.equal(report.attempted, 1);
  assert.equal(report.skipped_reasons.cancelled, 9);
  assert.equal(report.results[0]?.error, "cancelled");
});

test(
  "matrix uses only its own Docker project and cleans it after refusal or missing containers",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tor-fake-docker-"));
    const log = join(directory, "calls.jsonl");
    const server = createServer();
    server.on("connect", (_request, socket) => {
      socket.on("error", () => {});
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      socket.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath}`;
    t.after(async () => {
      process.env.PATH = originalPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    for (const missing of [false, true]) {
      await writeFile(log, "");
      await writeFile(
        join(directory, "docker"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const ids = ["a".repeat(64), "b".repeat(64)];
if (args[0] === "info") {
  console.log("test-engine");
}
else if (args[0] === "logs") {
  console.log("Bootstrapped 100% (done)");
}
else if (args[0] === "inspect") {
  console.log(JSON.stringify(ids.slice(0, ${missing ? 1 : 2}).map((Id, i) => ({ Id, Image: "test-image", Config: { Labels: { "com.docker.compose.service": i ? "proxy" : "tor1" } }, State: { Running: true, OOMKilled: false }, RestartCount: 0 }))));
}
else if (args[0] === "stats") {
  ids.forEach((Container) => console.log(JSON.stringify({ Container, CPUPerc: "10.00%", MemUsage: "20MiB / 1GiB" })));
}
else if (args.includes("ps")) {
  console.log(ids.join("\\n"));
}
else if (args.includes("port")) {
  console.log("127.0.0.1:${address.port}");
}
`,
        { mode: 0o755 },
      );
      assert.equal(
        await runBenchmark(
          readBenchmarkOptions(["--instances", "1,2", "--duration", "5s"]),
          new AbortController().signal,
        ),
        1,
      );
      const calls: string[][] = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const composeCalls = calls.filter((call) => call[0] === "compose");
      const projects = new Set(
        composeCalls.map((call) => call[call.indexOf("--project-name") + 1]),
      );
      assert.equal(projects.size, 1);
      assert.match([...projects][0]!, /^tor-bench-.*-1$/);
      assert.equal(
        composeCalls.filter(
          (call) => call.includes("down") && call.includes("--volumes"),
        ).length,
        1,
      );
      const file = composeCalls[0]![composeCalls[0]!.indexOf("--file") + 1]!;
      const report = JSON.parse(
        await readFile(join(dirname(file), "results.json"), "utf8"),
      );
      assert.deepEqual(report.unrun_instances, [2]);
      assert.equal(report.cases.length, 1);
      if (missing) {
        assert.match(report.cases[0].error, /Expected every isolated/);
      } else {
        assert.equal(report.cases[0].load.attempted, 1);
        assert.equal(report.cases[0].load.skipped_reasons.refused, 4);
        assert.equal(report.cases[0].load.distinct_ips, 0);
        assert.equal(
          report.cases[0].resources.total.cpu_sample_mean_percent,
          20,
        );
        assert.equal(
          report.cases[0].resources.total.memory_sample_peak_bytes,
          40 * 1_048_576,
        );
      }
      await rm(dirname(file), { recursive: true });
    }
  },
);
