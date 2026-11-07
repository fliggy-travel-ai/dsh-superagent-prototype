import { connect } from "./lib.mjs";
const { client, paseo } = await connect();
const ws = await paseo.workspaces.create({ source: { kind: "directory", path: "/tmp/m0/work" }, title: "M0 界面" });
const main = await ws.agents.create({ config: { provider: "notification-fixture/deterministic" }, title: "界面主会话" });
await main.run("普通消息", { timeoutMs: 20000 });
const child = await ws.agents.create({ config: { provider: "notification-fixture/deterministic" }, title: "界面子会话", parent: main });
await child.run("普通消息", { timeoutMs: 20000 });
console.log(JSON.stringify({ ws: ws.id, main: main.id, child: child.id }));
await client.close();
