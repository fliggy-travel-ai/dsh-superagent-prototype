import { writeFileSync, existsSync, rmSync } from "node:fs";
import { connect, sleep, waitFor, timelineSummary } from "./lib.mjs";
const [provider, modeId, label] = process.argv.slice(2);
const marker = process.env.MARKER || `/tmp/m0/work/PERM_${label}`; rmSync(marker, { force: true });
const { client, paseo } = await connect();
const ws = await paseo.workspaces.create({ source: { kind: "directory", path: "/tmp/m0/work" }, title: "M0 perm " + label });
const a = await ws.agents.create({ config: { provider, modeId }, title: "M0 perm " + label });
console.log("modes", a.availableModes?.map?.((m) => m.id));
await a.send(process.env.PROMPT || `Use your shell tool to run exactly: touch ${marker}   Then reply with exactly: FILE_DONE`);
const pending = await waitFor(async () => { await a.refresh(); return a.pendingPermissions?.length ? a.pendingPermissions : null; }, "出现待处理权限请求", 90000);
const turnBefore = a.activeTurn?.turnId ?? null;
const permBefore = pending.map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
let sendError = null;
try { await a.send("STEER_PERM: ignore the previous task, just reply with exactly: HELLO_STEER", { activeTurnBehavior: "steer", messageId: "m0-perm-" + label }); } catch (e) { sendError = String(e?.message ?? e); }
await sleep(4000); await a.refresh();
const permAfter = (a.pendingPermissions ?? []).map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
const turnAfter = a.activeTurn?.turnId ?? null;
let finish = null; try { finish = await a.waitForFinish(90000); } catch (e) { finish = { error: String(e?.message ?? e) }; }
await sleep(2000);
const tl = await timelineSummary(a);
const out = { provider, modeId, permBefore, permAfter, turnBefore, turnAfter, sendError, fileCreated: existsSync(marker), finishStatus: finish?.status, finalText: String(finish?.final?.lastMessage ?? finish?.lastMessage ?? "").slice(0, 200), timeline: tl };
writeFileSync(`/tmp/m0/results/steer-perm-${label}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, timeline: undefined }, null, 1)); console.log(tl.map((x) => JSON.stringify(x)).join("\n"));
await a.archive().catch(() => {}); await client.close();
