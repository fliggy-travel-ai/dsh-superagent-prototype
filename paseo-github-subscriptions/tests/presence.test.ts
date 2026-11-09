import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { AgentPermissionResponseSchema } from '@getpaseo/protocol/messages';
import { ProviderInputSchema } from '@getpaseo/plugin/server/provider';
import { PresenceRuntime, type PresencePort, type QuestionAgent } from '../server/presence.ts';
import { nativePrompts, nativeResponse, recommendedAnswers, validateAnswers } from '../server/questions.ts';
import { summarizeWebAnswer, WebRequestLedger } from '../server/web-request/ledger.ts';
import { isQuestionTodo, isUnreadAutomaticAnswer, QuestionSchema, type BrowserQuestion } from '../shared/presence.ts';
import type { SpeechResult } from '../shared/speech.ts';

const prompt = { question: '先验证哪个模块？', header: '验证范围', multiSelect: false, options: [{ label: '当前模块（推荐）', description: '', recommended: true }, { label: '所有模块', description: '', recommended: false }] };
const request = (): AgentPermissionRequest => ({ id: 'request-one', provider: 'claude', kind: 'question', name: 'AskUserQuestion', input: { questions: [structuredClone(prompt)] } });
const agent = (): QuestionAgent => ({ id: 'agent-one', title: '实现插件', pendingPermissions: [request()] });
const webpage = (sessionId = 'session_one'): BrowserQuestion => ({ id: 'web-question', sessionId, fingerprint: 'stable-fingerprint', prompts: [structuredClone(prompt)] });
const sessions = [{ sessionId: 'session_one', title: '网页开发', url: 'https://claude.ai/code/session_one' }, { sessionId: 'session_two', title: '另一网页', url: 'https://claude.ai/code/session_two' }];
const answer = { [prompt.question]: [prompt.options[0].label] };

test('验收方式和合并建议不能作为用户本人授权自动选择', () => {
  for (const question of ['验收方式如何选择？', '按现在的证据验收（推荐）', '记为已知限制，先合并（推荐）', '是否合并 PR #1706？', 'Merge pull request after checks?']) {
    const prompts = [{ ...prompt, question }];
    assert.equal(recommendedAnswers(prompts), null);
    assert.deepEqual(nativeResponse({ ...request(), input: { questions: prompts } }, { [question]: [prompt.options[0].label] }), { behavior: 'allow', updatedInput: { answers: { [question]: prompt.options[0].label } } });
  }
  assert.deepEqual(recommendedAnswers([prompt]), answer);
});

test('人工回答完成自动移出，未知结果继续保留', async () => {
  const setup = await fixture();
  try {
    setup.agents.push(agent()); await setup.runtime.refresh();
    const question = setup.runtime.snapshot().questions[0];
    await setup.runtime.answer({ id: question.id, answers: answer });
    const completed = setup.runtime.snapshot().questions[0];
    assert.equal(isQuestionTodo(completed), false);
    assert.equal(completed.answer?.source, 'user');
    assert.deepEqual(completed.answer?.answers, answer);
    assert.equal(isQuestionTodo({ ...completed, state: 'submitted' }), true);
    assert.equal(isQuestionTodo({ ...completed, state: 'unknown' }), true);
    await assert.rejects(setup.runtime.markRead({ id: completed.id, fingerprint: completed.fingerprint }));
  } finally { await setup.close(); }
});

test('代答完成显示选项，已读幂等持久化，重启后不会复活', async () => {
  const setup = await fixture();
  try {
    setup.agents.push(agent());
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    const question = setup.runtime.snapshot().questions[0];
    assert.equal(isUnreadAutomaticAnswer(question), true);
    assert.deepEqual(question.answer?.answers, answer);
    await assert.rejects(setup.runtime.markRead({ id: question.id, fingerprint: 'changed' }));
    await setup.runtime.markRead({ id: question.id, fingerprint: question.fingerprint });
    const readAt = setup.runtime.snapshot().questions[0].answer?.readAt;
    await setup.runtime.markRead({ id: question.id, fingerprint: question.fingerprint });
    assert.equal(setup.runtime.snapshot().questions[0].answer?.readAt, readAt);
    await setup.runtime.stop();
    const restarted = new PresenceRuntime(setup.directory, setup.port);
    try {
      await restarted.start();
      assert.equal(isQuestionTodo(restarted.snapshot().questions[0]), false);
      assert.equal(setup.responses.length, 1);
    } finally { await restarted.stop(); }
  } finally { await setup.close(); }
});

test('网页点击提交仍保留，只有完整读取同一会话且问题消失才完成', async () => {
  const setup = await fixture();
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions, ['session_one']);
    const question = setup.runtime.snapshot().questions[0];
    await assert.rejects(setup.runtime.markRead({ id: question.id, fingerprint: question.fingerprint }));
    await setup.runtime.browserSync('browser-one', [webpage()], [{ ...webpage(), status: 'submitted' }], sessions, ['session_one']);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'submitted');
    await setup.runtime.browserSync('browser-one', [], [], []);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'submitted');
    await setup.runtime.browserSync('browser-one', [], [], sessions, ['session_two']);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'submitted');
    await setup.runtime.browserSync('browser-one', [], [], sessions, ['session_one']);
    assert.equal(isUnreadAutomaticAnswer(setup.runtime.snapshot().questions[0]), true);
  } finally { await setup.close(); }
});

test('历史已结束的问题不推测代答来源，超过百条的未读代答全部保留', async () => {
  const setup = await fixture();
  try {
    for (let index = 0; index < 105; index++) setup.agents.push({ ...agent(), id: `agent-${index}` });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    assert.equal(setup.runtime.snapshot().questions.filter(isUnreadAutomaticAnswer).length, 105);
    const { answer: _answer, ...legacy } = setup.runtime.snapshot().questions[0];
    assert.equal(isQuestionTodo(QuestionSchema.parse(legacy)), false);
    await setup.runtime.stop();
    const restarted = new PresenceRuntime(setup.directory, setup.port);
    try { await restarted.start(); assert.equal(restarted.snapshot().questions.filter(isUnreadAutomaticAnswer).length, 105); }
    finally { await restarted.stop(); }
  } finally { await setup.close(); }
});

