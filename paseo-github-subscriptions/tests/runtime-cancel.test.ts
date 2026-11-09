import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EscalationRuntime } from '../server/modules/answer-escalation/runtime.ts';
import { ESCALATION_FALLBACK, RuntimeSettingsSchema, runtimeDefaults } from '../server/modules/answer-escalation/config.ts';
import { ForwardRuntime } from '../server/modules/answer-quiet-children/forward.ts';
import { HandledRecords } from '../server/modules/answer-quiet-children/handled.ts';
import { createSettingsStore } from '../server/core/settings-store.ts';
import { parseWorkspaceRoles } from '../server/core/session-roles.ts';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-cancel-'));
  const counts = { hooksAdded: 0, hooksRemoved: 0, released: 0, subscribed: 0, unsubscribed: 0 };
  const server = { addHook: () => { counts.hooksAdded++; return () => { counts.hooksRemoved++; }; } };
  const listGate = gate<void>(); const listCalledGate = gate<void>(); const readyGate = gate<void>();
  const subscription = { release: async () => { counts.released++; }, subscribe: () => { counts.subscribed++; return () => { counts.unsubscribed++; }; } };
  const paseo = { agents: { list: async () => { listCalledGate.resolve(); await listGate.promise; return { subscription }; }, ref: () => ({}) }, workspaces: { list: async () => ({ entries: [] }) }, projects: { list: async () => ({ projects: [] }), subscribe: () => () => {} } };
  const client = { getLastServerInfoMessage: () => ({ serverId: 'srv' }) };
  const daemon = { ready: async () => { await readyGate.promise; return { paseo, client }; } };
  const roles = { read: async () => parseWorkspaceRoles([]) };
  return { dir, counts, server, daemon, roles, listGate, listCalledGate, readyGate, done: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const kind of ['escalation', 'forward'] as const) {
  const make = (f: ReturnType<typeof fixture>) => {
    if (kind === 'escalation') {
      const section = { ...ESCALATION_FALLBACK, newObjects: false, quotaAlerts: { enabled: false } };
      return new EscalationRuntime({ server: f.server as never, daemon: f.daemon as never, roles: f.roles, directory: f.dir, machineName: 'test', section, settings: createSettingsStore(join(f.dir, 's.json'), RuntimeSettingsSchema, runtimeDefaults(section)), log: () => {} });
    }
    return new ForwardRuntime({ server: f.server as never, daemon: f.daemon as never, roles: f.roles, directory: f.dir, machineName: 'test', handled: new HandledRecords(join(f.dir, 'h.json')), resolveLocal: async () => ({ agentId: null, workspaceId: null }), log: () => {} });
  };

  test(`${kind}：连接守护进程期间就停止，连接完成后不注册任何钩子`, async () => {
    const f = fixture();
    try {
      const runtime = make(f);
      const started = runtime.start();
      await runtime.stop();
      f.readyGate.resolve();
      await assert.rejects(started, /已停止/);
      assert.equal(f.counts.hooksAdded, 0);
    } finally { f.done(); }
  });

  test(`${kind}：订阅会话列表期间停止，已注册的钩子都被移除，拿到的订阅被释放`, async () => {
    const f = fixture();
    try {
      const runtime = make(f);
      const started = runtime.start();
      f.readyGate.resolve();
      await f.listCalledGate.promise;
      assert.equal(f.counts.hooksAdded, 3);
      await runtime.stop();
      f.listGate.resolve();
      await assert.rejects(started, /已停止/);
      assert.equal(f.counts.hooksRemoved, f.counts.hooksAdded);
      assert.equal(f.counts.released, 1);
      assert.equal(f.counts.subscribed, 0);
    } finally { f.done(); }
  });
}

import { writeFileSync } from 'node:fs';
import { Engine, emptyState } from '../server/notify/engine.ts';
import { loadState } from '../server/notify/store.ts';

