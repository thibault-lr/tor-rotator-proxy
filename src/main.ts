import { once } from "node:events";

import { config } from "./config.ts";
import { createProxy } from "./proxy.ts";

async function main() {
  const { proxyBind } = config;
  const proxy = createProxy();

  try {
    proxy.server.listen(proxyBind.port, proxyBind.host);
    await once(proxy.server, "listening");
    console.log(`Proxy listening on ${proxyBind.host}:${proxyBind.port}`);
    await new Promise<void>((resolve, reject) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      proxy.server.once("error", () =>
        reject(new Error("Proxy server failed")),
      );
    });
  } finally {
    await proxy.stop();
  }
  console.log("Proxy stopped");
}

(async () => {
  await main();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
