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
import { createControlStore } from '../client/control-store.ts';
import { makeAutomation, makeBrowser } from './ui/control-fixtures.ts';
import type { PresenceSnapshot } from '../shared/presence.ts';

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

test('旧快照不能覆盖新的暂停状态，写入期间不启动刷新', async () => {
  const original = deferred<ReturnType<typeof makeAutomation>>();
  const writing = deferred<ReturnType<typeof makeAutomation>>();
  const initial = makeAutomation();
  let snapshots = 0;
  const store = createControlStore({ rpc: (async (contract: { name: string }) => {
    if (contract.name === 'automation.snapshot') { snapshots += 1; return original.promise; }
    if (contract.name === 'automation.pause') return writing.promise;
    return makeBrowser();
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    const read = store.refresh();
    const write = store.pause(true);
    await store.refresh();
    assert.equal(snapshots, 1);
    writing.resolve({ ...initial, paused: true });
    await write;
    original.resolve({ ...initial, paused: false });
    await read;
    assert.equal(store.getState().automation?.paused, true);
    assert.equal(store.getState().browserError, null);
  } finally { store.dispose(); }
});

test('单个模块错误不会清空其他模块，卸载后忽略在途结果', async () => {
  const result = deferred<ReturnType<typeof makeAutomation>>();
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
  result.resolve(makeAutomation());
  await read;
  assert.equal(notifications, count);
  assert.equal(store.getState().automation, null);
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
    return makeAutomation();
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
    return makeAutomation();
  }) as Parameters<typeof createControlStore>[0]['rpc'] });
  try {
    await store.refresh();
    assert.match(store.getState().presenceError ?? '', /未知接口/);
    assert.equal(store.getState().presence, null);
    assert.ok(store.getState().automation);
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
