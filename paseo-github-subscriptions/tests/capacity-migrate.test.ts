import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { migrate, leaseActive, type MigrationPort, type MigrationAgent } from '../server/modules/capacity/migrate.ts';
import { calculate } from '../server/modules/capacity/model.ts';
const now = Date.parse('2026-01-01T02:30:00Z');
const account = (provider: string, five: number) => calculate({ provider, now, agents: [], report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Max 5x', windows: [{ id: 'five_hour', remainingPct: five, resetsAt: '2026-01-01T05:00:00Z' }, { id: 'weekly', remainingPct: 80 }] } } });
function fixture() {
  const agent: MigrationAgent = { id: 'old', cwd: '/work', workspaceId: 'w', provider: 'claude-1', model: 'model', title: null, labels: { role: 'main', need: '1' } };
  const agents = new Map<string, MigrationAgent>([['old', agent], ['child', { ...agent, id: 'child', labels: { 'paseo.parent-agent-id': 'old', 'paseo.parent-server-id': 'server' } }]]);
  const calls: string[] = []; let resume = true;
  const port: MigrationPort = {
    read: async id => agents.get(id) ?? null, update: async (id, labels) => { calls.push(`update:${id}`); Object.assign(agents.get(id)!.labels, labels); },
    journal: { begin: async () => {}, markStarted: async () => {}, saveResume: async () => {}, review: async () => {}, finish: async () => {} }, continueWork: async () => { calls.push('continue'); },
    delay: async () => {}, autoResume: async () => resume, setAutoResume: async (_, value) => { resume = value; calls.push(`resume:${value}`); },
    stop: async (_agent, reason, mark) => { if (reason === 'weekly') mark(); return true; }, create: async (_, provider, mark) => { mark(); calls.push(`create:${provider}`); agents.set('new', { ...agent, id: 'new', labels: { role: 'main', need: '1' } }); return 'new'; },
    finalize: async () => true, verify: async () => 'ok', children: async () => ['child'], serverId: () => 'server',
    archive: async id => { calls.push(`archive:${id}`); }, audit: async () => {}, notify: async event => { calls.push(event); },
  };
  return { agent, port, calls, agents, resume: () => resume };
}
test('影子模式只记录和通知，不写会话', async () => {
  const f = fixture(); assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'shadow', now), 'shadow');
  assert.deepEqual(f.calls, ['main_migration_planned']);
});
test('迁移先改挂子会话，再归档原会话', async () => {
  const f = fixture(); assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'migrated');
  assert.ok(f.calls.indexOf('update:child') < f.calls.indexOf('archive:old')); assert.equal(f.agents.get('child')!.labels['paseo.parent-agent-id'], 'new');
});
test('迁移中每步失败时保留原会话并恢复自动继续', async () => {
  for (const step of ['stop', 'create', 'finalize', 'verify', 'children'] as const) {
    const f = fixture(); (f.port[step] as unknown) = async (...args: unknown[]) => { if (step === 'create') (args[2] as () => void)(); throw Error('failure'); };
    assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), step === 'create' ? 'create_unknown' : 'operation_failed');
    assert.equal(f.calls.includes('archive:old'), false); assert.equal(f.resume(), true); assert.ok(f.calls.includes('lb_exception'));
  }
});
test('锁有效期和点名账号例外', async () => {
  assert.equal(leaseActive(`plugin:${now + 1000}:x`, now), true); assert.equal(leaseActive('released:1', now), false);
  const f = fixture(); f.agent.labels['dsh.lb'] = 'manual'; assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'manual');
  assert.deepEqual(f.calls, ['lb_exception']);
});
test('租约被覆盖时不停止或归档会话', async () => {
  const f = fixture(); f.port.read = async () => ({ ...f.agent, labels: { ...f.agent.labels, 'dsh.migration-lease': 'plugin:1:other' } });
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'lease_conflict');
  assert.equal(f.calls.includes('resume:false'), false); assert.equal(f.calls.includes('archive:old'), false);
});
test('改挂读回失败时恢复子会话和原会话的自动继续', async () => {
  const f = fixture(); const read = f.port.read;
  let reads = 0; f.port.read = async id => id === 'child' && reads++ === 0 ? { ...f.agents.get('child')!, labels: {} } : read(id);
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'child_readback_failed');
  assert.equal(f.agents.get('child')!.labels['paseo.parent-agent-id'], 'old'); assert.equal(f.resume(), true);
  assert.ok(f.calls.includes('archive:new')); assert.equal(f.calls.includes('archive:old'), false);
});
test('限额首条输出可尝试第二个目标', async () => {
  const f = fixture(); let count = 0; f.port.verify = async () => ++count === 1 ? 'quota' : 'ok';
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100), account('claude-3', 100)], 'live', now), 'migrated');
  assert.equal(f.calls.filter(c => c.startsWith('create:')).length, 2); assert.ok(f.calls.includes('archive:new'));
});

