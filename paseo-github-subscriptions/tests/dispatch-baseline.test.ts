import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchFinalizeModule } from '../server/modules/dispatch-finalize/index.ts';
import { ESCALATION_FALLBACK } from '../server/modules/answer-escalation/config.ts';

test('首次启动以已有主会话为基线，新增主会话自动收尾，RPC 可收尾基线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-baseline-'));
  const old = { id: 'old', workspaceId: 'w1', labels: { role: 'main', need: '1' } };
  const later = { id: 'later', workspaceId: 'w2', labels: { role: 'child', need: '2' } };
  const agents = [old, later]; const pinned: string[] = [];
  const workspaces = [{ id: 'w1', pinnedAt: null as string | null, labels: [] as string[] }, { id: 'w2', pinnedAt: null as string | null, labels: [] as string[] }];
  let subscriber: any; const handlers = new Map<string, (input: any) => Promise<any>>();
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) }),
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false } }),
    setWorkspacePinned: async (id: string) => { pinned.push(id); workspaces.find(w => w.id === id)!.pinnedAt = 'now'; },
    setWorkspaceLabel: async ({ workspaceId }: { workspaceId: string }) => { workspaces.find(w => w.id === workspaceId)!.labels.push('主会话'); },
    detachAgent: async () => {},
  };
  const subscription = { subscribe: (value: any) => { subscriber = value; value.snapshot({ entries: agents.map(agent => ({ agent })) }); return () => {}; }, release: async () => {} };
  const context = {
    stateDirectory: root, services: { daemon: { ready: async () => ({ client, paseo: { agents: { list: async () => ({ subscription }) } } }) } },
    machine: { machine: null, section: () => ({ ok: true, value: ESCALATION_FALLBACK }) },
    server: { handle: (contract: { name: string }, fn: any) => handlers.set(contract.name, fn), addHook: () => () => {} }, fail: (error: unknown) => { throw error; },
  };
  const cleanup = dispatchFinalizeModule.register(context as never) as () => Promise<void>;
  try {
    for (let i = 0; i < 100 && !subscriber; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(subscriber); assert.equal(pinned.length, 0);
    const baseline = JSON.parse(await readFile(join(root, 'finalize', 'baseline.json'), 'utf8')); assert.deepEqual(baseline, { old: true });
    later.labels.role = 'main'; subscriber.update({ type: 'agent_update', payload: { kind: 'upsert', agent: later } });
    for (let i = 0; i < 100 && !pinned.includes('w2'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(pinned, ['w2']);
    assert.equal((await handlers.get('dispatch.finalize')!({ agentId: 'old' })).ok, true);
    assert.deepEqual(pinned, ['w2', 'w1']);
  } finally { await cleanup(); await rm(root, { recursive: true, force: true }); }
});
