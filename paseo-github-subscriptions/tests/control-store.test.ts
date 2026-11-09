import test from 'node:test';

test('设备已保存后问答快照刷新失败，仍返回保存结果', async () => {
  const saved = { name: '随身手机', address: null, revision: 'new' };
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'bluetooth.select') return saved;
    throw new Error('问答快照暂时不可用');
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    assert.deepEqual(await store.selectBluetooth(null, { name: saved.name, address: null }), saved);
    assert.match(store.getState().presenceError ?? '', /快照暂时不可用/);
  } finally { store.dispose(); }
});
import assert from 'node:assert/strict';
import { createControlStore as createStore } from '../client/control-store.ts';
import { makeBrowser } from './ui/control-fixtures.ts';
import type { PresenceSnapshot } from '../shared/presence.ts';
import type { StalledSnapshot } from '../shared/stalled.ts';

const emptyAgents = (async () => ({ entries: [], pageInfo: { hasMore: false } })) as unknown as Parameters<typeof createStore>[1];
const createControlStore = (client: Parameters<typeof createStore>[0], listAgents = emptyAgents) => createStore(client, listAgents);

const makePresence = (): PresenceSnapshot => ({
  settings: { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null },
  observation: { mode: 'unknown', observedAt: null, reason: '蓝牙服务未响应', source: 'unavailable' },
  hostName: 'Mac Mini（演示）', hosts: [], error: null,
  questions: [{ id: 'q-1', sessionId: 'native-frontend', fingerprint: 'f1', source: 'native', title: '订单服务开发', at: new Date(0).toISOString(), state: 'pending', reason: '',
    prompts: [{ question: '本次发布包含哪些模块？', multiSelect: false, options: [{ label: '仅后端', description: '', recommended: true }] }] }],
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

test('旧快照不能覆盖新的配置状态，写入期间不启动刷新', async () => {
  const original = deferred<ReturnType<typeof makeBrowser>>();
  const writing = deferred<ReturnType<typeof makeBrowser>>();
  const initial = makeBrowser();
  let snapshots = 0;
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'browser.snapshot') { snapshots += 1; return original.promise; }
    if (contract.name === 'browser.configure') return writing.promise;
    return makePresence();
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    const read = store.refresh();
    const write = store.configureBrowser({ enabled: true, port: 17373 });
    await store.refresh();
    assert.equal(snapshots, 1);
    writing.resolve({ ...initial, settings: { enabled: true, port: 17373 } });
    await write;
    original.resolve({ ...initial, settings: { enabled: false, port: 17373 } });
    await read;
    assert.equal(store.getState().browser?.settings.enabled, true);
    assert.equal(store.getState().browserError, null);
  } finally { store.dispose(); }
});

test('单个模块错误不会清空其他模块，卸载后忽略在途结果', async () => {
  const result = deferred<PresenceSnapshot>();
  let notifications = 0;
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'browser.snapshot') throw new Error('浏览器桥接不可用');
    return result.promise;
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  store.subscribe(() => { notifications += 1; });
  const read = store.refresh();
  await new Promise(done => setImmediate(done));
  assert.match(store.getState().browserError ?? '', /浏览器桥接不可用/);
  store.dispose();
  const count = notifications;
  result.resolve(makePresence());
  await read;
  assert.equal(notifications, count);
  assert.equal(store.getState().presence, null);
});

test('回答提问后，较早发出的问答快照不能把提问改回待回答', async () => {
  const original = deferred<PresenceSnapshot>();
  const answered = deferred<PresenceSnapshot>();
  const initial = makePresence();
  const calls: unknown[] = [];
  const store = createControlStore({ rpc: (async (contract: { name: string }, input: unknown) => {
    if (contract.name === 'presence.snapshot') return original.promise;
    if (contract.name === 'presence.answer') { calls.push(input); return answered.promise; }
    if (contract.name === 'browser.snapshot') return makeBrowser();
    return { sessions: [], error: null };
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    const read = store.refresh();
    const answer = { id: 'q-1', answers: { '本次发布包含哪些模块？': ['仅后端'] } };
    const write = store.answerQuestion(answer);
    answered.resolve({ ...initial, questions: initial.questions.map(question => ({ ...question, state: 'submitted' as const })) });
    await write;
    original.resolve(initial);
    await read;
    assert.deepEqual(calls, [answer]);
    assert.equal(store.getState().presence?.questions[0]?.state, 'submitted');
    assert.equal(store.getState().presenceError, null);
  } finally { store.dispose(); }
});

test('问答接口不可用时只记录问答错误，其他模块照常刷新', async () => {
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name.startsWith('presence.')) throw new Error('未知接口 presence.snapshot');
    if (contract.name === 'browser.snapshot') return makeBrowser();
    return { sessions: [], error: null };
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    await store.refresh();
    assert.match(store.getState().presenceError ?? '', /未知接口/);
    assert.equal(store.getState().presence, null);
    assert.ok(store.getState().browser);
    await assert.rejects(store.configurePresence({ ...makePresence().settings, paused: true }), /未知接口/);
  } finally { store.dispose(); }
});

test('停滞扫描缓慢时仍可刷新问答，扫描失败保留旧停滞结果', async () => {
  const waiting = deferred<{ sessions: []; error: null }>();
  let reads = 0;
  let slow = true;
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'todos.stalled') { if (slow) return waiting.promise; throw new Error('主机断开'); }
    if (contract.name === 'presence.snapshot') { reads++; return makePresence(); }
    return makeBrowser();
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    const first = store.refresh();
    await new Promise(done => setImmediate(done));
    const second = store.refresh();
    await new Promise(done => setImmediate(done));
    assert.equal(reads, 2);
    waiting.resolve({ sessions: [], error: null }); await Promise.all([first, second]);
    assert.ok(store.getState().stalled);
    const previous = store.getState().stalled;
    slow = false; await store.refresh();
    assert.equal(store.getState().stalled, previous); assert.match(store.getState().stalledError!, /主机断开/);
  } finally { store.dispose(); }
});