test('设备保存期间读到的旧离线状态在保存结束后失效', async () => {
  for (const saveFails of [false, true]) {
    const current = await fixture();
    let finishSave!: () => void;
    let finishObserve!: (value: Awaited<ReturnType<PresencePort['observe']>>) => void;
    let observationStarted!: () => void;
    const saving = new Promise<void>(resolve => { finishSave = resolve; });
    const observing = new Promise<Awaited<ReturnType<PresencePort['observe']>>>(resolve => { finishObserve = resolve; });
    const started = new Promise<void>(resolve => { observationStarted = resolve; });
    try {
      const snapshot = await current.runtime.snapshot();
      await current.runtime.configure({ ...snapshot.settings, mode: 'auto', paused: false });
      current.agents.push(agent());
      current.port.observe = async () => { observationStarted(); return observing; };
      const change = current.runtime.changeBluetoothTarget(null, (left, right) => left === right, async () => {
        await saving;
        if (saveFails) throw new Error('保存结果未知');
        return 'saved';
      });
      const result = change.then(value => value, error => error.message);
      const scan = current.runtime.refresh();
      await started;
      finishSave();
      await new Promise(resolve => setImmediate(resolve));
      finishObserve({ mode: 'offline', observedAt: new Date().toISOString(), reason: '旧设备离线', source: 'bluetooth' });
      await scan;
      assert.equal(await result, saveFails ? '保存结果未知' : 'saved');
      assert.equal(current.responses.length, 0);
      current.port.observe = async () => ({ mode: 'unknown', observedAt: null, reason: '等待新设备', source: 'bluetooth' });
      await current.runtime.refresh();
      assert.equal(current.responses.length, 0);
      await assert.rejects(current.runtime.changeBluetoothTarget('other-host', (left, right) => left === right, async () => 'unused'), /来源主机/);
    } finally { await current.close(); }
  }
});

