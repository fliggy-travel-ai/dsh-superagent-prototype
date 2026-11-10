import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { PresenceRuntime, type PresencePort, type QuestionAgent } from '../server/presence.ts';
import { BrowserBridge } from '../server/browser-bridge.ts';
import { WebRequestExecutor, type WebRequestRuntimePort } from '../server/web-request/executor.ts';
import { WebRequestLedger } from '../server/web-request/ledger.ts';
import { isQuestionTodo, type BrowserQuestion, type PresenceObservation } from '../shared/presence.ts';

// #1704 缺陷修复（评论 6732374037）：同步不等远端采样、3 秒预算、未确认的网页作答重新进入人工待办、审计保留首个结果。

const prompt = { question: '下一步怎么处理？', header: '下一步', multiSelect: false, options: [{ label: '建需求单 (Recommended)', description: '', recommended: true }, { label: '到此为止', description: '', recommended: false }] };
const answer = { [prompt.question]: [prompt.options[0]!.label] };
const webpage = (sessionId = 'one'): BrowserQuestion => ({ id: 'web-question', sessionId, fingerprint: 'stable-fingerprint', toolUseId: 'toolu_1', prompts: [structuredClone(prompt)] });
const syncSessions = [{ sessionId: 'one', title: '网页开发', url: 'https://claude.ai/code/session_one' }];
const cloudRequest = (): AgentPermissionRequest => ({
  id: 'toolu_1', provider: 'cloud-session', kind: 'question', name: 'AskUserQuestion', input: { questions: [structuredClone(prompt)] },
  metadata: { cloudSessionManual: true, webSessionId: 'session_one', toolUseId: 'toolu_1' },
});
const cloudAgent = (pending: AgentPermissionRequest[] = []): QuestionAgent => ({ id: 'cloud-agent', title: '云端会话', provider: 'cloud-session', labels: { 'cloud-session.id': 'cse_one' }, pendingPermissions: pending });

async function fixture(observe: PresencePort['observe']) {
  const directory = await mkdtemp(join(tmpdir(), 'web-answer-fix-'));
  const agents: QuestionAgent[] = [];
  const responses: unknown[] = [];
  const port: PresencePort = {
    list: async () => structuredClone(agents), refresh: async id => structuredClone(agents.find(item => item.id === id) ?? null),
    respond: async (...args) => { responses.push(args); }, observe,
    speak: async () => ({ played: true, engine: 'neural' }), cancelSpeech: async () => {}, hosts: async () => [],
  };
  const runtime = new PresenceRuntime(directory, port, Date.now, new WebRequestLedger());
  await runtime.start();
  return { runtime, agents, responses, directory, close: async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); } };
}

const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms))]);
const online = (): PresenceObservation => ({ mode: 'online', observedAt: new Date().toISOString(), reason: '手机在旁边', source: 'bluetooth' });

test('网页同步不等待远端在场采样：来源主机卡住时仍立即下发已转交的答案', async () => {
  let hang = false;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const setup = await fixture(async () => { if (hang) await gate; return online(); });
  try {
    setup.agents.push(cloudAgent([cloudRequest()]));
    await setup.runtime.refresh();
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    const browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), true);
    hang = true;
    const decisions = await within(setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']), 1000);
    assert.notEqual(decisions, 'timeout', '同步被远端采样卡住');
    assert.equal((decisions as unknown[]).length, 1);
  } finally { release(); await setup.close(); }
});

test('同步超过时间预算时不标记已下发，答案留在队列里，下一次同步再下发', async () => {
  const setup = await fixture(async () => online());
  try {
    setup.agents.push(cloudAgent([cloudRequest()]));
    await setup.runtime.refresh();
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    const browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), true);
    const late = await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one'], { deadline: Date.now() - 1 });
    assert.deepEqual(late, []);
    assert.equal(setup.runtime.browserState(browserQ.id)?.state, 'pending');
    assert.equal(setup.runtime.browserState(browserQ.id)?.queued, true);
    const next = await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one'], { deadline: Date.now() + 3000 });
    assert.equal(next.length, 1);
    assert.equal(setup.runtime.browserState(browserQ.id)?.state, 'submitted');
  } finally { await setup.close(); }
});