test('完整扫描挂起时归档检查仍能清理卡片，迟到的扫描不会复活卡片', async () => {
  const stale: StalledSnapshot = { sessions: ['archived', 'live'].map(agentId => ({ agentId, title: agentId, since: '2026-11-08T06:00:00Z', lastMessage: '等待下一步', messageError: null })), error: null };
  const waiting = deferred<StalledSnapshot>();
  let reads = 0;
  let archived = false;
  const listAgents = (async () => ({ entries: ['archived', 'live'].map(id => ({ agent: { id, status: 'idle', archivedAt: id === 'archived' && archived ? '2026-11-08T06:03:14Z' : null } })), pageInfo: { hasMore: false } })) as unknown as Parameters<typeof createStore>[1];
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'todos.stalled') {
      reads++;
      if (reads === 1) return stale;
      if (reads === 2) return waiting.promise;
      throw new Error('远端主机断开');
    }
    if (contract.name === 'presence.snapshot') return makePresence();
    return makeBrowser();
  }) as Parameters<typeof createStore>[0]['rpc'] }, listAgents);
  try {
    await store.refresh();
    assert.equal(store.getState().stalled?.sessions.length, 2);
    const scanning = store.refresh();
    await new Promise(done => setImmediate(done));
    archived = true;
    const refreshing = store.refresh();
    await new Promise(done => setImmediate(done));
    assert.deepEqual(store.getState().stalled?.sessions.map(session => session.agentId), ['live']);
    assert.equal(reads, 2);
    waiting.resolve(stale);
    await Promise.all([scanning, refreshing]);
    assert.deepEqual(store.getState().stalled?.sessions.map(session => session.agentId), ['live']);
    await store.refresh();
    assert.deepEqual(store.getState().stalled?.sessions.map(session => session.agentId), ['live']);
    assert.match(store.getState().stalledError!, /远端主机断开/);
  } finally { store.dispose(); }
});

test('归档检查读取所有分页，失败时隐藏无法确认的旧卡片', async () => {
  let fail = false;
  const cursors: Array<string | undefined> = [];
  const listAgents = (async (options: { filter: { includeArchived: boolean }; page: { cursor?: string } }) => {
    assert.equal(options.filter.includeArchived, false);
    cursors.push(options.page.cursor);
    if (fail) throw new Error('本机列表不可用');
    return { entries: [{ agent: { id: options.page.cursor ? 'second' : 'first', status: 'idle' } }], pageInfo: { hasMore: !options.page.cursor, nextCursor: options.page.cursor ? undefined : 'next' } };
  }) as unknown as Parameters<typeof createStore>[1];
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'todos.stalled') return { sessions: ['first', 'second'].map(agentId => ({ agentId, title: agentId, since: '2026-11-08T06:00:00Z', lastMessage: null, messageError: null })), error: null };
    if (contract.name === 'presence.snapshot') return makePresence();
    return makeBrowser();
  }) as Parameters<typeof createStore>[0]['rpc'] }, listAgents);
  try {
    await store.refresh();
    assert.deepEqual(store.getState().stalled?.sessions.map(session => session.agentId), ['first', 'second']);
    assert.ok(cursors.includes('next'));
    fail = true;
    await store.refresh();
    assert.deepEqual(store.getState().stalled?.sessions, []);
    assert.match(store.getState().stalledError!, /本机列表不可用/);
  } finally { store.dispose(); }
});

test('已读写入不被较早快照覆盖，失败时保留未读状态', async () => {
  const original = deferred<PresenceSnapshot>();
  const initial = makePresence();
  initial.questions[0].state = 'resolved';
  initial.questions[0].answer = { source: 'automatic', answers: { '本次发布包含哪些模块？': ['仅后端'] } };
  let rejectRead = false;
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'presence.snapshot') return original.promise;
    if (contract.name === 'presence.read') {
      if (rejectRead) throw new Error('写入失败');
      return { ...initial, questions: initial.questions.map(question => ({ ...question, answer: { ...question.answer, readAt: '2026-11-07T01:00:00Z' } })) };
    }
    return makeBrowser();
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    const refresh = store.refresh();
    await store.markQuestionRead({ id: 'q-1', fingerprint: 'f1' });
    original.resolve(initial); await refresh;
    assert.ok(store.getState().presence?.questions[0].answer?.readAt);
    await store.refresh(); rejectRead = true;
    await assert.rejects(store.markQuestionRead({ id: 'q-1', fingerprint: 'f1' }), /写入失败/);
    assert.equal(store.getState().presence?.questions[0].answer?.readAt, undefined);
  } finally { store.dispose(); }
});

