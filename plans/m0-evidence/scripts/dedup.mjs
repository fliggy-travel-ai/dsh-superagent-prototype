import { writeFileSync, readFileSync } from "node:fs";
import { connect, sleep, waitFor, timelineSummary } from "./lib.mjs";
const phase = process.argv[2];
const { client, paseo } = await connect();
const log = []; const note = (k, v) => { log.push({ k, v }); console.log(k, JSON.stringify(v)); };
const count = async (a, needle) => (await timelineSummary(a)).filter((x) => x.type === "user_message" && x.text.includes(needle)).length;
if (phase === "A") {
  const ws = await paseo.workspaces.create({ source: { kind: "directory", path: "/tmp/m0/work" }, title: "M0 dedup" });
  const a = await ws.agents.create({ config: { provider: "claude/claude-haiku-5-5", modeId: "bypassPermissions" }, title: "M0 dedup" });
  writeFileSync("/tmp/m0/results/dedup-agent.json", JSON.stringify({ id: a.id }));
  const M = "m0-dedup-fixed-id";
  await a.send("Reply with exactly: PONG_1", { activeTurnBehavior: "steer", messageId: M });
  await a.waitForFinish(60000); note("首次发送后用户消息数", await count(a, "PONG_1"));
  let e1 = null; try { await a.send("Reply with exactly: PONG_1", { activeTurnBehavior: "steer", messageId: M }); } catch (e) { e1 = String(e?.message ?? e); }
  await sleep(4000); note("相同 messageId 相同内容再发：报错", e1); note("再发后用户消息数", await count(a, "PONG_1"));
  let e2 = null; try { await a.send("Reply with exactly: PONG_CHANGED", { activeTurnBehavior: "steer", messageId: M }); } catch (e) { e2 = String(e?.message ?? e); }
  await sleep(2000); note("相同 messageId 不同内容：报错", e2); note("PONG_CHANGED 用户消息数", await count(a, "PONG_CHANGED"));
  let e3 = null; try { await a.send("Reply with exactly: PONG_1", { activeTurnBehavior: "interrupt", messageId: M }); } catch (e) { e3 = String(e?.message ?? e); }
  note("相同 messageId 相同内容不同 activeTurnBehavior：报错", e3);
  // 空闲会话 steer（无 messageId）是否开始新回合
  const t = await timelineSummary(a); note("空闲会话 steer 后 assistant 回复", t.filter(x => x.type === "assistant_message").map(x => x.text));
}
if (phase === "B") {
  const { id } = JSON.parse(readFileSync("/tmp/m0/results/dedup-agent.json", "utf8"));
  const a = paseo.agents.ref(id); const snap = await a.refresh();
  note("守护进程重启后会话状态", { status: a.status, archivedAt: a.archivedAt ?? null });
  let e1 = null; try { await a.send("Reply with exactly: PONG_1", { activeTurnBehavior: "steer", messageId: "m0-dedup-fixed-id" }); } catch (e) { e1 = String(e?.message ?? e); }
  await sleep(3000); note("重启后相同 messageId 相同内容：报错", e1); note("PONG_1 用户消息数", await count(a, "PONG_1"));
  let e2 = null; try { await a.send("Reply with exactly: PONG_2", { activeTurnBehavior: "steer", messageId: "m0-after-restart" }); } catch (e) { e2 = String(e?.message ?? e); }
  note("向已关闭（未归档）会话 send：报错", e2);
  const fin = await a.waitForFinish(90000).catch((e) => ({ error: String(e?.message ?? e) })); await a.refresh();
  note("send 后状态", { status: a.status, finish: fin?.status ?? fin?.error, text: String(fin?.final?.lastMessage ?? fin?.lastMessage ?? "").slice(0, 80) });
  note("PONG_2 用户消息数", await count(a, "PONG_2"));
  await a.archive().catch(() => {});
}
writeFileSync(`/tmp/m0/results/dedup-${phase}.json`, JSON.stringify(log, null, 1));
await client.close();
