import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReset, isQuotaError, ResumeService } from "../server/modules/usage-claude-accounts/resume.ts";

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
