import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { probeIp, type IpResult } from "./ip-probe.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

export function readBenchmarkOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      instances: { type: "string", default: "1,2,4" },
      duration: { type: "string", default: "60s" },
      requestsPerSecond: { type: "string", default: "1" },
    },
  });
  const instances = values.instances.split(",").map(Number);
  const durationMs = /^\d+(?:\.\d+)?s$/.test(values.duration)
    ? Number(values.duration.slice(0, -1)) * 1_000
    : NaN;
  const requestsPerSecond = Number(values.requestsPerSecond);
  if (
    !/^\d+(,\d+)*$/.test(values.instances) ||
    instances.some((n) => n < 1 || n > 16) ||
    new Set(instances).size !== instances.length
  ) {
    throw new Error("Use --instances 1,2,4 (unique counts from 1 to 16)");
  }
  if (
    !Number.isFinite(durationMs) ||
    durationMs < 5_000 ||
    durationMs > 3_600_000 ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > 5
  ) {
    throw new Error(
      "Use --duration 5s..3600s and --requestsPerSecond above zero and at most 5",
    );
  }
  return { instances, durationMs, requestsPerSecond };
}

export async function measureProxy(
  proxy: string,
  options: { durationMs: number; requestsPerSecond: number },
  signal: AbortSignal,
) {
  const started_at = new Date().toISOString();
  const started = performance.now();
  const offered = Math.ceil(
    (options.durationMs * options.requestsPerSecond) / 1_000,
  );
  const pending = new Set<Promise<void>>();
  const results: IpResult[] = [];
  const skipped = { saturated: 0, late: 0, refused: 0, cancelled: 0 };
  try {
    for (let index = 0; index < offered; index++) {
      await delay(
        Math.max(
          0,
          started +
            (index * 1_000) / options.requestsPerSecond -
            performance.now(),
        ),
        undefined,
        { signal },
      );
      if (
        results.some(
          ({ status_code }) => status_code === 403 || status_code === 429,
        )
      ) {
        skipped.refused = offered - index;
        break;
      }
      if (performance.now() - started >= options.durationMs) {
        skipped.late = offered - index;
        break;
      }
      if (pending.size >= 8) {
        skipped.saturated++;
        continue;
      }
      const work = probeIp(proxy, signal).then((result) => {
        results.push(result);
        pending.delete(work);
      });
      pending.add(work);
    }
    if (!skipped.refused) {
      await delay(
        Math.max(0, started + options.durationMs - performance.now()),
        undefined,
        { signal },
      );
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    await Promise.all(pending);
  }
  skipped.cancelled = signal.aborted
    ? offered -
      results.length -
      skipped.saturated -
      skipped.late -
      skipped.refused
    : 0;
  const ips = [
    ...new Set(results.flatMap(({ ip }) => (ip === null ? [] : [ip]))),
  ].sort();
  const succeeded = results.filter(({ ip }) => ip !== null).length;
  return {
    started_at,
    ended_at: new Date().toISOString(),
    offered,
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    skipped: Object.values(skipped).reduce((sum, n) => sum + n, 0),
    skipped_reasons: skipped,
    interrupted: signal.aborted,
    distinct_ips: ips.length,
    ips,
    results,
  };
}

export function benchmarkCompose(
  count: number,
  imagePrefix: string,
  directory = root,
) {
  const torNames = Array.from({ length: count }, (_, i) => `tor${i + 1}`);
  const common = {
    restart: "no",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    stop_grace_period: "20s",
  };
  return {
    services: {
      ...Object.fromEntries(
        torNames.map((name) => [
          name,
          {
            ...common,
            image: `${imagePrefix}-tor`,
            build: { context: directory, dockerfile: "deploy/tor.Dockerfile" },
            volumes: ["/var/lib/tor"],
          },
        ]),
      ),
      proxy: {
        ...common,
        image: `${imagePrefix}-proxy`,
        build: { context: directory, dockerfile: "Dockerfile" },
        depends_on: torNames,
        ports: ["127.0.0.1::5566"],
        environment: {
          PROXY_BIND: "0.0.0.0:5566",
          TOR_SOCKS_ADDRS: torNames.map((name) => `${name}:9050`).join(","),
        },
      },
    },
  };
}

type Container = {
  id: string;
  service: string;
  image: string;
  running: boolean;
  oom: boolean;
  restarts: number;
};
type Sample = {
  at: string;
  containers: { id: string; cpu_percent: number; memory_bytes: number }[];
};

export function parseStats(output: string, ids: string[]): Sample {
  const containers = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line);
      const memory =
        /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*\//.exec(
          record.MemUsage,
        );
      const units: Record<string, number> = {
        B: 1,
        kB: 1_000,
        KB: 1_000,
        MB: 1_000_000,
        GB: 1_000_000_000,
        TB: 1_000_000_000_000,
        KiB: 1_024,
        MiB: 1_048_576,
        GiB: 1_073_741_824,
        TiB: 1_099_511_627_776,
      };
      if (
        !memory ||
        !/^\d+(?:\.\d+)?%$/.test(record.CPUPerc) ||
        !ids.includes(record.Container)
      ) {
        throw new Error("Invalid Docker resource sample");
      }
      return {
        id: record.Container as string,
        cpu_percent: Number(record.CPUPerc.slice(0, -1)),
        memory_bytes: Number(memory[1]) * units[memory[2]!]!,
      };
    });
  if (
    containers.length !== ids.length ||
    new Set(containers.map((entry) => entry.id)).size !== ids.length
  ) {
    throw new Error("Incomplete Docker resource sample");
  }
  return { at: new Date().toISOString(), containers };
}

