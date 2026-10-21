import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { probeIp, type IpResult } from "./ip-probe.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      proxy: { type: "string", default: "http://127.0.0.1:5566" },
      duration: { type: "string", default: "60s" },
      requestsPerSecond: { type: "string", default: "1" },
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
  const results: (IpResult & { latencyMs: number })[] = [];
  const pending = new Set<Promise<void>>();
  const started = performance.now();
  let rateWindowMs = durationMs;
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
        refused ||= result.status_code === 403 || result.status_code === 429;
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
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  const elapsedMs = performance.now() - started;
  const successes = results.filter((result) => result.error === null);
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
      },
      null,
      2,
    ),
  );
  process.exitCode = controller.signal.aborted
    ? 130
    : successes.length !== results.length || !results.length
      ? 1
      : 0;
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