test('周额度迁移失败后通知原会话继续工作，保留原自动继续值', async () => {
  const f = fixture(); f.port.create = async (_a, _p, mark) => { mark(); throw Error('failure'); };
  const source = account('claude-1', 50); source.weekly!.remainingPct = 5;
  assert.equal(await migrate(f.port, f.agent, [source, account('claude-2', 100)], 'live', now), 'create_unknown');
  assert.equal(f.resume(), true); assert.ok(f.calls.includes('continue'));
});

test('归档结果未知及回退不完整时保留待审记录和租约', async () => {
  for (const scenario of ['archive_unknown', 'rollback_incomplete'] as const) {
    const f = fixture(); let marked = ''; let finished = false;
    f.port.journal.review = async (_id, reason) => { marked = reason; };
    f.port.journal.finish = async () => { finished = true; };
    if (scenario === 'archive_unknown') {
      const read = f.port.read; let afterArchive = false;
      f.port.archive = async id => { if (id === 'old') { afterArchive = true; throw Error('unknown'); } };
      f.port.read = async id => id === 'old' && afterArchive ? null : read(id);
    } else {
      f.port.children = async () => ['child'];
      f.port.read = async id => id === 'child' ? { ...f.agents.get('child')!, labels: {} } : f.agents.get(id) ?? null;
    }
    assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), scenario);
    assert.equal(marked, scenario); assert.equal(finished, false);
    assert.equal(f.agent.labels['dsh.migration-state'], 'needs_review');
    assert.ok(f.agent.labels['dsh.migration-lease']?.startsWith(scenario === 'archive_unknown' ? 'released:' : 'plugin:'));
    assert.ok(f.calls.includes('lb_exception'));
  }
});
test('关闭自动继续前已持久保存原值，失败时按保存值恢复', async () => {
  const f = fixture(); let saved: boolean | undefined;
  f.port.journal.saveResume = async (_id, value) => { saved = value; };
  const set = f.port.setAutoResume;
  f.port.setAutoResume = async (id, value) => { if (!value) assert.equal(saved, true); await set(id, value); };
  f.port.stop = async () => false;
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'stop_unconfirmed');
  assert.equal(f.resume(), true);
});
test('锁写入后停止：可读回时释放锁，不可读回时保留未开始记录', async () => {
  for (const readable of [true, false]) {
    const f = fixture(); let finished = false; let began = false; let review = false;
    f.port.journal.begin = async () => { began = true; };
    f.port.journal.finish = async () => { finished = true; };
    f.port.journal.review = async () => { review = true; };
    f.port.delay = async () => { throw Error('stopped'); };
    if (!readable) f.port.read = async () => { throw Error('offline'); };
    const outcome = await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now);
    assert.equal(began, true); assert.equal(review, false);
    assert.equal(outcome, readable ? 'stopped' : 'lock_unverified');
    assert.equal(finished, readable);
    assert.ok(f.agent.labels['dsh.migration-lease']?.startsWith(readable ? 'released:' : 'plugin:'));
  }
});
test('创建前失败安全回退；请求发出后的失败保留待审', async () => {
  for (const issued of [false, true]) {
    const f = fixture(); let reviewed = false;
    f.port.journal.review = async () => { reviewed = true; };
    f.port.create = async (_agent, _provider, mark) => { if (issued) mark(); throw Error('source_unavailable'); };
    const outcome = await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now);
    assert.equal(outcome, issued ? 'create_unknown' : 'create_failed'); assert.equal(reviewed, issued);
    assert.equal(f.calls.includes('archive:old'), false); assert.equal(f.resume(), true);
  }
});
test('成功迁移在归档原会话前释放锁', async () => {
  const f = fixture(); const archive = f.port.archive;
  f.port.archive = async id => { if (id === 'old') assert.ok(f.agent.labels['dsh.migration-lease']?.startsWith('released:')); await archive(id); };
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'migrated');
});
test('待审异常包含原自动继续值和失败原因', async () => {
  const f = fixture(); let detail: Record<string, unknown> | undefined;
  f.port.notify = async (event, data) => { if (event === 'lb_exception') detail = data; };
  f.port.create = async (_agent, _provider, mark) => { mark(); throw Error('network'); };
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'create_unknown');
  assert.equal(detail?.reason, 'create_unknown'); assert.equal(detail?.autoResume, true); assert.equal(detail?.trigger, 'five_hour');
});
test('归档前释放锁失败时原会话不归档并转待审', async () => {
  const f = fixture(); const update = f.port.update;
  f.port.update = async (id, labels) => { if (labels['dsh.migration-lease']?.startsWith('released:')) throw Error('offline'); await update(id, labels); };
  let reason = ''; f.port.journal.review = async (_id, value) => { reason = value; };
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'lease_release_failed');
  assert.equal(reason, 'lease_release_failed'); assert.equal(f.calls.includes('archive:old'), false);
});
test('锁确认前失败只发一条异常，并报告最终锁确认结果', async () => {
  for (const readable of [true, false]) {
    const f = fixture(); const notices: Record<string, unknown>[] = [];
    f.port.notify = async (event, data) => { if (event === 'lb_exception') notices.push(data); };
    f.port.delay = async () => { throw Error('stopped'); };
    if (!readable) f.port.read = async () => { throw Error('offline'); };
    const outcome = await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now);
    assert.equal(notices.length, 1); assert.equal(notices[0]?.reason, readable ? 'stopped' : 'lock_unverified');
    assert.equal(outcome, readable ? 'stopped' : 'lock_unverified');
  }
});
test('锁写入前的记录失败也只发一条异常', async () => {
  const f = fixture(); const notices: Record<string, unknown>[] = [];
  f.port.journal.begin = async () => { throw Error('disk'); };
  f.port.notify = async (event, data) => { if (event === 'lb_exception') notices.push(data); };
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'operation_failed');
  assert.equal(notices.length, 1); assert.equal(notices[0]?.reason, 'operation_failed');
  assert.equal(f.agent.labels['dsh.migration-lease'], undefined);
});
test('1808 没有可接账号：不发异常，打开原会话自动继续，等原账号额度恢复', async () => {
  const f = fixture(); let resume = false; const audits: Record<string, unknown>[] = [];
  f.port.autoResume = async () => resume; f.port.setAutoResume = async (_, value) => { resume = value; f.calls.push(`resume:${value}`); };
  f.port.audit = async entry => { audits.push(entry); };
  assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 10)], 'live', now), 'no_target');
  assert.deepEqual(f.calls, ['resume:true']); assert.equal(resume, true);
  assert.equal(audits[0]!.action, 'wait_for_reset'); assert.equal(audits[0]!.autoResume, true);
  const shadow = fixture(); assert.equal(await migrate(shadow.port, shadow.agent, [account('claude-1', 0)], 'shadow', now), 'no_target');
  assert.deepEqual(shadow.calls, [], '影子模式不改会话、不发异常');
});
test('1808 新会话在归档原会话前已出错：不归档原会话，回滚并发异常', async () => {
  const f = fixture();
  const create = f.port.create;
  f.port.create = async (a, p, mark) => { const id = await create(a, p, mark); f.agents.get(id)!.status = 'error'; return id; };
  const result = await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now);
  assert.equal(result, 'operation_failed');
  assert.equal(f.calls.includes('archive:old'), false); assert.ok(f.calls.includes('archive:new')); assert.ok(f.calls.includes('lb_exception')); assert.equal(f.resume(), true);
  assert.equal(f.agents.get('child')!.labels['paseo.parent-agent-id'], 'old', '子会话改挂已回滚');
});
