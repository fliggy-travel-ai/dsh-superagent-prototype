import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapacityModule } from '../server/modules/capacity/index.ts';
import { CAPACITY_DEFAULT } from '../server/modules/capacity/config.ts';
import { calculate } from '../server/modules/capacity/model.ts';

test('恢复失败时容量快照和推送继续，迁移停止并报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capacity-runtime-'));
  const events: string[] = []; const failed: unknown[] = [];
  const data = { generatedAt: new Date().toISOString(), totalCanAdd: 0, recommendedProvider: null, accounts: [], excluded: [] };
  const module = createCapacityModule({ readSnapshot: async () => data, notifier: (async () => ({ send: async (event: string) => { events.push(event); }, stop: () => {} })) as never });
  const handlers = new Map<string, any>();
  const ctx = { stateDirectory: dir, config: { ...CAPACITY_DEFAULT, migration: { mode: 'live' } }, machine: { section: () => ({ ok: true, value: { sourceId: 'claude-accounts' } }) },
    services: { home: dir, daemon: { ready: async () => ({ client: { fetchAgents: async () => { throw Error('offline'); } } }) } },
    server: { handle: (contract: { name: string }, fn: any) => handlers.set(contract.name, fn) }, fail: (error: unknown) => failed.push(error) };
  const cleanup = module.register(ctx as never) as () => Promise<void>;
  try {
    for (let i = 0; i < 100 && !events.includes('lb_exception'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(events.includes('capacity')); assert.ok(events.includes('lb_exception'));
    assert.deepEqual(await handlers.get('capacity.snapshot')!({}), data); assert.deepEqual(failed, []);
  } finally { await cleanup(); await rm(dir, { recursive: true, force: true }); }
});

