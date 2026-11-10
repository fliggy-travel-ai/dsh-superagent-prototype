import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationJournal } from '../server/modules/capacity/journal.ts';
import { recoverMigrations, pruneCooldown } from '../server/modules/capacity/recovery.ts';
import { classifyOutput } from '../server/modules/capacity/daemon-migration.ts';
import { triggerReason } from '../server/modules/capacity/migrate.ts';
import { calculate } from '../server/modules/capacity/model.ts';

test('重启恢复进行中记录与未释放锁，并保留自动继续原值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-test-'));
  try {
    const path = join(dir, 'state.json'); const first = new MigrationJournal(path);
    await first.begin('old'); await first.saveResume('old', true);
    const journal = new MigrationJournal(path); await journal.load();
    const updates: string[] = []; const notices: string[] = [];
    const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    const stale = { ...agent, id: 'stale', labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    await recoverMigrations(journal, [agent, stale], async id => { updates.push(id); }, async (_, data) => { notices.push(String(data.oldAgentId)); }, true);
    assert.deepEqual(updates.sort(), ['old', 'stale']); assert.deepEqual(notices.sort(), ['old', 'stale']);
    const reopened = new MigrationJournal(path); await reopened.load();
    assert.equal(reopened.get('old')?.state, 'needs_review'); assert.equal(reopened.get('old')?.autoResume, true);
    assert.equal(reopened.get('stale')?.state, 'needs_review'); await assert.rejects(reopened.begin('old'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('助手正文不按限额关键词判错', () => {
  assert.equal(classifyOutput([{ type: 'assistant_message', text: '正在检查额度和付款配置' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'error', message: 'usage limit reached' }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: 'usage_limit_reached' }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: '调查 usage_limit_reached 的原因' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'notification', message: '需要付款' }]), 'quota');
});
test('过期重置时间不触发五小时迁移，周额度仍独立触发', () => {
  const now = Date.parse('2026-01-01T02:30:00Z');
  const input = { provider: 'claude-1', agents: [], now, report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Pro ai', windows: [{ id: 'five_hour', remainingPct: 0, resetsAt: '2026-01-01T02:29:00Z' }, { id: 'weekly', remainingPct: 50 }] } } };
  assert.equal(triggerReason(calculate(input), now), null);
  input.report.report.windows[1]!.remainingPct = 5; assert.equal(triggerReason(calculate(input), now), 'weekly');
  input.report.report.windows[1]!.remainingPct = 50; input.report.report.windows[0]!.resetsAt = '2026-01-01T03:00:00Z';
  assert.equal(triggerReason(calculate(input), now), 'five_hour');
});
test('清理已过期的冷却记录', () => {
  assert.deepEqual(pruneCooldown({ expired: 1, active: 100_000 }, 1_800_050), { active: 100_000 });
});
test('新会话沿用原会话当前模式，无模式时才用默认模式', async () => {
  const { daemonMigrationPort } = await import('../server/modules/capacity/daemon-migration.ts');
  const modes: string[] = [];
  let mode: string | null = 'plan';
  const original = { id: 'old', provider: 'claude-1', cwd: '/work', workspaceId: 'w', model: 'model', title: null, currentModeId: mode, labels: { role: 'main', need: '1' }, pendingPermissions: [] };
  const client = {
    fetchAgent: async () => ({ agent: { ...original, currentModeId: mode } }),
    fetchAgentTimeline: async () => ({ entries: [{ item: { type: 'user_message', text: '继续任务' } }] }),
    cancelAgent: async () => {},
    createAgent: async (input: { modeId: string }) => { modes.push(input.modeId); return { id: 'new' }; },
  };
  const journal = { begin: async () => {}, saveResume: async () => {}, review: async () => {}, finish: async () => {} };
  const port = daemonMigrationPort(client as never, undefined, async () => {}, async () => {}, new AbortController().signal, journal);
  await port.stop(original, 'five_hour', () => {});
  await port.create(original, 'claude-2'); mode = null;
  await port.create(original, 'claude-2');
  assert.deepEqual(modes, ['plan', 'bypassPermissions']);
});
test('周额度回退发送继续工作消息', async () => {
  const { daemonMigrationPort } = await import('../server/modules/capacity/daemon-migration.ts');
  const messages: string[] = [];
  const client = { sendAgentMessage: async (_id: string, message: string) => { messages.push(message); } };
  const journal = { begin: async () => {}, saveResume: async () => {}, review: async () => {}, finish: async () => {} };
  const port = daemonMigrationPort(client as never, undefined, async () => {}, async () => {}, new AbortController().signal, journal);
  await port.continueWork('old'); assert.deepEqual(messages, ['迁移已取消，请继续原工作。']);
});