async function fixture(overrides: Partial<PresencePort> = {}, clock = Date.now) {
  const directory = await mkdtemp(join(tmpdir(), 'presence-test-'));
  const agents: QuestionAgent[] = [];
  const responses: unknown[] = [];
  const speech: string[] = [];
  const cancels: Array<[string | null, string]> = [];
  const ledger = new WebRequestLedger(clock);
  const port: PresencePort = {
    list: async () => structuredClone(agents), refresh: async id => structuredClone(agents.find(item => item.id === id) ?? null),
    respond: async (...args) => { responses.push(args); }, observe: async () => ({ mode: 'unknown', observedAt: null, reason: '未发现手机', source: 'unavailable' }),
    speak: async (_host, id) => { speech.push(id); return { played: true, engine: 'neural' }; }, cancelSpeech: async (host, id) => { cancels.push([host, id]); }, hosts: async () => [], ...overrides,
  };
  const runtime = new PresenceRuntime(directory, port, clock, ledger);
  await runtime.start();
  return { runtime, directory, agents, responses, speech, cancels, port, ledger, close: async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test('原生问答只接受合法问题，保留提供方的答案映射并支持自由文本与结构化格式', () => {
  assert.deepEqual(nativePrompts(request()), [{ ...prompt, allowOther: true }]);
  assert.deepEqual(nativePrompts({ ...request(), name: 'request_user_input', provider: 'codex' }), [prompt]);
  for (const questions of [[null], [{ ...prompt, options: [null] }], [], [prompt, prompt]]) assert.equal(nativePrompts({ ...request(), input: { questions } }), null);
  assert.equal(nativePrompts({ ...request(), kind: 'tool' }), null);
  assert.deepEqual(nativeResponse(request(), answer), { behavior: 'allow', updatedInput: { answers: { [prompt.question]: prompt.options[0].label } } });
  assert.deepEqual(
    nativeResponse(request(), { [prompt.question]: [] }, { [prompt.question]: '  自定义说明  ' }),
    { behavior: 'allow', updatedInput: { answers: { [prompt.question]: '自定义说明' } } },
  );
  const multiRequest: AgentPermissionRequest = { ...request(), input: { questions: [{ ...prompt, multiSelect: true }] } };
  assert.deepEqual(
    nativeResponse(multiRequest, { [prompt.question]: [prompt.options[0].label, prompt.options[1].label] }, { [prompt.question]: '补充其他' }),
    { behavior: 'allow', updatedInput: { answers: { [prompt.question]: `${prompt.options[0].label}, ${prompt.options[1].label}, 补充其他` } } },
  );
  const cloudMulti: AgentPermissionRequest = { ...multiRequest, provider: 'cloud-session' };
  const cloudResponse = nativeResponse(cloudMulti, { [prompt.question]: [prompt.options[0].label] }, { [prompt.question]: '  云端其他  ' });
  assert.deepEqual(cloudResponse, {
    behavior: 'allow',
    updatedInput: {
      answers: { [prompt.question]: [prompt.options[0].label] },
      otherAnswers: { [prompt.question]: '云端其他' },
    },
  });
  // Verify Paseo protocol and provider schemas preserve extra fields in updatedInput intact
  assert.deepEqual(AgentPermissionResponseSchema.parse(cloudResponse), cloudResponse);
  assert.deepEqual(
    ProviderInputSchema.parse({ type: 'session.permission', sessionId: 's1', permissionId: 'p1', response: cloudResponse }),
    { type: 'session.permission', sessionId: 's1', permissionId: 'p1', response: cloudResponse },
  );
  assert.throws(() => validateAnswers([prompt], { [prompt.question]: [] }, { [prompt.question]: '不支持其他' }), /选项已变化/);
  assert.throws(() => validateAnswers([{ ...prompt, allowOther: true }], { [prompt.question]: [prompt.options[0].label] }, { [prompt.question]: '单选互斥' }), /选项已变化/);
  assert.deepEqual(nativeResponse({ ...request(), name: 'request_user_input', provider: 'codex' }, answer), { behavior: 'allow', updatedInput: { answers: { [prompt.header]: prompt.options[0].label } } });
  assert.equal(recommendedAnswers([{ ...prompt, options: prompt.options.map(option => ({ ...option, recommended: false })) }]), null);
  assert.equal(recommendedAnswers([{ ...prompt, question: '请关闭安全验证' }]), null);
});

const cleanupPrompts = [
  { ...prompt, question: '需求已完成，开发沙箱存有测试目录、云端测试日志和验收证据，怎么清理？', options: [{ label: '备份证据后释放（推荐）', description: '先拷贝证据，确认备份后再归档释放。', recommended: true }, { label: '先保留', description: '', recommended: false }] },
  { ...prompt, question: '工作树里面如果还有未提交或未推送的改动，怎么处理？', options: [{ label: '逐个审查后决定（推荐）', description: '先列出内容：运行数据、生成物直接丢弃；手写内容再问。', recommended: true }, { label: '全部保留', description: '', recommended: false }] },
];

test('备份后释放和先审查再丢弃仍需人工确认，整组问题不自动作答', () => {
  for (const question of cleanupPrompts) assert.equal(recommendedAnswers([question]), null);
  assert.equal(recommendedAnswers([prompt, ...cleanupPrompts]), null);
  for (const question of ['Delete the sandbox after backing up evidence?', 'Remove the worktree and discard uncommitted changes?', '删除数据库备份？', '清空云端测试日志？', 'Run git reset --hard?', '登录账号并输入验证码？', 'Grant admin access?', '支付续费并充值？', 'Transfer funds now?']) {
    assert.equal(recommendedAnswers([{ ...prompt, question }]), null, question);
  }
  for (const question of ['先验证哪个模块？', '修复内存释放逻辑后运行测试？', '先重录并遮挡店铺名？']) {
    assert.deepEqual(recommendedAnswers([{ ...prompt, question }]), { [question]: [prompt.options[0].label] });
  }
});

test('离线模式下原生与网页资源清理保留待办，用户仍可显式回答', async () => {
  const setup = await fixture();
  try {
    const native = { ...request(), input: { questions: cleanupPrompts } };
    setup.agents.push({ ...agent(), pendingPermissions: [native] });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    const decisions = await setup.runtime.browserSync('browser-one', [{ ...webpage(), prompts: cleanupPrompts }], [], sessions, ['session_one']);
    await setup.runtime.refresh();
    assert.deepEqual(decisions, []);
    assert.equal(setup.responses.length, 0);
    const questions = setup.runtime.snapshot().questions;
    assert.equal(questions.length, 2);
    for (const question of questions) {
      assert.equal(question.state, 'pending');
      assert.equal(question.answer, undefined);
      assert.match(question.reason ?? '', /资源清理.*人工确认/);
      assert.equal(isQuestionTodo(question), true);
    }
    const manual = questions.find(question => question.source === 'native')!;
    await setup.runtime.answer({ id: manual.id, answers: Object.fromEntries(cleanupPrompts.map(question => [question.question, [question.options[0].label]])) }, true);
    assert.equal(setup.responses.length, 0);
    await setup.runtime.answer({ id: manual.id, answers: Object.fromEntries(cleanupPrompts.map(question => [question.question, [question.options[1].label]])) });
    assert.equal(setup.responses.length, 1);
    assert.equal(setup.runtime.snapshot().questions.find(question => question.id === manual.id)?.answer?.source, 'user');
  } finally { await setup.close(); }
});

test('异步原生提问按宿主标题回传多题答案，逗号标签保持完整且仅代答一次', async () => {
  const setup = await fixture();
  const questions = [
    { id: '0', header: 'Question 1', question: '先验证哪个模块？', options: [{ label: '当前模块（推荐）' }, { label: '所有模块' }], isOther: true },
    { id: '1', header: 'Question 2', question: '验证后做什么？', options: [{ label: '记录结果, 等待审核（推荐）' }, { label: '继续修改' }], isOther: true },
  ];
  try {
    setup.agents.push({ ...agent(), pendingPermissions: [{ ...request(), provider: 'codex', name: 'request_user_input_async', input: { questions } }] });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    await setup.runtime.refresh();
    assert.deepEqual(setup.responses, [['agent-one', 'request-one', { behavior: 'allow', updatedInput: { answers: { 'Question 1': '当前模块（推荐）', 'Question 2': '记录结果, 等待审核（推荐）' } } }]]);
    const question = setup.runtime.snapshot().questions[0];
    assert.equal(question.state, 'resolved');
    assert.equal(isUnreadAutomaticAnswer(question), true);
    assert.equal(question.prompts[0].multiSelect, false);
    assert.equal(question.prompts[0].options[0].description, '');
  } finally { await setup.close(); }
});

test('异步提问没有推荐项时留人工，人工完成后移出待办', async () => {
  const setup = await fixture();
  const questions = [{ id: '0', header: 'Question 1', question: '先验证哪个模块？', options: [{ label: '当前模块' }, { label: '所有模块' }], isOther: true }];
  try {
    setup.agents.push({ ...agent(), pendingPermissions: [{ ...request(), provider: 'codex', name: 'request_user_input_async', input: { questions } }] });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    const question = setup.runtime.snapshot().questions[0];
    assert.equal(question.state, 'pending');
    assert.equal(isQuestionTodo(question), true);
    assert.equal(setup.responses.length, 0);
    await setup.runtime.answer({ id: question.id, answers: { '先验证哪个模块？': ['所有模块'] } });
    assert.deepEqual(setup.responses, [['agent-one', 'request-one', { behavior: 'allow', updatedInput: { answers: { 'Question 1': '所有模块' } } }]]);
    assert.equal(isQuestionTodo(setup.runtime.snapshot().questions[0]), false);
  } finally { await setup.close(); }
});

test('在线只提醒一次，语音播放不会阻塞网页同步', async () => {
  let finishSpeech!: () => void;
  let speeches = 0;
  const playback = new Promise<void>(resolve => { finishSpeech = resolve; });
  const setup = await fixture({ speak: async () => { speeches++; await playback; return { played: true }; } });
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online' });
    const decisions = await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    assert.deepEqual(decisions, []);
    assert.equal(speeches, 1);
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    assert.equal(speeches, 1);
    assert.equal(setup.responses.length, 0);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'pending');
  } finally { finishSpeech(); await setup.close(); }
});

