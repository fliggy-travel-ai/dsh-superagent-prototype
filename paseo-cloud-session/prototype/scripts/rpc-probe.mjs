import { connectToDaemon } from "/opt/node22/lib/node_modules/@getpaseo/cli/dist/utils/client.js";
const [pluginId, method, input = "{}"] = process.argv.slice(2);
const t0 = Date.now();
const client = await connectToDaemon({ target: { kind: "endpoint", host: process.env.PASEO_MINI_HOST } });
const t1 = Date.now();
try {
  const out = await client.invokePluginRpc(pluginId, method, JSON.parse(input));
  console.log(JSON.stringify({ connectMs: t1 - t0, rpcMs: Date.now() - t1, out }, null, 1));
} finally { await client.close?.(); }
process.exit(0);