test('浏览器桥接把收到同步请求后 3 秒作为下发答案的截止时间', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-answer-bridge-'));
  const seen: Array<{ deadline?: number } | undefined> = [];
  const bridge = new BrowserBridge(directory, async () => null, async (...args) => { seen.push(args[5]); return []; });
  try {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!address || typeof address === 'string') throw new Error('port');
    await bridge.start(); await bridge.configure({ enabled: true, port: address.port });
    const pairing = await bridge.pairing();
    const before = Date.now();
    const response = await fetch(pairing.url, { method: 'POST', headers: { origin: `chrome-extension://${'a'.repeat(32)}`, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instanceId: 'one', sessions: [] }) });
    const after = Date.now();
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    const deadline = seen[0]?.deadline;
    assert.equal(typeof deadline, 'number');
    assert.ok(deadline! >= before + 3000 && deadline! <= after + 3000, `deadline ${deadline} 不在 ${before + 3000}..${after + 3000}`);
  } finally { await bridge.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('网页作答未确认时云端提问回到人工待办并提示去网页重试，云端确认后结束', async () => {
  const setup = await fixture(async () => online());
  try {
    setup.agents.push(cloudAgent([cloudRequest()]));
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online', speechEnabled: false });
    await setup.runtime.refresh();
    let nativeQ = setup.runtime.snapshot().questions.find(item => item.source === 'native')!;
    // 用户在 Paseo 原生界面作答后，Paseo 不再列出该请求，扫描把它记为已结束
    setup.agents[0]!.pendingPermissions = [];
    await setup.runtime.refresh();
    nativeQ = setup.runtime.snapshot().questions.find(item => item.id === nativeQ.id)!;
    assert.equal(nativeQ.state, 'resolved');

    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'unknown', detail: 'no_receipt' } });
    await setup.runtime.refresh();
    nativeQ = setup.runtime.snapshot().questions.find(item => item.id === nativeQ.id)!;
    assert.equal(nativeQ.state, 'unknown');
    assert.equal(isQuestionTodo(nativeQ), true);
    assert.match(nativeQ.reason, /请在 claude\.ai 重试/);
    assert.equal(nativeQ.url, 'https://claude.ai/code/session_one');

    // 再次扫描（请求仍不在 Paseo 里）不会把它自动改回已结束
    await setup.runtime.refresh();
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === nativeQ.id)!.state, 'unknown');

    setup.runtime.noteCloudConfirmed({ webSessionId: 'session_one', toolUseId: 'toolu_1', outcome: 'answered' });
    await setup.runtime.refresh();
    nativeQ = setup.runtime.snapshot().questions.find(item => item.id === nativeQ.id)!;
    assert.equal(nativeQ.state, 'resolved');
    assert.equal(nativeQ.reason, '云端已记录结果');
    assert.equal(isQuestionTodo(nativeQ), false);
  } finally { await setup.close(); }
});

test('网页作答已提交时不改人工待办；页面未打开时提示在 claude.ai 作答', async () => {
  const setup = await fixture(async () => online());
  try {
    setup.agents.push(cloudAgent([cloudRequest()]));
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online', speechEnabled: false });
    await setup.runtime.refresh();
    const id = setup.runtime.snapshot().questions.find(item => item.source === 'native')!.id;
    await setup.runtime.answer({ id, answers: answer });
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === id)!.state, 'submitted');
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'submitted' } });
    await setup.runtime.refresh();
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === id)!.state, 'submitted');
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'page_not_open' } });
    await setup.runtime.refresh();
    const question = setup.runtime.snapshot().questions.find(item => item.id === id)!;
    assert.equal(question.state, 'unknown');
    assert.match(question.reason, /claude\.ai 页面没有打开/);
    // 不认识的请求不改任何条目
    setup.runtime.noteWebResult({ webSessionId: 'session_other', toolUseId: 'toolu_x', result: { status: 'unknown', detail: 'no_receipt' } });
  } finally { await setup.close(); }
});

