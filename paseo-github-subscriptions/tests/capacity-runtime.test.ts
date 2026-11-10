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

test('一次迁移失败后不使用原快照继续迁移其他会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capacity-round-')); const now = Date.now();
  const makeAccount = (provider: string, five: number, ids: string[]) => calculate({ provider, now, agents: ids.map(id => ({ id, status: 'idle' })), report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Max 5x', windows: [{ id: 'five_hour', remainingPct: five, resetsAt: new Date(now + 3600_000).toISOString() }, { id: 'weekly', remainingPct: 100 }] } } });
  const agents = ['first', 'second'].map(id => ({ id, provider: 'claude-1', cwd: '/work', workspaceId: 'w', model: 'model', title: null, labels: { role: 'main', need: id } }));
  const data = { generatedAt: new Date(now).toISOString(), totalCanAdd: 4, recommendedProvider: 'claude-2', accounts: [makeAccount('claude-1', 0, ['first', 'second']), makeAccount('claude-2', 100, [])], excluded: [] };
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
