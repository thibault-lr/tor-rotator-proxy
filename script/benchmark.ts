import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { startDockerStats } from "./docker-stats.ts";

type IpResult = { ip: string | null; statusCode: number };
const probeScript = fileURLToPath(new URL("./ip-probe.sh", import.meta.url));

// shortcut: process startup affects latency; use a load tool for high-rate measurements.
function probeIp(proxy: string, signal: AbortSignal): Promise<IpResult> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [probeScript, proxy],
      { signal, timeout: 31_000, maxBuffer: 2_048 },
      (error, stdout) => {
        const lines = stdout.trimEnd().split("\n");
        const [httpStatus, connectStatus] = lines.pop()!.split(" ").map(Number);
        const statusCode = httpStatus || connectStatus || 0;
        let ip: string | null = null;
        if (!error && statusCode === 200) {
          try {
            const value = JSON.parse(lines.join("\n"));
            if (
              value.IsTor === true &&
              typeof value.IP === "string" &&
              isIP(value.IP)
            ) {
              ip = value.IP;
            }
          } catch {
            // Invalid responses count as failures, without logging their contents.
          }
        }
        resolve({ ip, statusCode });
      },
    );
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      proxy: { type: "string", default: "http://127.0.0.1:5566" },
      duration: { type: "string", default: "60s" },
      requestsPerSecond: { type: "string", default: "1" },
      containers: { type: "string" },
    },
  });
  const durationMs = /^\d+(?:\.\d+)?s$/.test(values.duration)
    ? Number(values.duration.slice(0, -1)) * 1_000
    : NaN;
  const requestsPerSecond = Number(values.requestsPerSecond);
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0
  ) {
    throw new Error(
      "Use a positive --duration (e.g. 60s) and --requestsPerSecond",
    );
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const stopStats = values.containers
    ? await startDockerStats(values.containers.split(","))
    : undefined;
  let docker: Awaited<ReturnType<NonNullable<typeof stopStats>>> | undefined;
  const results: (IpResult & { latencyMs: number })[] = [];
  const pending = new Set<Promise<void>>();
  const started = performance.now();
  let rateWindowMs = durationMs;
  let elapsedMs = 0;
  let refused = false;
  try {
    for (
      let index = 0;
      index < (durationMs * requestsPerSecond) / 1_000;
      index++
    ) {
      await delay(
        Math.max(
          0,
          started + (index * 1_000) / requestsPerSecond - performance.now(),
        ),
        undefined,
        { signal: controller.signal },
      );
      if (refused || performance.now() - started >= durationMs) {
        break;
      }
      const requestStarted = performance.now();
      const work = probeIp(values.proxy, controller.signal).then((result) => {
        results.push({
          ...result,
          latencyMs: performance.now() - requestStarted,
        });
        refused ||= result.statusCode === 403 || result.statusCode === 429;
        pending.delete(work);
      });
      pending.add(work);
    }
    if (!refused) {
      await delay(
        Math.max(0, started + durationMs - performance.now()),
        undefined,
        { signal: controller.signal },
      );
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    rateWindowMs = performance.now() - started;
    await Promise.all(pending);
    elapsedMs = performance.now() - started;
    docker = await stopStats?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  const successes = results.filter((result) => result.ip !== null);
  const latencies = successes
    .map((result) => result.latencyMs)
    .sort((a, b) => a - b);
  const round = (value: number) => Number(value.toFixed(2));
  const percentile = (p: number) =>
    latencies.length
      ? round(latencies[Math.ceil(latencies.length * p) - 1]!)
      : null;
  console.log(
    JSON.stringify(
      {
        requestedRps: requestsPerSecond,
        sentRps: round((results.length * 1_000) / rateWindowMs),
        completedRps: round((results.length * 1_000) / elapsedMs),
        elapsedSeconds: round(elapsedMs / 1_000),
        sent: results.length,
        succeeded: successes.length,
        failed: results.length - successes.length,
        interrupted: controller.signal.aborted,
        stoppedOnRefusal: refused,
        latencyMs: {
          mean: latencies.length
            ? round(
                latencies.reduce((sum, value) => sum + value, 0) /
                  latencies.length,
              )
            : null,
          p50: percentile(0.5),
          p95: percentile(0.95),
          p99: percentile(0.99),
        },
        distinctIps: new Set(successes.map((result) => result.ip)).size,
        docker,
      },
      null,
      2,
    ),
  );
  process.exitCode = controller.signal.aborted
    ? 130
    : successes.length !== results.length ||
        !results.length ||
        docker?.complete === false
      ? 1
      : 0;
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
