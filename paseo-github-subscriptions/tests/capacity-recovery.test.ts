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
    await first.begin('old', 'plugin:1:nonce', 'five_hour'); await first.saveResume('old', true); await first.markStarted('old');
    const journal = new MigrationJournal(path); await journal.load();
    const updates: string[] = []; const notices: string[] = [];
    const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    const stale = { ...agent, id: 'stale', labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    await recoverMigrations(journal, [agent, stale], async id => { updates.push(id); }, async (_, data) => { notices.push(String(data.oldAgentId)); }, true, async id => id === 'old' ? agent : stale);
    assert.deepEqual(updates.sort(), ['old', 'stale']); assert.deepEqual(notices.sort(), ['old', 'stale']);
    const reopened = new MigrationJournal(path); await reopened.load();
    assert.equal(reopened.get('old')?.state, 'needs_review'); assert.equal(reopened.get('old')?.autoResume, true);
    assert.equal(reopened.get('stale')?.state, 'needs_review'); await assert.rejects(reopened.begin('old', 'lease', 'five_hour'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('助手正文不按限额关键词判错', () => {
  assert.equal(classifyOutput([{ type: 'assistant_message', text: '正在检查额度和付款配置' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'error', message: 'usage limit reached' }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: 'usage_limit_reached' }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: '调查 usage_limit_reached 的原因。'.repeat(25) }]), 'ok');
  assert.equal(classifyOutput([{ type: 'notification', message: '需要付款' }]), 'quota');
  // 1808：新会话先读需求单、查日志，只有工具调用没有正文，也算正常开工。
  assert.equal(classifyOutput([{ type: 'user_message', text: '请接续原会话的工作' }, { type: 'tool_call' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'reasoning', text: '先读需求单' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'todo' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'tool_call' }, { type: 'error', message: 'usage limit reached' }]), 'quota', '额度报错优先于工具调用');
  assert.equal(classifyOutput([{ type: 'user_message', text: '请接续' }]), 'unknown');
  assert.equal(classifyOutput([{ type: 'user_message', text: '请接续' }, { type: 'error', message: 'Claude Code process exited with code 77' }, { type: 'assistant_message', text: '独立用户仅支持专用工作目录' }]), 'unknown', '启动报错不能算正常');
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
  const journal = { begin: async () => {}, markStarted: async () => {}, saveResume: async () => {}, review: async () => {}, finish: async () => {} };
  const port = daemonMigrationPort(client as never, undefined, async () => {}, async () => {}, new AbortController().signal, journal);
  await port.stop(original, 'five_hour', () => {});
  await port.create(original, 'claude-2', () => {}); mode = null;
  await port.create(original, 'claude-2', () => {});
  assert.deepEqual(modes, ['plan', 'bypassPermissions']);
});
test('周额度回退发送继续工作消息', async () => {
  const { daemonMigrationPort } = await import('../server/modules/capacity/daemon-migration.ts');
  const messages: string[] = [];
  const client = { sendAgentMessage: async (_id: string, message: string) => { messages.push(message); } };
  const journal = { begin: async () => {}, markStarted: async () => {}, saveResume: async () => {}, review: async () => {}, finish: async () => {} };
  const port = daemonMigrationPort(client as never, undefined, async () => {}, async () => {}, new AbortController().signal, journal);
  await port.continueWork('old'); assert.deepEqual(messages, ['迁移已取消，请继续原工作。']);
});
test('真实限额及付款提示可识别，长篇普通正文不误判', () => {
  assert.equal(classifyOutput([{ type: 'assistant_message', text: "You've hit your limit · resets 3pm (Asia/Shanghai)" }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: 'Payment required. Please update billing.' }]), 'quota');
  assert.equal(classifyOutput([{ type: 'assistant_message', text: '正常工作内容。'.repeat(40) + '需要付款' }]), 'ok');
  assert.equal(classifyOutput([{ type: 'notification', message: 'Payment required' }]), 'quota');
});
test('未开始记录恢复只释放自己的锁，已归档会话不写标签', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-lock-'));
  try {
    const journal = new MigrationJournal(join(dir, 'state.json'));
    await journal.begin('old', 'plugin:1:nonce', 'five_hour');
    const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    const archived = { ...agent, id: 'archived', archivedAt: 'now', labels: { 'dsh.migration-lease': 'plugin:1:archived' } };
    await journal.review('archived', 'archive_unknown');
    const updates: string[] = []; const notices: any[] = [];
    await recoverMigrations(journal, [agent, archived], async (id, labels) => { updates.push(id); Object.assign(agent.labels, labels); }, async (_event, data) => { notices.push(data); }, true, async id => id === 'old' ? agent : archived);
    assert.deepEqual(updates, ['old']); assert.ok(agent.labels['dsh.migration-lease'].startsWith('released:'));
    assert.equal(journal.get('old'), undefined); assert.equal(journal.get('archived')?.state, 'needs_review');
    assert.equal(notices[0].autoResume, null); assert.equal(notices[0].reason, 'archive_unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('解除待审读回标签并删除记录，失败时保留待审', async () => {
  const { clearReview } = await import('../server/modules/capacity/recovery.ts');
  const dir = await mkdtemp(join(tmpdir(), 'migration-clear-'));
  try {
    const journal = new MigrationJournal(join(dir, 'state.json'));
    await journal.begin('old', 'plugin:1:nonce', 'weekly'); await journal.saveResume('old', false); await journal.review('old', 'rollback_incomplete');
    const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-state': 'needs_review', 'dsh.migration-lease': 'plugin:1:nonce' } };
    await assert.rejects(clearReview(journal, 'old', async () => agent, async () => {}), /读回失败/);
    assert.equal(journal.get('old')?.state, 'needs_review');
    const result = await clearReview(journal, 'old', async () => agent, async (_id, labels) => { Object.assign(agent.labels, labels); });
    assert.deepEqual(result, { ok: true, autoResume: false }); assert.equal(journal.get('old'), undefined);
    assert.ok(agent.labels['dsh.migration-state'].startsWith('cleared:')); assert.ok(agent.labels['dsh.migration-lease'].startsWith('released:'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('锁写入后读回失败：重启按未开始恢复，不标待审', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-preflight-'));
  try {
    const journal = new MigrationJournal(join(dir, 'state.json'));
    await journal.begin('old', 'plugin:1:nonce', 'weekly');
    const restarted = new MigrationJournal(join(dir, 'state.json')); await restarted.load();
    const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-lease': 'plugin:1:nonce' } };
    let notices = 0;
    await recoverMigrations(restarted, [agent], async (_id, labels) => { Object.assign(agent.labels, labels); }, async () => { notices++; }, true, async () => agent);
    assert.equal(restarted.get('old'), undefined); assert.equal(notices, 0);
    assert.ok(agent.labels['dsh.migration-lease'].startsWith('released:')); assert.equal('dsh.migration-state' in agent.labels, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('识别供应商用量、升级和余额提示，不误判迁移复述', () => {
  const prompts = [
    "You've hit your weekly limit · resets Mon 3pm",
    "You've hit your Opus limit",
    '/upgrade to increase your usage limit',
    'Credit balance is too low',
  ];
  for (const text of prompts) {
    for (const type of ['assistant_message', 'error', 'notification']) {
      const item = type === 'assistant_message' ? { type, text } : { type, message: text };
      assert.equal(classifyOutput([item]), 'quota', `${type}: ${text}`);
    }
  }
  for (const type of ['error', 'notification']) {
    assert.equal(classifyOutput([{ type, message: '原会话因额度耗尽迁到本会话' }]), 'unknown');
  }
  for (const text of ['原会话因额度耗尽迁到本会话', '上一个会话额度不足，现在接续工作', '该需求需要升级组件', '正常工作内容。'.repeat(40) + "You've hit your weekly limit"]) {
    assert.equal(classifyOutput([{ type: 'assistant_message', text }]), 'ok', text);
  }
});
test('加锁中会话已删除时删除未开始记录，不影响其他待审记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-deleted-'));
  try {
    const journal = new MigrationJournal(join(dir, 'state.json'));
    await journal.begin('deleted', 'plugin:1:nonce', 'weekly');
    await journal.review('review', 'archive_unknown');
    const notices: string[] = [];
    await recoverMigrations(journal, [], async () => { throw Error('不应写标签'); }, async (_event, data) => { notices.push(String(data.oldAgentId)); }, true, async () => null);
    assert.equal(journal.get('deleted'), undefined); assert.equal(journal.get('review')?.state, 'needs_review'); assert.deepEqual(notices, ['review']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
