import { connect, sleep } from "./lib.mjs";
const { client } = await connect();
const first = await client.invokePluginRpc("ghsub-probe", "probe.env", {});
console.log("第一次", JSON.stringify(first));
await sleep(3000);
const second = await client.invokePluginRpc("ghsub-probe", "probe.env", {});
console.log("第二次", JSON.stringify(second));
await client.close();