export function summarizeResources(samples: Sample[], ids: string[]) {
  const summary = (values: { cpu_percent: number; memory_bytes: number }[]) =>
    values.length
      ? {
          cpu_sample_mean_percent:
            values.reduce((sum, value) => sum + value.cpu_percent, 0) /
            values.length,
          cpu_sample_peak_percent: Math.max(
            ...values.map((value) => value.cpu_percent),
          ),
          memory_sample_mean_bytes:
            values.reduce((sum, value) => sum + value.memory_bytes, 0) /
            values.length,
          memory_sample_peak_bytes: Math.max(
            ...values.map((value) => value.memory_bytes),
          ),
        }
      : null;
  return {
    sample_count: samples.length,
    total: summary(
      samples.map((sample) =>
        sample.containers.reduce(
          (sum, value) => ({
            cpu_percent: sum.cpu_percent + value.cpu_percent,
            memory_bytes: sum.memory_bytes + value.memory_bytes,
          }),
          { cpu_percent: 0, memory_bytes: 0 },
        ),
      ),
    ),
    containers: ids.map((id) => ({
      id,
      ...summary(
        samples.flatMap((sample) =>
          sample.containers.filter((value) => value.id === id),
        ),
      ),
    })),
    samples,
  };
}

async function docker(args: string[], signal?: AbortSignal, timeout = 30_000) {
  const result = await execute("docker", args, {
    cwd: root,
    signal,
    timeout,
    maxBuffer: 8 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function inspect(ids: string[]): Promise<Container[]> {
  const records = JSON.parse(await docker(["inspect", ...ids]));
  return records.map(
    (record: {
      Id: string;
      Image: string;
      Config: { Labels: Record<string, string> };
      State: { Running: boolean; OOMKilled: boolean };
      RestartCount: number;
    }) => ({
      id: record.Id,
      service: record.Config.Labels["com.docker.compose.service"],
      image: record.Image,
      running: record.State.Running,
      oom: record.State.OOMKilled,
      restarts: record.RestartCount,
    }),
  );
}

function requireRunning(containers: Container[], count: number) {
  const services = new Set(containers.map((container) => container.service));
  if (
    containers.length !== count + 1 ||
    !services.has("proxy") ||
    Array.from({ length: count }, (_, i) => `tor${i + 1}`).some(
      (name) => !services.has(name),
    ) ||
    containers.some(
      (container) =>
        !container.running || container.oom || container.restarts !== 0,
    )
  ) {
    throw new Error(
      "Expected every isolated Tor container and proxy to be running without OOM or restart",
    );
  }
}

async function waitForBootstrap(containers: Container[], signal: AbortSignal) {
  const pending = new Set(
    containers
      .filter((container) => container.service !== "proxy")
      .map((container) => container.id),
  );
  const deadline = performance.now() + 300_000;
  while (pending.size) {
    signal.throwIfAborted();
    for (const id of pending) {
      // A fresh container's own Tor log marks bootstrap, without IP-provider traffic.
      const { stdout, stderr } = await execute(
        "docker",
        ["logs", "--tail", "100", id],
        { signal, timeout: 10_000, maxBuffer: 1_024 * 1_024 },
      );
      if ((stdout + stderr).includes("Bootstrapped 100%")) {
        pending.delete(id);
      }
    }
    if (!pending.size) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error("Tor bootstrap exceeded five minutes");
    }
    requireRunning(
      await inspect(containers.map((container) => container.id)),
      containers.length - 1,
    );
    await delay(2_000, undefined, { signal });
  }
}

async function sampleResources(
  ids: string[],
  samples: Sample[],
  errors: string[],
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const output = await docker(
        [
          "stats",
          "--no-stream",
          "--no-trunc",
          "--format",
          "{{json .}}",
          ...ids,
        ],
        signal,
        10_000,
      );
      if (!signal.aborted) {
        samples.push(parseStats(output, ids));
      }
    } catch {
      if (!signal.aborted) {
        errors.push("Docker resource sample failed or omitted a container");
      }
    }
    try {
      await delay(1_000, undefined, { signal });
    } catch {
      return;
    }
  }
}

type Case = {
  instances: number;
  project: string;
  containers?: Container[];
  load?: Awaited<ReturnType<typeof measureProxy>>;
  resources?: ReturnType<typeof summarizeResources>;
  resource_errors: string[];
  error?: string;
  cleanup_error?: string;
};