test('语音失败提示在刷新后保留，下次成功播放后清除', async () => {
  let unavailable = true;
  let attempts = 0;
  let now = Date.now();
  const setup = await fixture({ speak: async () => { attempts++; if (unavailable) throw new Error('来源主机离线'); return { played: true }; } }, () => now);
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online' });
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    await setup.runtime.refresh();
    assert.match(setup.runtime.snapshot().error ?? '', /未收到语音播放回执/);
    assert.equal(attempts, 1);
    unavailable = false;
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    assert.equal(attempts, 1);
    now += 180_001;
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    await setup.runtime.refresh();
    assert.equal(setup.runtime.snapshot().error, null);
    assert.equal(attempts, 2);
  } finally { await setup.close(); }
});

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check());
}

test('关闭语音或问题结束时取消当前语音，取消回执不计失败冷却', async () => {
  const spoken: string[] = [];
  const cancels: Array<[string | null, string]> = [];
  let finish: ((value: SpeechResult) => void) | undefined;
  const setup = await fixture({
    speak: async (_host, id) => { spoken.push(id); return new Promise<SpeechResult>(resolve => { finish = resolve; }); },
    cancelSpeech: async (host, id) => { cancels.push([host, id]); finish?.({ played: false, cancelled: true, detail: '语音播放已取消' }); },
  }, () => 1_000_000);
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online' });
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    const id = setup.runtime.snapshot().questions[0].id;
    assert.deepEqual(spoken, [id]);
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, speechEnabled: false });
    await eventually(() => setup.runtime.snapshot().speech?.length === 1);
    assert.deepEqual(cancels, [[null, id]]);
    assert.equal(setup.runtime.snapshot().speech?.[0]?.cancelled, true);
    assert.equal(setup.runtime.snapshot().error, null);
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, speechEnabled: true });
    await eventually(() => spoken.length === 2);
    await setup.runtime.browserSync('browser-one', [], [], sessions, ['session_one']);
    await eventually(() => setup.runtime.snapshot().speech?.length === 2);
    assert.deepEqual(cancels, [[null, id], [null, id]]);
    assert.equal(setup.runtime.snapshot().error, null);
  } finally { finish?.({ played: false, cancelled: true }); await setup.close(); }
});

test('切换来源主机后，旧主机的失败回执只记历史，不影响新主机提醒', async () => {
  const calls: Array<string | null> = [];
  const pending: Array<(value: SpeechResult) => void> = [];
  const setup = await fixture({
    speak: async host => { calls.push(host); return new Promise<SpeechResult>(resolve => { pending.push(resolve); }); },
    cancelSpeech: async () => {},
  }, () => 1_000_000);
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online', sourceHostId: 'old-host' });
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, sourceHostId: 'new-host' });
    pending[0]({ played: false, detail: '旧主机播放失败', retryAt: 9_000_000 });
    await eventually(() => setup.runtime.snapshot().speech?.length === 1);
    assert.equal(setup.runtime.snapshot().error, null);
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    await eventually(() => calls.length === 2);
    assert.deepEqual(calls, ['old-host', 'new-host']);
  } finally { for (const resolve of pending) resolve({ played: false, cancelled: true }); await setup.close(); }
});

test('离线自动回答明确推荐，未知蓝牙状态保留待办', async () => {
  const setup = await fixture();
  try {
    setup.agents.push(agent());
    await setup.runtime.refresh();
    assert.equal(setup.responses.length, 0);
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    assert.equal(setup.responses.length, 1);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'resolved');
    await setup.runtime.refresh();
    assert.equal(setup.responses.length, 1);
  } finally { await setup.close(); }
});

test('过期蓝牙离线状态不能触发回答', async () => {
  const setup = await fixture({ observe: async () => ({ mode: 'offline', observedAt: new Date(Date.now() - 121_000).toISOString(), reason: '旧状态', source: 'manual' }) });
  try { setup.agents.push(agent()); await setup.runtime.refresh(); assert.equal(setup.runtime.snapshot().observation.mode, 'unknown'); assert.equal(setup.responses.length, 0); }
  finally { await setup.close(); }
});

test('网页人工答案等待同步时不提前消耗五秒有效期', async () => {
  const setup = await fixture();
  const originalNow = Date.now;
  try {
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    const question = setup.runtime.snapshot().questions[0];
    await setup.runtime.answer({ id: question.id, answers: answer });
    assert.equal(setup.runtime.snapshot().questions[0].state, 'pending');
    await assert.rejects(setup.runtime.answer({ id: question.id, answers: answer }), /排队/);
    Date.now = () => originalNow() + 20_000;
    const decisions = await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    assert.equal(decisions.length, 1);
    assert.ok(decisions[0].expiresAt > Date.now());
    assert.equal(setup.runtime.snapshot().questions[0].state, 'submitted');
    assert.deepEqual(await setup.runtime.browserSync('browser-one', [webpage()], [], sessions), []);
    await setup.runtime.browserSync('browser-one', [], [{ ...webpage(), status: 'submitted' }], sessions, ['session_one']);
    assert.equal(setup.runtime.snapshot().questions[0].state, 'resolved');
  } finally { Date.now = originalNow; await setup.close(); }
});

test('暂停取消网页排队回答，相同问题编号不会跨会话混淆', async () => {
  const setup = await fixture();
  try {
    await setup.runtime.browserSync('browser-one', [webpage(), webpage('session_two')], [], sessions);
    const questions = setup.runtime.snapshot().questions;
    assert.equal(questions.length, 2);
    assert.notEqual(questions[0].id, questions[1].id);
    await setup.runtime.answer({ id: questions[0].id, answers: answer });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, paused: true });
    assert.deepEqual(await setup.runtime.browserSync('browser-one', [webpage(), webpage('session_two')], [], sessions), []);
  } finally { await setup.close(); }
});

