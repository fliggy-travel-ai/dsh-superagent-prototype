import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect, sleep, waitFor, timelineSummary } from "./lib.mjs";
const [provider, modeId, label, behavior = "steer"] = process.argv.slice(2);
const { client, paseo } = await connect();
const ws = await paseo.workspaces.create({ source: { kind: "directory", path: "/tmp/m0/work" }, title: "M0 steer " + label });
const a = await ws.agents.create({ config: { provider, modeId }, title: "M0 steer " + label });
const turns = new Set(); const statuses = [];
const watch = setInterval(async () => { try { await a.refresh(); const t = a.activeTurn?.turnId ?? null; if (t) turns.add(t); statuses.push(a.status + ":" + (t ? t.slice(0, 6) : "-")); } catch {} }, 1000);
await a.send("Run this exact shell command in the foreground (do not background it) and wait for it: python3 -c 'import time; time.sleep(35); print(123456)'. When it has finished, reply with exactly: BASE_DONE_A");
await waitFor(async () => { const t = await timelineSummary(a); return t.some(x => x.type === "tool_call" && x.status === "running"); }, "shell 开始运行", 90000);
await a.refresh(); const before = a.activeTurn?.turnId ?? null;
const t0 = Date.now();
const mid = "m0-" + randomUUID();
let sendError = null;
try { await a.send("STEER_TEST: after you finish, also append the word STEERED_OK_B to your final reply.", { activeTurnBehavior: behavior, messageId: mid }); } catch (e) { sendError = String(e?.message ?? e); }
const sendMs = Date.now() - t0;
await sleep(2000); await a.refresh(); const afterSend = a.activeTurn?.turnId ?? null;
let finish = null; try { finish = await a.waitForFinish(120000); } catch (e) { finish = { error: String(e?.message ?? e) }; }
await sleep(3000); clearInterval(watch);
const tl = await timelineSummary(a);
const out = { provider, modeId, behavior, turnBeforeSteer: before, turnAfterSteer: afterSend, distinctTurnsSeen: [...turns], sendError, sendMs, finishStatus: finish?.status, finalText: String(finish?.final?.lastMessage ?? finish?.lastMessage ?? "").slice(0, 300), timeline: tl, statusTrace: statuses.join(" ").slice(0, 600) };
writeFileSync(`/tmp/m0/results/steer-busy-${label}-${behavior}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, timeline: undefined, statusTrace: undefined }, null, 1)); console.log(tl.map(x => JSON.stringify(x)).join("\n"));
await a.archive().catch(() => {}); await client.close();