export async function runBenchmark(
  options: ReturnType<typeof readBenchmarkOptions>,
  signal: AbortSignal,
) {
  await docker(["info", "--format", "{{.ServerVersion}}"], signal);
  const prefix = `tor-bench-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const directory = resolve(root, ".run", "benchmarks", prefix);
  await mkdir(directory, { recursive: true });
  const cases: Case[] = [];
  const save = () =>
    writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(
        {
          options,
          cases,
          unrun_instances: options.instances.slice(cases.length),
        },
        null,
        2,
      ) + "\n",
    );
  await save();
  for (const count of options.instances) {
    if (signal.aborted) {
      break;
    }
    const result: Case = {
      instances: count,
      project: `${prefix}-${count}`,
      resource_errors: [],
    };
    cases.push(result);
    const file = resolve(directory, `${count}.compose.json`);
    await writeFile(
      file,
      JSON.stringify(benchmarkCompose(count, prefix), null, 2) + "\n",
    );
    const compose = [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      result.project,
      "--file",
      file,
    ];
    const samples: Sample[] = [];
    const sampling = new AbortController();
    let sampler: Promise<void> | undefined;
    let ids: string[] = [];
    try {
      if (cases.length === 1) {
        await docker([...compose, "build", "proxy", "tor1"], signal, 600_000);
      }
      await docker(
        [...compose, "up", "--detach", "--no-build", "--pull", "never"],
        signal,
        120_000,
      );
      ids = (await docker([...compose, "ps", "--all", "--quiet"], signal))
        .split("\n")
        .filter(Boolean);
      if (!ids.length) {
        throw new Error("No benchmark containers were created");
      }
      result.containers = await inspect(ids);
      requireRunning(result.containers, count);
      await waitForBootstrap(result.containers, signal);
      const address = await docker(
        [...compose, "port", "proxy", "5566"],
        signal,
      );
      const work = measureProxy(`http://${address}`, options, signal);
      sampler = sampleResources(
        ids,
        samples,
        result.resource_errors,
        AbortSignal.any([sampling.signal, signal]),
      );
      result.load = await work;
      sampling.abort();
      await sampler;
      if (signal.aborted) {
        throw new Error("Benchmark interrupted");
      }
      result.containers = await inspect(ids);
      requireRunning(result.containers, count);
    } catch (error) {
      result.error = signal.aborted
        ? "Benchmark interrupted"
        : error instanceof Error
          ? error.message.split("\n")[0]
          : "Benchmark failed";
    } finally {
      sampling.abort();
      await sampler;
      // Keep only complete samples received during the measured load window.
      const observed = result.load
        ? samples.filter(
            (sample) =>
              sample.at >= result.load!.started_at &&
              sample.at <= result.load!.ended_at,
          )
        : samples;
      result.resources = summarizeResources(observed, ids);
      try {
        await save();
      } finally {
        // Cleanup must still run if the report cannot be written.
        try {
          await docker(
            [...compose, "down", "--volumes", "--timeout", "20"],
            undefined,
            90_000,
          );
        } catch {
          result.cleanup_error = `Cleanup failed; run docker compose -p ${result.project} -f ${file} down --volumes`;
        }
        await save();
      }
    }
    const usage = result.resources?.total;
    console.table([
      {
        "Tor instances": count,
        "CPU mean %": usage?.cpu_sample_mean_percent.toFixed(2) ?? "unknown",
        "CPU peak %": usage?.cpu_sample_peak_percent.toFixed(2) ?? "unknown",
        "Memory mean MiB": usage
          ? (usage.memory_sample_mean_bytes / 1_048_576).toFixed(2)
          : "unknown",
        "Memory peak MiB": usage
          ? (usage.memory_sample_peak_bytes / 1_048_576).toFixed(2)
          : "unknown",
        "Distinct IPs": result.load?.distinct_ips ?? "unknown",
        Successes: result.load?.succeeded ?? 0,
        Failures: result.load?.failed ?? 0,
        Samples: result.resources?.sample_count ?? 0,
        Error:
          result.error ??
          result.cleanup_error ??
          result.resource_errors.join("; "),
      },
    ]);
    const refused = result.load?.results.some(
      (entry) => entry.status_code === 403 || entry.status_code === 429,
    );
    if (refused || result.error || result.cleanup_error) {
      break;
    }
  }
  console.log(`Results: ${resolve(directory, "results.json")}`);
  return cases.length !== options.instances.length ||
    cases.some(
      (entry) =>
        entry.error ||
        entry.cleanup_error ||
        entry.resource_errors.length ||
        !entry.resources?.sample_count ||
        !entry.load?.succeeded ||
        entry.load.failed ||
        entry.load.skipped,
    )
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await runBenchmark(
      readBenchmarkOptions(process.argv.slice(2)),
      controller.signal,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message.split("\n")[0]
        : "Benchmark failed",
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