test('原生回执失败标记未知，重启后不会重试', async () => {
  let submissions = 0;
  const setup = await fixture({ respond: async () => { submissions++; throw new Error('timeout'); } });
  try {
    setup.agents.push(agent());
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    assert.equal(setup.runtime.snapshot().questions[0].state, 'unknown');
    await setup.runtime.stop();
    const restarted = new PresenceRuntime(setup.directory, setup.port);
    try { await restarted.start(); assert.equal(submissions, 1); assert.equal(restarted.snapshot().questions[0].state, 'unknown'); }
    finally { await restarted.stop(); }
  } finally { await setup.close(); }
});

test('重启时未确认的网页提交变为未知', async () => {
  const setup = await fixture();
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    assert.equal((await setup.runtime.browserSync('browser-one', [webpage()], [], sessions)).length, 1);
    await setup.runtime.stop();
    const restarted = new PresenceRuntime(setup.directory, setup.port);
    try { await restarted.start(); assert.equal(restarted.snapshot().questions[0].state, 'unknown'); assert.deepEqual(await restarted.browserSync('browser-one', [webpage()], [], sessions), []); }
    finally { await restarted.stop(); }
  } finally { await setup.close(); }
});

test('原生发送前再次核对请求，变化后不批准', async () => {
  const setup = await fixture();
  let reads = 0;
  setup.port.refresh = async () => { const current = agent(); if (++reads === 2) current.pendingPermissions[0].input = { questions: [{ ...prompt, question: '修改后的问题' }] }; return current; };
  try { setup.agents.push(agent()); await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' }); assert.equal(setup.responses.length, 0); assert.equal(setup.runtime.snapshot().questions[0].state, 'pending'); }
  finally { await setup.close(); }
});

test('丢失的网页问题清理待发答案', async () => {
  const setup = await fixture();
  try {
    await setup.runtime.browserSync('browser-one', [webpage()], [], sessions);
    await setup.runtime.answer({ id: setup.runtime.snapshot().questions[0].id, answers: answer });
    await setup.runtime.browserSync('browser-one', [], [], sessions, ['session_one']);
    assert.deepEqual(await setup.runtime.browserSync('browser-one', [webpage()], [], sessions), []);
    const stored = JSON.parse(await readFile(join(setup.directory, 'presence.json'), 'utf8'));
    assert.equal(stored.questions[0].state, 'resolved');
  } finally { await setup.close(); }
});

test('并发网页同步只下发一次答案，停止后不再同步', async () => {
  const setup = await fixture();
  try {
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    const responses = await Promise.all([setup.runtime.browserSync('browser-one', [webpage()], [], sessions), setup.runtime.browserSync('browser-one', [webpage()], [], sessions)]);
    assert.equal(responses.flat().length, 1);
    await setup.runtime.stop();
    assert.deepEqual(await setup.runtime.browserSync('browser-one', [webpage('session_two')], [], sessions), []);
    assert.equal(setup.runtime.snapshot().questions.length, 1);
  } finally { await setup.close(); }
});

test('云端提问离线时自动选明确推荐项、在线时只提醒、拦截词仍生效，答复后保持已提交并在云端关闭后结束，且登记答案来源', async () => {
  const setup = await fixture();
  try {
    const cloudRequest: AgentPermissionRequest = {
      ...request(),
      id: 'toolu_cloud_1',
      provider: 'cloud-session',
      metadata: { cloudSessionManual: true, webSessionId: 'session_one', toolUseId: 'toolu_cloud_1' },
    };
    setup.agents.push({ ...agent(), provider: 'cloud-session', labels: { 'cloud-session.id': 'cse_one' }, pendingPermissions: [cloudRequest] });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online' });
    let question = setup.runtime.snapshot().questions[0];
    assert.equal(question.state, 'pending');
    assert.equal(question.reason, '在线：等待用户回答');
    assert.equal(setup.speech.length, 1);
    assert.equal(setup.responses.length, 0);

    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    question = setup.runtime.snapshot().questions[0];
    assert.equal(question.state, 'submitted');
    assert.equal(question.reason, '已交给浏览器执行，等待云端确认');
    assert.equal(question.answer?.source, 'automatic');
    assert.deepEqual(setup.responses, [[
      'agent-one',
      'toolu_cloud_1',
      { behavior: 'allow', updatedInput: { answers: answer } },
    ]]);
    const autoSummary = summarizeWebAnswer({ kind: 'question', answers: answer });
    assert.equal(setup.ledger.lookup({ webSessionId: 'session_one', toolUseId: 'toolu_cloud_1', digest: autoSummary.digest }), 'automatic');

    setup.agents[0].pendingPermissions = [];
    await setup.runtime.refresh();
    question = setup.runtime.snapshot().questions[0];
    assert.equal(question.state, 'resolved');
    assert.equal(question.reason, '云端已记录结果');
    assert.equal(isUnreadAutomaticAnswer(question), true);

    // Blocked keywords still prevent automatic answer on cloud requests, while manual answer with "other" text succeeds and records source=user
    const sensitivePrompt = { ...prompt, question: '是否合并 PR #1704？' };
    const sensitiveRequest: AgentPermissionRequest = {
      ...cloudRequest,
      id: 'toolu_cloud_2',
      input: { questions: [sensitivePrompt] },
      metadata: { cloudSessionManual: true, webSessionId: 'session_one', toolUseId: 'toolu_cloud_2' },
    };
    setup.agents[0].pendingPermissions = [sensitiveRequest];
    await setup.runtime.refresh();
    const pendingSensitive = setup.runtime.snapshot().questions.find(item => item.state === 'pending')!;
    assert.ok(pendingSensitive);
    assert.match(pendingSensitive.reason, /验收或合并授权/);
    assert.equal(setup.responses.length, 1);

    await setup.runtime.answer({
      id: pendingSensitive.id,
      answers: { [sensitivePrompt.question]: [] },
      otherAnswers: { [sensitivePrompt.question]: '先人工复核后再合并' },
    });
    const manualSubmitted = setup.runtime.snapshot().questions.find(item => item.id === pendingSensitive.id)!;
    assert.equal(manualSubmitted.state, 'submitted');
    assert.equal(manualSubmitted.reason, '已交给浏览器执行，等待云端确认');
    assert.equal(manualSubmitted.answer?.source, 'user');
    assert.deepEqual(manualSubmitted.answer?.otherAnswers, { [sensitivePrompt.question]: '先人工复核后再合并' });
    const manualSummary = summarizeWebAnswer({
      kind: 'question',
      answers: { [sensitivePrompt.question]: [] },
      otherAnswers: { [sensitivePrompt.question]: '先人工复核后再合并' },
    });
    assert.equal(setup.ledger.lookup({ webSessionId: 'session_one', toolUseId: 'toolu_cloud_2', digest: manualSummary.digest }), 'user');
  } finally { await setup.close(); }
});

test('云端会话网页提问在同步前不自动作答，有对应云端提问时设 delegatedTo 并隐藏，delegateBrowserAnswer 受暂停、模式切换和停止约束', async () => {
  const setup = await fixture();
  try {
    setup.agents.push({ id: 'cloud-agent', title: '云端会话', provider: 'cloud-session', labels: { 'cloud-session.id': 'cse_one' }, pendingPermissions: [] });
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });

    // Before cloud hook notifies Paseo: browser question belongs to cloud session -> never auto-answered in offline mode
    const beforeHookDecisions = await setup.runtime.browserSync('browser-one', [webpage('one')], [], [{ sessionId: 'one', title: '网页开发', url: 'https://claude.ai/code/session_one' }], ['one']);
    assert.deepEqual(beforeHookDecisions, []);
    let browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    assert.equal(browserQ.state, 'pending');
    assert.equal(browserQ.reason, '云端会话提问，等待同步到 Paseo；只接受人工回答');
    assert.equal(browserQ.delegatedTo, undefined);
    assert.equal(isQuestionTodo(browserQ), true);

    // Cloud hook notifies Paseo with matching question -> browser question gets delegatedTo and is hidden from todo list
    const cloudRequest: AgentPermissionRequest = {
      ...request(),
      id: 'toolu_1',
      provider: 'cloud-session',
      metadata: { cloudSessionManual: true, webSessionId: 'session_one', toolUseId: 'toolu_1' },
    };
    setup.agents[0].pendingPermissions = [cloudRequest];
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online', speechEnabled: false });
    browserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser')!;
    const nativeQ = setup.runtime.snapshot().questions.find(item => item.source === 'native')!;
    assert.equal(browserQ.delegatedTo, nativeQ.id);
    assert.equal(isQuestionTodo(browserQ), false);
    assert.equal(isQuestionTodo(nativeQ), true);

    // Check browserCandidates, delegateBrowserAnswer, and browserState constraints
    const candidates = setup.runtime.browserCandidates('browser-one', 'one');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.id, browserQ.id);
    assert.equal(candidates[0]!.observed, true);

    // Paused -> automatic delegation returns false, manual delegation and manual answer still work
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, paused: true });
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'automatic'), false);
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), true);
    setup.runtime.cancelBrowserDecision(browserQ.id);

    // Paused -> manual answer via runtime.answer is queued and dispatched on next browserSync
    const standaloneWeb = webpage('two');
    await setup.runtime.browserSync('browser-two', [standaloneWeb], [], [{ sessionId: 'two', title: '独立网页', url: 'https://claude.ai/code/session_two' }], ['two']);
    const standaloneBrowserQ = setup.runtime.snapshot().questions.find(item => item.source === 'browser' && item.sessionId === 'two')!;
    await setup.runtime.answer({ id: standaloneBrowserQ.id, answers: answer });
    const pausedManualDispatched = await setup.runtime.browserSync('browser-two', [standaloneWeb], [], [{ sessionId: 'two', title: '独立网页', url: 'https://claude.ai/code/session_two' }], ['two']);
    assert.equal(pausedManualDispatched.length, 1);
    assert.equal(pausedManualDispatched[0]!.id, standaloneWeb.id);
    assert.equal(pausedManualDispatched[0]!.source, 'manual');
    assert.deepEqual(pausedManualDispatched[0]!.answers, answer);

    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, paused: false });

    // Mode change after delegation cancels queued decision
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), true);
    assert.equal(setup.runtime.browserState(browserQ.id)?.queued, true);
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'offline' });
    assert.equal(setup.runtime.browserState(browserQ.id)?.queued, false);

    // Normal delegation dispatches decision with source and otherAnswers even in online mode
    await setup.runtime.configure({ ...setup.runtime.snapshot().settings, mode: 'online', speechEnabled: false });
    assert.equal(
      setup.runtime.delegateBrowserAnswer(browserQ.id, { [prompt.question]: [] }, { [prompt.question]: '转交其他' }, 'manual'),
      true,
    );
    const dispatched = await setup.runtime.browserSync('browser-one', [webpage('one')], [], [{ sessionId: 'one', title: '网页开发', url: 'https://claude.ai/code/session_one' }], ['one']);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.source, 'manual');
    assert.deepEqual(dispatched[0]!.answers, { [prompt.question]: [] });
    assert.deepEqual(dispatched[0]!.otherAnswers, { [prompt.question]: '转交其他' });
    assert.equal(setup.runtime.browserState(browserQ.id)?.state, 'submitted');

    // Receipt updates browserSubmittedAt
    await setup.runtime.browserSync('browser-one', [], [{ ...webpage('one'), status: 'submitted' }], [{ sessionId: 'one', title: '网页开发', url: 'https://claude.ai/code/session_one' }], ['one']);
    assert.ok(setup.runtime.browserState(browserQ.id)?.browserSubmittedAt);

    // Stop prevents delegation
    await setup.runtime.stop();
    assert.equal(setup.runtime.delegateBrowserAnswer(browserQ.id, answer, undefined, 'manual'), false);
  } finally { await setup.close(); }
});

