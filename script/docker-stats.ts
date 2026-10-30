import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const units: Record<string, number> = {
  B: 1,
  kB: 1_000,
  MB: 1_000 ** 2,
  GB: 1_000 ** 3,
  TB: 1_000 ** 4,
  KiB: 1_024,
  MiB: 1_024 ** 2,
  GiB: 1_024 ** 3,
  TiB: 1_024 ** 4,
};

function toMiB(value: string) {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(value.trim());
  const multiplier = match && units[match[2]!];
  if (!match || !multiplier) {
    throw new Error("Unsupported Docker size");
  }
  return (Number(match[1]) * multiplier) / 1_024 ** 2;
}

async function sample(containers: string[], signal?: AbortSignal) {
  const { stdout } = await execute(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", "--", ...containers],
    { signal, timeout: 10_000, maxBuffer: 64 * 1_024 },
  );
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const value = JSON.parse(line);
      const [received, sent] = value.NetIO.split(" / ");
      return {
        name: String(value.Name),
        cpuPercent: Number.parseFloat(value.CPUPerc),
        memoryMiB: toMiB(value.MemUsage.split(" / ")[0]),
        receivedMiB: toMiB(received),
        sentMiB: toMiB(sent),
        pids: Number(value.PIDs),
      };
    });
  if (
    rows.length !== containers.length ||
    rows.some(
      ({ name: _name, ...metrics }) =>
        metrics.pids <= 0 ||
        Object.values(metrics).some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Docker statistics are incomplete");
  }
  return rows;
}

export async function startDockerStats(containers: string[]) {
  const first = await sample(containers).catch(() => {
    throw new Error("Cannot sample the requested Docker containers");
  });
  const started = performance.now();
  const samples = [first];
  const controller = new AbortController();
  let complete = true;
  const recording = (async () => {
    try {
      while (!controller.signal.aborted) {
        samples.push(await sample(containers, controller.signal));
      }
    } catch {
      complete = controller.signal.aborted;
    }
  })();

  return async function stop() {
    controller.abort();
    await recording;
    try {
      samples.push(await sample(containers));
    } catch {
      complete = false;
    }
    const round = (value: number) => Number(value.toFixed(2));
    return {
      complete,
      samples: samples.length,
      sampledSeconds: round((performance.now() - started) / 1_000),
      containers: first.map(({ name }) => {
        const values = samples.map((rows) =>
          rows.find((row) => row.name === name)!,
        );
        const summary = (key: "cpuPercent" | "memoryMiB") => ({
          mean: round(
            values.reduce((sum, row) => sum + row[key], 0) / values.length,
          ),
          peak: round(Math.max(...values.map((row) => row[key]))),
        });
        const last = values.at(-1)!;
        const received = last.receivedMiB - values[0]!.receivedMiB;
        const sent = last.sentMiB - values[0]!.sentMiB;
        return {
          name,
          cpuPercent: summary("cpuPercent"),
          memoryMiB: summary("memoryMiB"),
          networkMiB: {
            received: received < 0 ? null : round(received),
            sent: sent < 0 ? null : round(sent),
          },
          pidsPeak: Math.max(...values.map((row) => row.pids)),
        };
      }),
    };
  };
}
