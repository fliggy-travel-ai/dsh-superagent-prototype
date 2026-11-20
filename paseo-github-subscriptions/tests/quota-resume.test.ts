import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canResumeAgent, quotaRecovered, findReset, isQuotaError, ResumeService } from "../server/modules/usage-claude-accounts/resume.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
const report = (id = "five_hour", usedPct = 100, resetsAt = "2026-10-30T13:00:00Z") => [{ sourceId: "claude", report: { status: "available", windows: [{ id, usedPct, resetsAt }] } }];
test("only explicit usage-limit messages are recognized", () => {
  assert.equal(isQuotaError("You've hit your session limit · resets 1pm"), true);
  assert.equal(isQuotaError("You've hit your weekly limit"), false);
  assert.equal(isQuotaError("Server is temporarily limiting requests"), false);
});
test("requires one exhausted five-hour window and future reset", () => {
  assert.equal(findReset(report(), now), now + 3600_000);
  assert.equal(findReset(report("seven_day"), now), null);
  assert.equal(findReset(report("five_hour", 99), now), null);
  assert.equal(findReset(report("five_hour", 100, "bad"), now), null);
  assert.equal(findReset(report("five_hour", 100, "2026-10-30T11:00:00Z"), now), null);
  assert.equal(findReset([...report(), ...report()], now), null);
});
test("reports from the extra-accounts source count as Claude reports", () => {
  const extra = report().map(r => ({ ...r, sourceId: "claude-accounts" }));
  assert.equal(findReset(extra, now), now + 3600_000);
  assert.equal(findReset([...report(), ...extra], now), null);
  assert.equal(findReset(report().map(r => ({ ...r, sourceId: "codex" })), now), null);
});

