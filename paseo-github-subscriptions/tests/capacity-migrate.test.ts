import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { migrate, leaseActive, type MigrationPort, type MigrationAgent } from '../server/modules/capacity/migrate.ts';
import { calculate } from '../server/modules/capacity/model.ts';
const now = Date.parse('2026-01-01T02:30:00Z');
const account = (provider: string, five: number) => calculate({ provider, now, agents: [], report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Max 5x', windows: [{ id: 'five_hour', remainingPct: five, resetsAt: null }, { id: 'weekly', remainingPct: 80 }] } } });
function fixture() {
  const agent: MigrationAgent = { id: 'old', cwd: '/work', workspaceId: 'w', provider: 'claude-1', model: 'model', title: null, labels: { role: 'main', need: '1' } };
  const agents = new Map<string, MigrationAgent>([['old', agent], ['child', { ...agent, id: 'child', labels: { 'paseo.parent-agent-id': 'old', 'paseo.parent-server-id': 'server' } }]]);
  const calls: string[] = []; let resume = true;
  const port: MigrationPort = {
    read: async id => agents.get(id) ?? null, update: async (id, labels) => { calls.push(`update:${id}`); Object.assign(agents.get(id)!.labels, labels); },
    delay: async () => {}, autoResume: async () => resume, setAutoResume: async (_, value) => { resume = value; calls.push(`resume:${value}`); },
    stop: async () => true, create: async (_, provider) => { calls.push(`create:${provider}`); agents.set('new', { ...agent, id: 'new', labels: { role: 'main', need: '1' } }); return 'new'; },
    finalize: async () => true, verify: async () => 'ok', children: async () => ['child'], serverId: () => 'server',
    archive: async id => { calls.push(`archive:${id}`); }, audit: async () => {}, notify: async event => { calls.push(event); },
  };
  return { agent, port, calls, agents, resume: () => resume };
}
test('影子模式只记录和通知，不写会话', async () => {
  const f = fixture(); assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'shadow', now), 'shadow');
  assert.deepEqual(f.calls, ['main_migrated']);
});
test('迁移先改挂子会话，再归档原会话', async () => {
  const f = fixture(); assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'migrated');
  assert.ok(f.calls.indexOf('update:child') < f.calls.indexOf('archive:old')); assert.equal(f.agents.get('child')!.labels['paseo.parent-agent-id'], 'new');
});
test('迁移中每步失败时保留原会话并恢复自动继续', async () => {
  for (const step of ['stop', 'create', 'finalize', 'verify', 'children'] as const) {
    const f = fixture(); (f.port[step] as unknown) = async () => { throw Error('failure'); };
    assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'operation_failed');
    assert.equal(f.calls.includes('archive:old'), false); assert.equal(f.resume(), true); assert.ok(f.calls.includes('lb_exception'));
  }
});
test('锁有效期和点名账号例外', async () => {
  assert.equal(leaseActive(`plugin:${now + 1000}:x`, now), true); assert.equal(leaseActive('released:1', now), false);
  const f = fixture(); f.agent.labels['dsh.lb'] = 'manual'; assert.equal(await migrate(f.port, f.agent, [account('claude-1', 0), account('claude-2', 100)], 'live', now), 'manual');
  assert.deepEqual(f.calls, ['lb_exception']);
});