test('切换实际发送：写设置失败时回退，状态、模式和记录文件都保持原样', async () => {
  const f = fixture();
  try {
    const section = { ...ESCALATION_FALLBACK };
    const blocker = join(f.dir, 'blocker'); writeFileSync(blocker, 'x');
    // 设置文件放在“文件”下面，写入必然失败。
    const settings = createSettingsStore(join(blocker, 's.json'), RuntimeSettingsSchema, runtimeDefaults(section));
    const runtime = new EscalationRuntime({ server: f.server as never, daemon: f.daemon as never, roles: f.roles, directory: f.dir, machineName: 'test', section, settings, log: () => {} });
    const state = emptyState(); state.pending['q'] = { agentId: 'a', requestId: 'q', at: 1, data: {} };
    const engine = new Engine({ hostId: 'h', machine: 'h', delivery: 'shadow', mains: [], children: {} }, state, async () => {}, async () => {}, async () => true);
    Object.assign(runtime as unknown as Record<string, unknown>, { engine, statePath: join(f.dir, 'state-shadow.json') });
    await assert.rejects(runtime.configure({ delivery: 'live' }));
    assert.equal(engine.config.delivery, 'shadow');
    assert.equal(engine.state, state);
    assert.equal((runtime as unknown as { statePath: string }).statePath, join(f.dir, 'state-shadow.json'));
    assert.equal(settings.read().delivery, 'shadow');
    assert.deepEqual(Object.keys((await loadState(join(f.dir, 'state-shadow.json'))).pending), ['q']);
  } finally { f.done(); }
});

import { QuietRuntime } from '../server/modules/answer-quiet-children/runtime.ts';
import { QuietSettingsSchema } from '../server/modules/answer-quiet-children/config.ts';

function quiet(f: ReturnType<typeof fixture>, options: { forward: boolean; blocked?: string; resolved?: string | null; parent?: boolean }) {
  const enqueued: Array<[string, string]> = [];
  const runtime = new QuietRuntime({
    server: f.server as never, daemon: f.daemon as never, roles: { read: async () => parseWorkspaceRoles([{ workspaceId: 'wks_main', pinnedAt: 'x' }]) }, directory: f.dir, machineName: 'test',
    settings: createSettingsStore(join(f.dir, 'q.json'), QuietSettingsSchema, { enabled: true, forwardEvents: options.forward } as { enabled: boolean; forwardEvents: boolean }),
    resolveLocal: async () => ({ agentId: options.resolved ?? null, workspaceId: null }),
    ...(options.blocked ? { forwardBlocked: options.blocked } : {}), log: () => {},
  });
  (runtime as unknown as { clearer: unknown }).clearer = { enqueue: (scope: string, id: string) => { enqueued.push([scope, id]); } };
  const agent = { id: 'child', workspaceId: 'wks_sub', status: 'running', requiresAttention: true, pendingPermissions: [{ kind: 'question' }], ...(options.parent === false ? {} : { labels: { 'paseo.parent-agent-id': 'main' } }) };
  return { enqueued, consider: () => (runtime as unknown as { consider(agent: unknown): Promise<void> }).consider(agent) };
}

test('子会话的提问提醒：转发关闭、没有父会话或找不到转发目标时保留；转发已打开且有目标，或旧转发插件仍运行时才清除', async () => {
  const f = fixture();
  try {
    const off = quiet(f, { forward: false }); await off.consider(); assert.deepEqual(off.enqueued, []);
    const orphan = quiet(f, { forward: true, parent: false }); await orphan.consider(); assert.deepEqual(orphan.enqueued, []);
    const missing = quiet(f, { forward: true, resolved: null }); await missing.consider(); assert.deepEqual(missing.enqueued, []);
    const on = quiet(f, { forward: true, resolved: 'main' }); await on.consider(); assert.deepEqual(on.enqueued, [['agent', 'child']]);
    const legacy = quiet(f, { forward: false, blocked: '旧插件仍启用' }); await legacy.consider(); assert.deepEqual(legacy.enqueued, [['agent', 'child']]);
  } finally { f.done(); }
});


test('额度报警已开启但找不到凭据：页面给出警告；有凭据或关闭时没有警告', async () => {
  const f = fixture();
  try {
    const make = (enabled: boolean, credentials: unknown) => {
      const section = { ...ESCALATION_FALLBACK, quotaAlerts: { enabled } };
      return new EscalationRuntime({ server: f.server as never, daemon: f.daemon as never, roles: f.roles, directory: f.dir, machineName: 'test', section, settings: createSettingsStore(join(f.dir, `s-${enabled}-${credentials === null}.json`), RuntimeSettingsSchema, runtimeDefaults(section)), quotaCredentials: async () => credentials as never, log: () => {} });
    };
    assert.match((await make(true, null).snapshot()).error ?? '', /额度报警.*没有找到凭据.*fileDirectory/);
    assert.equal((await make(true, { url: 'http://127.0.0.1:1/x', auth: 'X-Test: test-secret' }).snapshot()).error, null);
    assert.equal((await make(false, null).snapshot()).error, null);
  } finally { f.done(); }
});