test('1737-speech-local 默认值兼容：旧 presence.json 正常读取，来源主机默认开启本机播放，其他主机默认关闭且保持仅向来源主机播报', async () => {
  const { writeFile } = await import('node:fs/promises');
  // 1. 来源主机是本机（MacBook: selfId = srv_macbook，sourceHostId = null 或 srv_macbook）
  const macbookDir = await mkdtemp(join(tmpdir(), 'presence-macbook-'));
  try {
    await writeFile(
      join(macbookDir, 'presence.json'),
      JSON.stringify({
        settings: { mode: 'online', paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' },
        questions: [],
        notified: [],
      }),
    );
    const spokenOnMacbook: Array<string | null> = [];
    const macbookPort: PresencePort = {
      list: async () => [agent()],
      refresh: async () => agent(),
      respond: async () => {},
      observe: async () => ({ mode: 'online', observedAt: new Date().toISOString(), reason: '蓝牙在线', source: 'bluetooth' }),
      speak: async hostId => { spokenOnMacbook.push(hostId); return { played: true, engine: 'neural' }; },
      cancelSpeech: async () => {},
      hosts: async () => [
        { id: 'srv_macbook', name: 'MacBook', online: true },
        { id: 'srv_mini', name: 'Mac Mini', online: true },
      ],
      selfId: () => 'srv_macbook',
      remoteSpeechEnabled: async hostId => hostId === 'srv_macbook',
    };
    const macbook = new PresenceRuntime(macbookDir, macbookPort);
    await macbook.start();
    try {
      assert.equal(macbook.localSpeechEnabled(), true, '来源主机升级后默认“在这台电脑播放”为开');
      assert.equal(macbook.snapshot().localSpeechEnabled, true);
      assert.equal(macbook.snapshot().hostName, 'MacBook');
      await eventually(() => spokenOnMacbook.length === 1);
      assert.deepEqual(spokenOnMacbook, ['srv_macbook']);
    } finally {
      await macbook.stop();
    }
  } finally {
    await rm(macbookDir, { recursive: true, force: true });
  }

  // 2. 非来源主机（Mac Mini: selfId = srv_mini，sourceHostId = srv_macbook）
  const miniDir = await mkdtemp(join(tmpdir(), 'presence-mini-'));
  try {
    await writeFile(
      join(miniDir, 'presence.json'),
      JSON.stringify({
        settings: { mode: 'online', paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' },
        questions: [],
        notified: [],
      }),
    );
    const spokenFromMini: Array<string | null> = [];
    const miniPort: PresencePort = {
      list: async () => [agent()],
      refresh: async () => agent(),
      respond: async () => {},
      observe: async () => ({ mode: 'online', observedAt: new Date().toISOString(), reason: '蓝牙在线', source: 'bluetooth' }),
      speak: async hostId => { spokenFromMini.push(hostId); return { played: true, engine: 'neural' }; },
      cancelSpeech: async () => {},
      hosts: async () => [
        { id: 'srv_mini', name: 'Mac Mini', online: true },
        { id: 'srv_macbook', name: 'MacBook', online: true },
      ],
      selfId: () => 'srv_mini',
      remoteSpeechEnabled: async hostId => hostId === 'srv_macbook',
    };
    const mini = new PresenceRuntime(miniDir, miniPort);
    await mini.start();
    try {
      assert.equal(mini.localSpeechEnabled(), false, '非来源主机升级后默认“在这台电脑播放”为关');
      assert.equal(mini.snapshot().localSpeechEnabled, false);
      assert.equal(mini.snapshot().hostName, 'Mac Mini');
      await eventually(() => spokenFromMini.length === 1);
      assert.deepEqual(spokenFromMini, ['srv_macbook'], 'Mac Mini 未手动开启时仍只在 MacBook 播放');
    } finally {
      await mini.stop();
    }
  } finally {
    await rm(miniDir, { recursive: true, force: true });
  }
});

test('1737-speech-local 本机开/关与跨主机目标集合：向所有开启主机各播一次、离线与超时主机跳过且不阻塞、切换即持久化', async () => {
  let now = 1_000_000;
  const dir = await mkdtemp(join(tmpdir(), 'presence-multi-target-'));
  const spoken: Array<[string | null, string]> = [];
  const queriedRemote: string[] = [];
  const questionsList: QuestionAgent[] = [];
  const port: PresencePort = {
    list: async () => structuredClone(questionsList),
    refresh: async id => structuredClone(questionsList.find(a => a.id === id) ?? null),
    respond: async () => {},
    observe: async () => ({ mode: 'online', observedAt: new Date().toISOString(), reason: '在线', source: 'bluetooth' }),
    speak: async (hostId, id) => { spoken.push([hostId, id]); return { played: true, engine: 'neural' }; },
    cancelSpeech: async () => {},
    hosts: async () => [
      { id: 'srv_mini', name: 'Mac Mini', online: true },
      { id: 'srv_macbook', name: 'MacBook', online: true },
      { id: 'srv_offline', name: '离线开发机', online: false },
      { id: 'srv_timeout', name: '超时主机', online: true },
      { id: 'srv_muted', name: '静音主机', online: true },
    ],
    selfId: () => 'srv_mini',
    remoteSpeechEnabled: async hostId => {
      queriedRemote.push(hostId);
      if (hostId === 'srv_offline') throw new Error('不应查询离线主机');
      if (hostId === 'srv_timeout') throw new Error('来源主机响应超时');
      return hostId === 'srv_macbook';
    },
  };
  const runtime = new PresenceRuntime(dir, port, () => now);
  await runtime.start();
  try {
    await runtime.configure({ mode: 'online', paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' });
    assert.equal(runtime.snapshot().localSpeechEnabled, false);

    // 开启 Mac Mini 本机播放：立即保存，无需重载
    const afterEnable = await runtime.configureLocalSpeech(true);
    assert.equal(afterEnable.localSpeechEnabled, true);
    const savedDisk = JSON.parse(await readFile(join(dir, 'presence.json'), 'utf8'));
    assert.equal(savedDisk.localSpeechEnabled, true);

    // 新提问到达：本机（srv_mini）与远端开启主机（srv_macbook）各播一次，不因 hosts 含本机而重复播两次
    questionsList.push(agent());
    await runtime.refresh();
    await eventually(() => (runtime.snapshot().speech?.length ?? 0) === 2);
    assert.equal(queriedRemote.includes('srv_offline'), false, '离线主机应直接跳过不发 RPC');
    assert.deepEqual(
      spoken.map(([h]) => h),
      ['srv_mini', 'srv_macbook'],
      '应向本机和开启的远端主机各播一次，跳过离线/超时/关闭主机',
    );
    assert.deepEqual(
      runtime.snapshot().speech?.map(s => [s.hostId, s.played]),
      [['srv_mini', true], ['srv_macbook', true]],
    );

    // 关闭 Mac Mini 本机播放后，新提问只向 srv_macbook 播报
    const afterDisable = await runtime.configureLocalSpeech(false);
    assert.equal(afterDisable.localSpeechEnabled, false);
    now += 180_001;
    questionsList.push({ ...agent(), id: 'agent-two', pendingPermissions: [{ ...request(), id: 'request-two' }] });
    await runtime.refresh();
    await eventually(() => spoken.length === 3);
    assert.equal(spoken[2]![0], 'srv_macbook');
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('1737-speech-local 任一成功即 notified 且重启不误报错误；全部失败才记 speechError 并按冷却重试；关闭本机开关只取消本机在播语音', async () => {
  let now = 2_000_000;
  const dir = await mkdtemp(join(tmpdir(), 'presence-partial-ok-'));
  const questionsList: QuestionAgent[] = [agent()];
  let hostResults: Record<string, SpeechResult> = {
    srv_mini: { played: true, engine: 'neural' },
    srv_macbook: { played: false, detail: '远端声卡忙', retryAt: now + 5000 },
  };
  let speakCalls: string[] = [];
  const cancels: Array<[string | null, string]> = [];
  let holdMini: ((res: SpeechResult) => void) | null = null;
  let holdMacbook: ((res: SpeechResult) => void) | null = null;

  const port: PresencePort = {
    list: async () => structuredClone(questionsList),
    refresh: async id => structuredClone(questionsList.find(a => a.id === id) ?? null),
    respond: async () => {},
    observe: async () => ({ mode: 'online', observedAt: new Date().toISOString(), reason: '在线', source: 'bluetooth' }),
    speak: async hostId => {
      speakCalls.push(String(hostId));
      if (hostId === 'srv_mini' && holdMini !== undefined && holdMacbook !== null) {
        // handled below when holding
      }
      if (hostId === 'srv_mini' && holdMini) return new Promise<SpeechResult>(r => { holdMini = r; });
      if (hostId === 'srv_macbook' && holdMacbook) return new Promise<SpeechResult>(r => { holdMacbook = r; });
      return hostResults[String(hostId)] ?? { played: false, detail: '未知主机' };
    },
    cancelSpeech: async (hostId, id) => {
      cancels.push([hostId, id]);
      if (hostId === 'srv_mini') holdMini?.({ played: false, cancelled: true, detail: '语音播放已取消' });
      if (hostId === 'srv_macbook') holdMacbook?.({ played: false, cancelled: true, detail: '语音播放已取消' });
    },
    hosts: async () => [
      { id: 'srv_mini', name: 'Mac Mini', online: true },
      { id: 'srv_macbook', name: 'MacBook', online: true },
    ],
    selfId: () => 'srv_mini',
    remoteSpeechEnabled: async () => true,
  };

  const runtime = new PresenceRuntime(dir, port, () => now);
  await runtime.start();
  try {
    await runtime.configureLocalSpeech(true);
    await runtime.configure({ mode: 'online', paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' });
    await eventually(() => (runtime.snapshot().speech?.length ?? 0) === 2);

    // 1. 一成一败：任一 played 即 notified，不报 speechError，不重试已提醒提问
    assert.equal(runtime.snapshot().error, null, '任一目标主机播放成功时不应记 speechError');
    assert.deepEqual(
      runtime.snapshot().speech?.map(e => [e.hostId, e.played]),
      [['srv_mini', true], ['srv_macbook', false]],
    );
    now += 10_000;
    await runtime.refresh();
    assert.equal(speakCalls.length, 2, '任一主机成功后该提问已标为 notified，不应重复播报');

    // 重启后也不应因最后一条记录为 false 而误报 speechError
    await runtime.stop();
    const restarted = new PresenceRuntime(dir, port, () => now);
    await restarted.start();
    try {
      assert.equal(restarted.snapshot().error, null, '重启后已 notified 的批次不应误报上次语音未确认播放');

      // 2. 全部失败：记 speechError 并按冷却重试
      now += 180_001;
      speakCalls = [];
      hostResults = {
        srv_mini: { played: false, detail: '本机音频失败', retryAt: now + 180_000 },
        srv_macbook: { played: false, detail: '远端音频失败', retryAt: now + 180_000 },
      };
      questionsList.push({ ...agent(), id: 'agent-2', pendingPermissions: [{ ...request(), id: 'req-2' }] });
      await restarted.refresh();
      await eventually(() => speakCalls.length === 2 && restarted.snapshot().error !== null);
      assert.match(restarted.snapshot().error ?? '', /音频失败/);

      // 冷却期内不重试
      now += 10_000;
      await restarted.refresh();
      assert.equal(speakCalls.length, 2);

      // 冷却结束后重试，且播报中途关闭本机开关只取消 srv_mini，不取消 srv_macbook
      now += 180_001;
      let resolveMini!: (res: SpeechResult) => void;
      let resolveMacbook!: (res: SpeechResult) => void;
      port.speak = async hostId => {
        speakCalls.push(String(hostId));
        if (hostId === 'srv_mini') return new Promise<SpeechResult>(r => { resolveMini = r; });
        return new Promise<SpeechResult>(r => { resolveMacbook = r; });
      };
      port.cancelSpeech = async (hostId, id) => {
        cancels.push([hostId, id]);
        if (hostId === 'srv_mini') resolveMini?.({ played: false, cancelled: true, detail: '语音播放已取消' });
        if (hostId === 'srv_macbook') resolveMacbook?.({ played: false, cancelled: true, detail: '语音播放已取消' });
      };
      await restarted.refresh();
      await eventually(() => speakCalls.length === 4);

      await restarted.configureLocalSpeech(false);
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0]![0], 'srv_mini', '关闭本机播放只应取消本机正在播放的语音');

      resolveMacbook({ played: true, engine: 'neural' });
      await eventually(() => restarted.snapshot().error === null);
    } finally {
      await restarted.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
