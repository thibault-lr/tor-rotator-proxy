import type { Config } from "./types.ts";

const mapToEndpoint = (endpoint: string) => {
  const url = new URL(`tcp://${endpoint}`);

  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port),
  };
};

const proxyBind = mapToEndpoint(process.env.PROXY_BIND ?? "127.0.0.1:5566");
const torEndpoints = (process.env.TOR_SOCKS_ADDRS ?? "127.0.0.1:9050")
  .split(",")
  .map(mapToEndpoint);

export const config = {
  proxyBind,
  torEndpoints,
  sessionCount: 16 * torEndpoints.length,
  sessionTtlMs: 300_000,
  maxConnections: 256,
  connectTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  maxStreamMs: 600_000,
  headerTimeoutMs: 10_000,
  shutdownGraceMs: 10_000,
} satisfies Config;
