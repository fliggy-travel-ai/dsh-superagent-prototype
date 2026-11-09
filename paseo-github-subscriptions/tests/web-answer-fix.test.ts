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
