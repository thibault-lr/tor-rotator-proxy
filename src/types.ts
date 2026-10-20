export type Target = { host: string; port: number };

export type Config = {
  proxyBind: Target;
  torEndpoints: Target[];
  sessionCount: number;
  sessionTtlMs: number;
  maxConnections: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxStreamMs: number;
  headerTimeoutMs: number;
  shutdownGraceMs: number;
};