function executorEnv() {
  let now = 1_700_000_000_000;
  const states = new Map<string, { state: 'pending' | 'submitted' | 'resolved' | 'unknown'; queued: boolean; browserSubmittedAt?: string }>();
  const webResults: unknown[] = [];
  const confirmations: unknown[] = [];
  const question: BrowserQuestion = { id: 'bq-1', sessionId: 'abc123', fingerprint: 'fp-1', toolUseId: 'toolu_01', prompts: [{ question: 'Which environment?', header: 'Env', multiSelect: false, allowOther: true, options: [{ label: 'Staging', description: '', recommended: true }, { label: 'Prod', description: '', recommended: false }] }] };
  states.set('cand-1', { state: 'pending', queued: false });
  const runtime: WebRequestRuntimePort & { noteWebResult(input: unknown): void; noteCloudConfirmed(input: unknown): void } = {
    browserCandidates: () => [{ id: 'cand-1', question, seen: now, state: states.get('cand-1')!.state, observed: true }],
    isSessionObserved: () => true,
    delegateBrowserAnswer: () => { states.get('cand-1')!.queued = true; return true; },
    cancelBrowserDecision: () => { states.get('cand-1')!.queued = false; },
    browserState: id => states.get(id) ?? null,
    noteWebResult: input => { webResults.push(input); },
    noteCloudConfirmed: input => { confirmations.push(input); },
  };
  let onSleep: (current: number) => void = () => {};
  return {
    states, webResults, confirmations, runtime,
    get now() { return now; },
    setOnSleep(fn: (current: number) => void) { onSleep = fn; },
    bridge: { sessions: () => [{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: now }] },
    options: { clock: () => now, sleep: async (ms: number) => { now += ms; onSleep(now); await new Promise(resolve => setImmediate(resolve)); } },
  };
}
const request = { webSessionId: 'session_abc123', toolUseId: 'toolu_01', kind: 'question' as const, answers: { 'Which environment?': ['Prod'] }, expected: { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which environment?', header: 'Env', multiSelect: false, options: [{ label: 'Staging', description: '' }, { label: 'Prod', description: '' }] }] } } };

test('执行器把网页结果和云端确认交给在线离线问答；审计保留首个网页结果，迟到回执另记且无需等云端确认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-answer-exec-'));
  try {
    const env = executorEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);
    const start = env.now;
    env.setOnSleep(current => { if (current - start === 500) env.states.get('cand-1')!.state = 'submitted'; });
    assert.deepEqual(await executor.answerWebRequest(request), { status: 'unknown', detail: 'no_receipt' });
    assert.deepEqual(env.webResults, [{ webSessionId: 'session_abc123', toolUseId: 'toolu_01', result: { status: 'unknown', detail: 'no_receipt' } }]);
    const first = (await executor.audit()).entries.at(-1)!;
    const firstSubmitted = structuredClone(first.webSubmitted);
    assert.equal(firstSubmitted?.detail, 'no_receipt');

    // 迟到回执：扩展结果未知。执行器自己的跟踪循环发现它，不需要等云端确认
    env.states.get('cand-1')!.state = 'unknown';
    for (let i = 0; i < 20 && !(await executor.audit()).entries.at(-1)!.lateReceipt; i++) await env.options.sleep(1000);
    let entry = (await executor.audit()).entries.at(-1)!;
    assert.deepEqual(entry.webSubmitted, firstSubmitted);
    assert.equal(entry.lateReceipt?.status, 'unknown');
    assert.equal(entry.lateReceipt?.detail, 'page_unknown');

    executor.confirmCloud({ webSessionId: 'session_abc123', toolUseId: 'toolu_01', outcome: 'answered' });
    await executor.audit();
    entry = (await executor.audit()).entries.at(-1)!;
    assert.deepEqual(entry.webSubmitted, firstSubmitted);
    assert.equal(entry.cloudConfirmed?.outcome, 'answered');
    assert.deepEqual(env.confirmations, [{ webSessionId: 'session_abc123', toolUseId: 'toolu_01', outcome: 'answered' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('迟到回执为已提交时另记 lateReceipt.status = submitted，并通知在线离线问答', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-answer-exec-late-'));
  try {
    const env = executorEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);
    const start = env.now;
    env.setOnSleep(current => { if (current - start === 500) env.states.get('cand-1')!.state = 'submitted'; });
    assert.deepEqual(await executor.answerWebRequest(request), { status: 'unknown', detail: 'no_receipt' });
    const lateAt = new Date(env.now + 2000).toISOString();
    env.states.get('cand-1')!.browserSubmittedAt = lateAt;
    for (let i = 0; i < 20 && !(await executor.audit()).entries.at(-1)!.lateReceipt; i++) await env.options.sleep(1000);
    const entry = (await executor.audit()).entries.at(-1)!;
    assert.equal(entry.webSubmitted?.detail, 'no_receipt');
    assert.deepEqual(entry.lateReceipt, { at: lateAt, status: 'submitted' });
    assert.deepEqual(env.webResults.at(-1), { webSessionId: 'session_abc123', toolUseId: 'toolu_01', result: { status: 'submitted' }, late: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- PR #12 审阅（#1704 评论 6733092094）第 1–6 项 ----

async function retryFixture(clock = Date.now) {
  const directory = await mkdtemp(join(tmpdir(), 'web-answer-retry-'));
  const agents: QuestionAgent[] = [cloudAgent([cloudRequest()])];
  const port: PresencePort = {
    list: async () => structuredClone(agents), refresh: async id => structuredClone(agents.find(item => item.id === id) ?? null),
    respond: async () => {}, observe: async () => online(),
    speak: async () => ({ played: true, engine: 'neural' }), cancelSpeech: async () => {}, hosts: async () => [],
  };
  const runtime = new PresenceRuntime(directory, port, clock, new WebRequestLedger());
  await runtime.start();
  await runtime.configure({ ...runtime.snapshot().settings, mode: 'online', speechEnabled: false });
  await runtime.refresh();
  const nativeId = runtime.snapshot().questions.find(item => item.source === 'native')!.id;
  // 用户在 Paseo 原生界面作答后，Paseo 不再列出该请求
  agents[0]!.pendingPermissions = [];
  await runtime.refresh();
  return { runtime, agents, nativeId, close: async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); } };
}
const settle = async (runtime: PresenceRuntime) => { await runtime.refresh(); };

async function todoItems(runtime: PresenceRuntime) {
  const { TodoRuntime } = await import('../server/todo.ts');
  const todo = new TodoRuntime({
    selfHost: async () => ({ id: 'srv-mini', name: 'Mac mini' }), hosts: async () => [{ id: 'srv-mini', name: 'Mac mini', online: true }],
    presence: async () => runtime.snapshot(), browser: async () => null, stalled: async () => null,
    remoteLocal: async () => { throw new Error('no remote'); }, remoteAct: async () => ({ ok: false, message: 'no' }),
    answerQuestion: async () => ({}), markQuestionRead: async () => ({}),
  });
  return (await todo.local()).items;
}

test('审阅 1：网页作答未确认的云端提问出现在待办列表，带原因和原网页链接，不带作答表单；侧栏备用计数也算它', async () => {
  const setup = await retryFixture();
  try {
    assert.deepEqual(await todoItems(setup.runtime), []);
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'unknown', detail: 'no_receipt' } });
    await settle(setup.runtime);
    const items = await todoItems(setup.runtime);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, 'web');
    // 沿用已有标签，旧版插件解析远端待办时不会因未知标签整包失败（复审第二轮第 1 项）
    assert.equal(items[0]!.label, '网页等待');
    assert.match(items[0]!.text, /^【网页重试】/);
    const { TodoLabelSchema } = await import('../shared/todo.ts');
    assert.equal((TodoLabelSchema.options as readonly string[]).includes('网页重试'), false);
    assert.equal(items[0]!.url, 'https://claude.ai/code/session_one');
    assert.match(items[0]!.text, /请在 claude\.ai 重试/);
    assert.equal(items[0]!.question, undefined);
    const { computeTodoCount } = await import('../client/sidebar-state.ts');
    assert.equal(computeTodoCount({ todo: null, presence: setup.runtime.snapshot(), stalled: null, escalation: null } as any), 1);
  } finally { await setup.close(); }
});

test('审阅 2：已有云端确认时不再把提问重新打开（执行器不回写，问答侧也跳过）', async () => {
  const setup = await retryFixture();
  try {
    setup.runtime.noteCloudConfirmed({ webSessionId: 'session_one', toolUseId: 'toolu_1', outcome: 'answered' });
    await settle(setup.runtime);
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'unknown', detail: 'not_claimed' } });
    await settle(setup.runtime);
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === setup.nativeId)!.state, 'resolved');
    assert.deepEqual(await todoItems(setup.runtime), []);
  } finally { await setup.close(); }

  const dir = await mkdtemp(join(tmpdir(), 'web-answer-exec-confirmed-'));
  try {
    const env = executorEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);
    // 答案排队期间用户在网页上手动作答，云端先确认；执行器 20 秒后返回“未及时领取”
    let confirmed = false;
    env.setOnSleep(() => { if (!confirmed) { confirmed = true; executor.confirmCloud({ webSessionId: 'session_abc123', toolUseId: 'toolu_01', outcome: 'answered' }); } });
    assert.deepEqual(await executor.answerWebRequest(request), { status: 'unknown', detail: 'not_claimed' });
    assert.deepEqual(env.webResults, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('审阅 2：网页重试的提问在完整扫描里已不在页面上时自动结束，超过 2 小时也自动结束', async () => {
  let now = Date.now();
  const setup = await retryFixture(() => now);
  try {
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'unknown', detail: 'no_receipt' } });
    await settle(setup.runtime);
    // 页面仍显示这道提问：保留
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === setup.nativeId)!.state, 'unknown');
    // 完整扫描该会话，页面上已没有这道提问：结束
    await setup.runtime.browserSync('browser-one', [], [], syncSessions, ['one']);
    let question = setup.runtime.snapshot().questions.find(item => item.id === setup.nativeId)!;
    assert.equal(question.state, 'resolved');
    assert.match(question.reason, /网页上已没有这道提问/);

    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'page_not_open' } });
    await settle(setup.runtime);
    assert.equal(setup.runtime.snapshot().questions.find(item => item.id === setup.nativeId)!.state, 'unknown');
    now += 2 * 60 * 60_000 + 1000;
    await settle(setup.runtime);
    question = setup.runtime.snapshot().questions.find(item => item.id === setup.nativeId)!;
    assert.equal(question.state, 'resolved');
    assert.match(question.reason, /超过 2 小时/);
  } finally { await setup.close(); }
});

