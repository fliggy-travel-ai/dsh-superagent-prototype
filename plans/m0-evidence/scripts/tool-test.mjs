import { connect, timelineSummary } from "./lib.mjs";
const { client, paseo } = await connect();
for (const [provider, modeId] of [["claude/claude-haiku-5-5", "bypassPermissions"], ["codex/gpt-6-luna", "full-access"]]) {
  const ws = await paseo.workspaces.create({ source: { kind: "directory", path: "/tmp/m0/work" }, title: "M0 tool " + provider });
  const a = await ws.agents.create({ config: { provider, modeId }, title: "M0 tool" });
  const r = await a.run("Call the tool named ghsub_probe_env (an MCP tool from the paseo plugin) and reply with exactly its JSON output on one line. Do not use the shell.", { timeoutMs: 120000 });
  const tl = await timelineSummary(a);
  console.log(provider, "=>", JSON.stringify(r.final?.lastMessage ?? r.lastMessage ?? r).slice(0, 300));
  console.log(tl.filter(x => x.type === "tool_call").map(x => `${x.name}:${x.status}`).join(", "));
  await a.archive().catch(() => {});
}
await client.close();