test('跳过已迁移和已归档源会话，一次迁移失败后停止使用旧快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capacity-round-')); const now = Date.now();
  const makeAccount = (provider: string, five: number, ids: string[]) => calculate({ provider, now, agents: ids.map(id => ({ id, status: 'idle' })), report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Max 5x', windows: [{ id: 'five_hour', remainingPct: five, resetsAt: new Date(now + 3600_000).toISOString() }, { id: 'weekly', remainingPct: 100 }] } } });
  const agents = ['migrated', 'archived', 'first', 'second'].map(id => ({ id, provider: 'claude-1', cwd: '/work', workspaceId: 'w', model: 'model', title: null, status: 'error', archivedAt: id === 'archived' ? 'archived' : null, labels: { role: 'main', need: id, 'dsh.migration-successor': id === 'migrated' ? 'successor' : '' } }));
  const data = { generatedAt: new Date(now).toISOString(), totalCanAdd: 4, recommendedProvider: 'claude-2', accounts: [makeAccount('claude-1', 0, agents.map(agent => agent.id)), makeAccount('claude-2', 100, [])], excluded: [] };
  const stops: string[] = []; const events: string[] = []; const handlers = new Map<string, any>();
  const module = createCapacityModule({ readSnapshot: async () => data, notifier: (async () => ({ send: async (event: string) => { events.push(event); }, stop: () => {} })) as never,
    migrationPort: ((_client: unknown, _template: unknown, _audit: unknown, notify: any, _signal: unknown, journal: any) => ({
      journal, notify, audit: async () => {}, read: async (id: string) => agents.find(a => a.id === id) ?? null,
      update: async (id: string, labels: Record<string, string>) => { Object.assign(agents.find(a => a.id === id)!.labels, labels); },
      delay: async () => {}, autoResume: async () => true, setAutoResume: async () => {}, stop: async (agent: { id: string }) => { stops.push(agent.id); return true; },
      create: async () => { throw Error('source_unavailable'); }, continueWork: async () => {},
    })) as never });
  const client = { fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }) };
  const ctx = { stateDirectory: dir, config: { ...CAPACITY_DEFAULT, migration: { mode: 'live' } }, machine: { section: () => ({ ok: true, value: { sourceId: 'claude-accounts' } }) },
    services: { home: dir, daemon: { ready: async () => ({ client }) } }, server: { handle: (contract: { name: string }, fn: any) => handlers.set(contract.name, fn) }, fail: () => {} };
  const cleanup = module.register(ctx as never) as () => Promise<void>;
  try {
    for (let i = 0; i < 100 && !events.includes('lb_exception'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(stops, ['first']); assert.ok(events.includes('lb_exception'));
  } finally { await cleanup(); await rm(dir, { recursive: true, force: true }); }
});
test('解除待审 RPC 读回标签与状态记录并返回自动继续原值', async () => {
  const { MigrationJournal } = await import('../server/modules/capacity/journal.ts');
  const dir = await mkdtemp(join(tmpdir(), 'capacity-clear-rpc-'));
  const path = join(dir, 'capacity', 'migrations-state.json');
  const saved = new MigrationJournal(path); await saved.begin('old', 'plugin:1:nonce', 'weekly'); await saved.saveResume('old', true); await saved.markStarted('old'); await saved.review('old', 'archive_unknown');
  const agent = { id: 'old', provider: 'claude-1', cwd: '/work', model: 'model', title: null, labels: { 'dsh.migration-state': 'needs_review', 'dsh.migration-lease': 'plugin:1:nonce' } };
  const client = { fetchAgents: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }), fetchAgent: async () => ({ agent }), updateAgent: async (_id: string, updates: { labels: Record<string, string> }) => Object.assign(agent.labels, updates.labels) };
  const events: string[] = []; const handlers = new Map<string, any>();
  const data = { generatedAt: new Date().toISOString(), totalCanAdd: 0, recommendedProvider: null, accounts: [], excluded: [] };
  const module = createCapacityModule({ readSnapshot: async () => data, notifier: (async () => ({ send: async (event: string) => { events.push(event); }, stop: () => {} })) as never });
  const ctx = { stateDirectory: dir, config: CAPACITY_DEFAULT, machine: { section: () => ({ ok: true, value: { sourceId: 'claude-accounts' } }) },
    services: { home: dir, daemon: { ready: async () => ({ client }) } }, server: { handle: (contract: { name: string }, fn: any) => handlers.set(contract.name, fn) }, fail: () => {} };
  const cleanup = module.register(ctx as never) as () => Promise<void>;
  try {
    for (let i = 0; i < 100 && !events.includes('lb_exception'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 100; i++) {
      try { const result = await handlers.get('capacity.clear-review')!({ agentId: 'old' }); assert.deepEqual(result, { ok: true, autoResume: true }); break; }
      catch (error) { if (!String(error).includes('恢复尚未完成') || i === 99) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const reloaded = new MigrationJournal(path); await reloaded.load(); assert.equal(reloaded.get('old'), undefined);
    assert.ok(agent.labels['dsh.migration-state'].startsWith('cleared:')); assert.ok(agent.labels['dsh.migration-lease'].startsWith('released:'));
  } finally { await cleanup(); await rm(dir, { recursive: true, force: true }); }
});
test('多个会话同时超额：首轮无可接账号进入冷却，出现空位后全部迁移，不等满 30 分钟', async () => {
  const { capacityChanged } = await import('../server/modules/capacity/changes.ts');
  const dir = await mkdtemp(join(tmpdir(), 'capacity-waiting-')); const now = Date.now();
  const makeAccount = (provider: string, five: number, ids: string[], planLabel = 'Max 5x') => calculate({ provider, now, agents: ids.map(id => ({ id, status: 'idle' })), report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel, windows: [{ id: 'five_hour', remainingPct: five, resetsAt: new Date(now + 3600_000).toISOString() }, { id: 'weekly', remainingPct: 100 }] } } });
  const agents = ['first', 'second'].map(id => ({ id, provider: 'claude-1', cwd: '/work', workspaceId: 'w', model: 'model', title: null, status: 'error', archivedAt: null as string | null, labels: { role: 'main', need: id } as Record<string, string> }));
  const full = makeAccount('claude-2', 100, ['x1', 'x2', 'x3', 'x4']);
  let data = { generatedAt: new Date(now).toISOString(), totalCanAdd: 0, recommendedProvider: null as string | null, accounts: [makeAccount('claude-1', 0, ['first', 'second']), full], excluded: [] };
  const resumed: string[] = []; const created: string[] = []; const events: string[] = [];
  const module = createCapacityModule({ readSnapshot: async () => data, notifier: (async () => ({ send: async (event: string) => { events.push(event); }, stop: () => {} })) as never,
    migrationPort: ((_client: unknown, _template: unknown, _audit: unknown, notify: any, _signal: unknown, journal: any) => ({
      journal, notify, audit: async () => {}, read: async (id: string) => agents.find(a => a.id === id) ?? { id, provider: 'claude-2', cwd: '/work', model: 'model', title: null, status: 'running', archivedAt: null, labels: {} },
      update: async (id: string, labels: Record<string, string>) => { const agent = agents.find(a => a.id === id); if (agent) Object.assign(agent.labels, labels); },
      delay: async () => {}, autoResume: async () => false, setAutoResume: async (id: string, value: boolean) => { if (value) resumed.push(id); }, stop: async () => true,
      create: async (agent: { id: string }) => { created.push(agent.id); return `new-${agent.id}`; }, finalize: async () => true, verify: async () => 'ok', children: async () => [], serverId: () => 'srv',
      archive: async (id: string) => { const agent = agents.find(a => a.id === id); if (agent) agent.archivedAt = 'now'; }, continueWork: async () => {},
    })) as never });
  const client = { fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }) };
  const ctx = { stateDirectory: dir, config: { ...CAPACITY_DEFAULT, migration: { mode: 'live' } }, machine: { section: () => ({ ok: true, value: { sourceId: 'claude-accounts' } }) },
    services: { home: dir, daemon: { ready: async () => ({ client }) } }, server: { handle: () => {} }, fail: () => {} };
  const cleanup = module.register(ctx as never) as () => Promise<void>;
  try {
    for (let i = 0; i < 200 && resumed.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(resumed.sort(), ['first', 'second'], '同一轮内两个超额会话都应打开自动继续');
    assert.deepEqual(created, []);
    data = { ...data, accounts: [data.accounts[0]!, makeAccount('claude-2', 100, [])] };
    capacityChanged();
    for (let i = 0; i < 300 && created.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(created.sort(), ['first', 'second']);
    assert.ok(agents.every(agent => agent.archivedAt));
  } finally { await cleanup(); await rm(dir, { recursive: true, force: true }); }
});