test("a persisted task resumes once after reset and cancels when the session changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-resume-test-"));
  const cli = join(dir, "paseo");
  const realNow = Date.now;
  const oldHome = process.env.PASEO_HOME;
  const oldCli = process.env.PASEO_CLI;
  try {
    process.env.PASEO_HOME = dir;
    process.env.PASEO_CLI = cli;
    Date.now = () => now;
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ Id: "agent-1", Status: "idle", Archived: false, UpdatedAt: "before", PendingPermissions: [] }));
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs');const path=require('path');const dir=process.env.PASEO_HOME;const cmd=process.argv[2];if(cmd==='usage')console.log(JSON.stringify(${JSON.stringify(report())}));else if(cmd==='inspect')console.log(fs.readFileSync(path.join(dir,'snapshot.json'),'utf8'));else if(cmd==='send'){fs.appendFileSync(path.join(dir,'sent'),'sent\\n');console.log('{}')}else if(cmd==='ls')console.log('[]');else process.exit(1);\n`, { mode: 0o755 });
    const first = new ResumeService();
    await first.consider("agent-1", "You've hit your 5-hour limit");
    first.setEnabled("agent-1", true);
    first.stop();
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-quota-resume", "jobs.json"), "utf8")).length, 1);
    Date.now = () => now + 3600_000 + 31_000;
    const resumed = new ResumeService();
    await resumed.start();
    resumed.stop();
    assert.equal(readFileSync(join(dir, "sent"), "utf8"), "sent\n");
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-quota-resume", "jobs.json"), "utf8")).length, 0);

    Date.now = () => now;
    const changed = new ResumeService();
    await changed.start();
    await changed.consider("agent-1", "You've hit your 5-hour limit");
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ Id: "agent-1", Status: "idle", Archived: false, UpdatedAt: "after", PendingPermissions: [] }));
    Date.now = () => now + 3600_000 + 31_000;
    await changed.tick();
    changed.stop();
    assert.equal(readFileSync(join(dir, "sent"), "utf8"), "sent\n");
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-quota-resume", "jobs.json"), "utf8")).length, 0);
    assert.ok(existsSync(join(dir, "sent")));
  } finally {
    Date.now = realNow;
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    if (oldCli === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = oldCli;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-resume is off by default and follows the user's checkbox choice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-resume-test-"));
  const cli = join(dir, "paseo");
  const realNow = Date.now;
  const oldHome = process.env.PASEO_HOME;
  const oldCli = process.env.PASEO_CLI;
  const jobs = () => JSON.parse(readFileSync(join(dir, "claude-quota-resume", "jobs.json"), "utf8"));
  try {
    process.env.PASEO_HOME = dir;
    process.env.PASEO_CLI = cli;
    Date.now = () => now;
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ Id: "agent-1", Status: "idle", Archived: false, UpdatedAt: "before", PendingPermissions: [] }));
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs');const path=require('path');const dir=process.env.PASEO_HOME;const cmd=process.argv[2];if(cmd==='usage')console.log(JSON.stringify(${JSON.stringify(report())}));else if(cmd==='inspect')console.log(fs.readFileSync(path.join(dir,'snapshot.json'),'utf8'));else if(cmd==='send'){fs.appendFileSync(path.join(dir,'sent'),'sent\\n');console.log('{}')}else if(cmd==='ls')console.log('[]');else process.exit(1);\n`, { mode: 0o755 });
    const first = new ResumeService();
    await first.consider("agent-1", "You've hit your 5-hour limit");
    first.stop();
    assert.equal(first.isEnabled("agent-1"), false);
    assert.equal(first.retryAt("agent-1"), now + 3600_000 + 30_000);

    // The default is off: the due time passing sends nothing, and the pending job survives a restart.
    Date.now = () => now + 3600_000 + 31_000;
    const restarted = new ResumeService();
    await restarted.start();
    await restarted.tick();
    assert.equal(restarted.isEnabled("agent-1"), false);
    assert.equal(existsSync(join(dir, "sent")), false);
    assert.equal(jobs().length, 1);

    // Checking the box sends the pending task on the next tick.
    restarted.setEnabled("agent-1", true);
    await restarted.tick();
    assert.equal(readFileSync(join(dir, "sent"), "utf8"), "sent\n");
    assert.equal(jobs().length, 0);

    // A new turn clears the job but not the choice: unchecking keeps the next quota stop off too.
    Date.now = () => now;
    await restarted.consider("agent-1", "You've hit your 5-hour limit");
    restarted.setEnabled("agent-1", false);
    restarted.stop();
    Date.now = () => now + 3600_000 + 31_000;
    const last = new ResumeService();
    await last.start();
    await last.tick();
    assert.equal(last.isEnabled("agent-1"), false);
    assert.equal(readFileSync(join(dir, "sent"), "utf8"), "sent\n");
    assert.equal(jobs().length, 1);

    // Archiving drops the choice so the file does not grow forever.
    last.setEnabled("agent-1", true);
    await last.forget("agent-1");
    last.stop();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "claude-quota-resume", "enabled-agents.json"), "utf8")), []);
  } finally {
    Date.now = realNow;
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    if (oldCli === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = oldCli;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("失败报告中的历史额度不能安排自动继续", () => {
  const history = { sourceId: "claude-accounts", report: { status: "error" }, lastSuccessful: {
    fetchedAt: "2026-10-30T11:59:00Z", report: report()[0].report,
  } };
  assert.equal(findReset([history], now), null);
});

test("已迁移、待审、已归档或已关闭的会话不能自动继续", () => {
  assert.equal(canResumeAgent({ archivedAt: null, status: "error", labels: { role: "main" } }), true);
  assert.equal(canResumeAgent({ archivedAt: null, status: "error", labels: { "dsh.migration-successor": "new-agent" } }), false);
  assert.equal(canResumeAgent({ archivedAt: null, status: "idle", labels: { "dsh.migration-state": "needs_review" } }), false);
  assert.equal(canResumeAgent({ archivedAt: null, status: "idle", labels: { "dsh.migration-state": "cleared:1" } }), true);
  assert.equal(canResumeAgent({ archivedAt: "2026-11-16T10:19:34Z", status: "idle", labels: {} }), false);
  assert.equal(canResumeAgent({ archivedAt: null, status: "closed", labels: {} }), false);
  assert.equal(canResumeAgent(null), false);
});

async function withFakeCli(run: (ctx: { dir: string; sent: () => number; jobs: () => unknown[]; setNow: (value: number) => void }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "quota-resume-migrated-"));
  const cli = join(dir, "paseo");
  const realNow = Date.now;
  const oldHome = process.env.PASEO_HOME;
  const oldCli = process.env.PASEO_CLI;
  try {
    process.env.PASEO_HOME = dir;
    process.env.PASEO_CLI = cli;
    Date.now = () => now;
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ Id: "old", Status: "error", Archived: false, UpdatedAt: "revived", PendingPermissions: [] }));
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs');const path=require('path');const dir=process.env.PASEO_HOME;const cmd=process.argv[2];if(cmd==='usage')console.log(JSON.stringify(${JSON.stringify(report())}));else if(cmd==='inspect')console.log(fs.readFileSync(path.join(dir,'snapshot.json'),'utf8'));else if(cmd==='send'){fs.appendFileSync(path.join(dir,'sent'),'sent\\n');console.log('{}')}else if(cmd==='ls')console.log('[]');else process.exit(1);\n`, { mode: 0o755 });
    await run({
      dir,
      sent: () => existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8").split("\n").filter(Boolean).length : 0,
      jobs: () => existsSync(join(dir, "claude-quota-resume", "jobs.json")) ? JSON.parse(readFileSync(join(dir, "claude-quota-resume", "jobs.json"), "utf8")) : [],
      setNow: value => { Date.now = () => value; },
    });
  } finally {
    Date.now = realNow;
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    if (oldCli === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = oldCli;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("默认自动继续开：已迁移的原会话归档后被重新激活，再报额度也不安排、不发送", async () => {
  await withFakeCli(async ({ sent, jobs, setNow }) => {
    const labels: Record<string, string> = { role: "main", need: "2054", "dsh.migration-successor": "new" };
    const checked: string[] = [];
    const service = new ResumeService({ autoResumeDefault: () => true, canResume: async id => { checked.push(id); return canResumeAgent({ archivedAt: null, status: "error", labels }); } });
    service.setEnabled("old", false);
    await service.forget("old");
    assert.equal(service.isEnabled("old"), true);
    await service.consider("old", "You've hit your 5-hour limit");
    assert.deepEqual(checked, ["old"]);
    assert.equal(service.retryAt("old"), null);
    assert.equal(jobs().length, 0);
    setNow(now + 3600_000 + 31_000);
    await service.tick();
    service.stop();
    assert.equal(sent(), 0);
  });
});

test("持久任务到期时原会话刚被标记迁移：取消任务，不发送", async () => {
  await withFakeCli(async ({ sent, jobs, setNow }) => {
    let labels: Record<string, string> = { role: "main", need: "2054" };
    const canResume = async () => canResumeAgent({ archivedAt: null, status: "error", labels });
    const first = new ResumeService({ autoResumeDefault: () => true, canResume });
    await first.consider("old", "You've hit your 5-hour limit");
    first.stop();
    assert.equal(jobs().length, 1);
    labels = { ...labels, "dsh.migration-successor": "new" };
    setNow(now + 3600_000 + 31_000);
    const restarted = new ResumeService({ autoResumeDefault: () => true, canResume });
    await restarted.start();
    restarted.stop();
    assert.equal(sent(), 0);
    assert.equal(jobs().length, 0);
  });
});

test("迁移待审的会话不发送继续消息", async () => {
  await withFakeCli(async ({ sent, jobs, setNow }) => {
    let labels: Record<string, string> = { role: "main" };
    const service = new ResumeService({ autoResumeDefault: () => true, canResume: async () => canResumeAgent({ archivedAt: null, status: "error", labels }) });
    await service.consider("old", "You've hit your 5-hour limit");
    assert.equal(jobs().length, 1);
    labels = { role: "main", "dsh.migration-state": "needs_review" };
    setNow(now + 3600_000 + 31_000);
    await service.tick();
    service.stop();
    assert.equal(sent(), 0);
    assert.equal(jobs().length, 0);
  });
});

test("读取会话失败时不安排；到期检查读取失败时不发送，保留任务稍后重试", async () => {
  await withFakeCli(async ({ sent, jobs, setNow }) => {
    let fail = true;
    const service = new ResumeService({ autoResumeDefault: () => true, canResume: async () => { if (fail) throw new Error("守护进程未连接"); return true; } });
    await service.consider("old", "You've hit your 5-hour limit");
    assert.equal(jobs().length, 0);
    fail = false;
    await service.consider("old", "You've hit your 5-hour limit");
    assert.equal(jobs().length, 1);
    fail = true;
    setNow(now + 3600_000 + 31_000);
    await service.tick();
    assert.equal(sent(), 0);
    assert.equal(jobs().length, 1);
    fail = false;
    await service.tick();
    service.stop();
    assert.equal(sent(), 1);
    assert.equal(jobs().length, 0);
  });
});

test('缓存未耗尽时等五分钟补查，限流后继续等待；新轮次取消补查', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-delayed-check-'));
  const oldCli = process.env.PASEO_CLI, oldHome = process.env.PASEO_HOME, oldNow = Date.now;
  let clock = now; Date.now = () => clock;
  process.env.PASEO_HOME = dir; process.env.PASEO_CLI = join(dir, 'paseo');
  writeFileSync(join(dir, 'reply'), JSON.stringify(report('five_hour', 99)));
  writeFileSync(join(dir, 'paseo'), `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),d=process.env.PASEO_HOME;
if(process.argv.includes('--refresh'))process.exit(5);
if(process.argv[2]==='usage'){fs.appendFileSync(p.join(d,'calls'),'x');console.log(fs.readFileSync(p.join(d,'reply'),'utf8'));}
else if(process.argv[2]==='inspect') console.log(JSON.stringify({Id:process.argv[3],Status:'idle',UpdatedAt:'before',PendingPermissions:[]}));
else console.log('[]');`, { mode: 0o755 });
  const service = new ResumeService();
  try {
    await service.consider('waiting', "You've hit your 5-hour limit");
    await service.consider('canceled', "You've hit your 5-hour limit");
    await service.cancel('canceled');
    clock += 299999; await service.tick(); assert.equal(readFileSync(join(dir,'calls'),'utf8').length,2);
    clock++; writeFileSync(join(dir, 'reply'), JSON.stringify([{sourceId:'claude',report:{status:'error',error:'429'}}]));
    await service.tick(); assert.equal(service.retryAt('waiting'), null);
    clock += 300000; writeFileSync(join(dir, 'reply'), JSON.stringify(report()));
    await service.tick(); assert.equal(service.retryAt('waiting'), now + 3600_000 + 30_000);
    assert.equal(service.retryAt('canceled'), null);
    assert.equal(readFileSync(join(dir,'calls'),'utf8').length,4);
  } finally {
    service.stop(); Date.now = oldNow;
    if(oldCli===undefined)delete process.env.PASEO_CLI;else process.env.PASEO_CLI=oldCli;
    if(oldHome===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=oldHome;
    rmSync(dir,{recursive:true,force:true});
  }
});


test('查询恢复时额度已重置：仅接受错误之后的新鲜可用报告', () => {
  const available=report('five_hour', 20).map(r=>({...r,fetchedAt:new Date(now+300001).toISOString()}));
  assert.equal(quotaRecovered(available,now),true);
  assert.equal(quotaRecovered(available.map(r=>({...r,fetchedAt:new Date(now+299999).toISOString()})),now),false);
  assert.equal(quotaRecovered(available,now+1),false);
  assert.equal(quotaRecovered(report('five_hour',20),now),false);
  assert.equal(quotaRecovered([...available,...available],now),false);
  assert.equal(quotaRecovered(report().map(r=>({...r,fetchedAt:new Date(now+300001).toISOString()})),now),false);
});