test('其他会话的 RPC 未注册或模块未开启时标记为 disabled 且不报错；已开启模块运行报错时记录 error', async () => {
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'modules.status') {
      return {
        instance: { role: 'main', legacy: false },
        config: { path: '/x/machine.json', source: 'file', errors: [] },
        modules: [
          { id: 'usage.claudeAccounts', label: 'Claude 账号', state: 'off', reason: '默认关闭' },
          { id: 'answer.escalation', label: '升级通知', state: 'running' },
        ],
      };
    }
    if (contract.name === 'answer.escalation' || contract.name === 'escalation.snapshot') {
      throw new Error('Webhook 状态文件损坏');
    }
    throw new Error(`未知调用 ${contract.name}`);
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    await store.refreshUnify();
    const state = store.getState();
    assert.equal(state.claudeAccountsStatus, 'disabled');
    assert.equal(state.claudeAccountsError, null);
    assert.equal(state.quietStatus, 'disabled');
    assert.equal(state.quietError, null);
    assert.equal(state.escalationStatus, 'error');
    assert.match(state.escalationError ?? '', /Webhook 状态文件损坏/);
  } finally { store.dispose(); }
});


test('待办操作超时后返回失败提示，按钮不会一直“处理中”；之后仍刷新列表', async () => {
  let lists = 0;
  const store = createStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'todo.act') return new Promise(() => {});
    if (contract.name === 'todo.list') { lists += 1; return { items: [], logs: [], hosts: [], warning: null }; }
    throw new Error('未注册');
  }) as Parameters<typeof createStore>[0]['rpc'] }, emptyAgents, { actTimeoutMs: 20 });
  try {
    const result = await store.actTodo({ hostId: 'srv-mini', action: { type: 'ack-escalation', escalationId: 'esc-1' } });
    assert.equal(result.ok, false);
    assert.match(result.message, /超时/);
    await new Promise(done => setTimeout(done, 20));
    assert.ok(lists >= 1);
  } finally { store.dispose(); }
});

test('待办操作成功后重新读取列表，不沿用操作前发出的旧列表结果', async () => {
  const before = deferred<unknown>();
  const item = { id: 'esc:srv-mini:esc-1' };
  let lists = 0;
  const store = createStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'todo.act') return { ok: true, message: '已标为已处理' };
    if (contract.name === 'todo.list') { lists += 1; return lists === 1 ? before.promise : { items: [], logs: [], hosts: [], warning: null }; }
    throw new Error('未注册');
  }) as Parameters<typeof createStore>[0]['rpc'] }, emptyAgents, { actTimeoutMs: 1000 });
  try {
    const stale = store.refreshUnify();
    const acted = store.actTodo({ hostId: 'srv-mini', action: { type: 'ack-escalation', escalationId: 'esc-1' } });
    before.resolve({ items: [item], logs: [], hosts: [], warning: null });
    await stale;
    assert.equal((await acted).ok, true);
    await new Promise(done => setTimeout(done, 10));
    assert.equal(lists, 2);
    assert.deepEqual(store.getState().todo?.items, []);
  } finally { store.dispose(); }
});

test('模块切换和重载期间全局锁住开关，结束后刷新状态并解锁', async () => {
  const pending = deferred<any>();
  const store = createStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'machine.settings.toggle-module') return pending.promise;
    throw new Error('离线');
  }) as Parameters<typeof createStore>[0]['rpc'] }, emptyAgents, { reloadDelayMs: 10 } as never);
  try {
    const first = store.toggleModule('answer.browser', true);
    assert.equal((store.getState() as any).moduleReloading, true);
    await assert.rejects(store.toggleModule('answer.presence', false), /正在重新加载/);
    pending.resolve({ modules: [] }); await first;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((store.getState() as any).moduleReloading, false);
    assert.equal((store.getState() as any).moduleReloadUnverified, 'answer.browser');
  } finally { store.dispose(); }
});

test('服务器仍在重载时超过提示时间仍锁住开关，直到服务器确认结束', async () => {
  let pending = true;
  const snapshot = () => ({ configPath: '/tmp/machine', source: 'file', machine: null, errors: [], modules: [], pausedAll: false, reloadInProgress: pending });
  const store = createStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'machine.settings.toggle-module' || contract.name === 'machine.settings.snapshot') return snapshot();
    throw new Error('offline');
  }) as Parameters<typeof createStore>[0]['rpc'] }, emptyAgents, { reloadDelayMs: 10, reloadPollMs: 15 } as never);
  try {
    await store.toggleModule('answer.browser', true);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((store.getState() as any).moduleReloading, true);
    pending = false;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((store.getState() as any).moduleReloading, false);
  } finally { store.dispose(); }
});