test('审阅 3：页面未打开时提问进入网页重试，之后打开页面，网页提问关联到它，待办只有一条', async () => {
  const setup = await retryFixture();
  try {
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'page_not_open' } });
    await settle(setup.runtime);
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    await settle(setup.runtime);
    const browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(browserQ.delegatedTo, setup.nativeId);
    const items = await todoItems(setup.runtime);
    assert.equal(items.length, 1, JSON.stringify(items.map(item => item.label)));
    assert.equal(items[0]!.label, '网页等待');
    assert.match(items[0]!.text, /^【网页重试】/);
    // 备用计数也只算一条（已关联的网页提问不重复计数，复审第二轮第 3 项）
    const { computeTodoCount } = await import('../client/sidebar-state.ts');
    assert.equal(computeTodoCount({ todo: null, presence: setup.runtime.snapshot(), stalled: null, escalation: null } as any), 1);
  } finally { await setup.close(); }
});

test('审阅 5：同步请求里点同意记录带未知字段或未知取值时不整条拒绝，丢弃未知部分', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-answer-bridge-loose-'));
  const bridge = new BrowserBridge(directory, async () => null);
  try {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!address || typeof address === 'string') throw new Error('port');
    await bridge.start(); await bridge.configure({ enabled: true, port: address.port });
    const pairing = await bridge.pairing();
    const approval = { sessionId: 'abc', reservationId: 'r-1', digest: 'b'.repeat(64), button: 'Allow once', at: new Date().toISOString(), status: 'dismissed', readGate: 'read_gate_future', futureField: 1 };
    const response = await fetch(pairing.url, { method: 'POST', headers: { origin: `chrome-extension://${'a'.repeat(32)}`, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instanceId: 'one', sessions: [], approvals: [approval] }) });
    assert.equal(response.status, 200);
    const stored = bridge.snapshot().approvals?.[0] as Record<string, unknown>;
    assert.equal(stored.reservationId, 'r-1');
    assert.equal('futureField' in stored, false);
    assert.equal(stored.readGate, undefined);
  } finally { await bridge.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('审阅 6：下发答案写盘期间执行器看到的状态始终是“排队中”或“已下发”，不会误判未领取', async () => {
  const setup = await fixture(async () => online());
  try {
    setup.agents.push(cloudAgent([cloudRequest()]));
    await setup.runtime.refresh();
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    const browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), true);
    let done = false;
    const seen: string[] = [];
    const sync = setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']).finally(() => { done = true; });
    while (!done) {
      const state = setup.runtime.browserState(browserQ.id)!;
      seen.push(`${state.state}:${state.queued}`);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await sync).length, 1);
    assert.ok(!seen.includes('pending:false'), seen.join(','));
  } finally { await setup.close(); }
});

test('复审第二轮第 2 项：网页重试未经云端确认就超时结束时，清掉网页提问的关联标记，网页提问重新出现在待办', async () => {
  let now = Date.now();
  const setup = await retryFixture(() => now);
  try {
    setup.runtime.noteWebResult({ webSessionId: 'session_one', toolUseId: 'toolu_1', result: { status: 'page_not_open' } });
    await settle(setup.runtime);
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    assert.equal(setup.runtime.snapshot().questions.find(item => item.source === 'browser')!.delegatedTo, setup.nativeId);
    now += 2 * 60 * 60_000 + 1000;
    await settle(setup.runtime);
    await setup.runtime.browserSync('browser-one', [webpage()], [], syncSessions, ['one']);
    const browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(browserQ.delegatedTo, undefined);
    const items = await todoItems(setup.runtime);
    assert.deepEqual(items.map(item => item.label), ['网页提问']);
  } finally { await setup.close(); }
});
