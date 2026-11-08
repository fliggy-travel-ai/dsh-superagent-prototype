import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const questionsSource = await readFile(new URL('../browser-extension/questions.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

class El {
  parentElement: El | null = null; children: El[] = []; hidden = false; disabled = false; checked = false; clicks = 0; onClick: (() => void) | null = null;
  tagName: string; attrs: Record<string, string>; text: string;
  constructor(tagName: string, attrs: Record<string, string> = {}, text = '', kids: El[] = []) { this.tagName = tagName.toUpperCase(); this.attrs = attrs; this.text = text; for (const kid of kids) this.add(kid); }
  add(kid: El) { kid.parentElement = this; this.children.push(kid); return this; }
  get id() { return this.attrs.id ?? ''; }
  get value() { return this.attrs.value ?? ''; }
  get isConnected(): boolean { let node: El | null = this; while (node?.parentElement) node = node.parentElement; return node?.tagName === 'HTML'; }
  get innerText(): string { return [this.text, ...this.children.map(kid => kid.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 100, height: 20 }; }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const parsed = part.trim().match(/^([a-z]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/);
      if (!parsed) throw new Error(`夹具不支持选择器 ${part}`);
      return (!parsed[1] || this.tagName.toLowerCase() === parsed[1]) && (!parsed[2] || (parsed[3] === undefined ? parsed[2] in this.attrs : this.attrs[parsed[2]] === parsed[3]));
    });
  }
  closest(selector: string) { for (let node: El | null = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  descendants(): El[] { return this.children.flatMap(kid => [kid, ...kid.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(node => node.matches(selector)); }
  click() { this.clicks++; this.onClick?.(); }
}
const el = (tag: string, attrs: Record<string, string> = {}, text = '', kids: El[] = []) => new El(tag, attrs, text, kids);

function radioOption(name: string, label: string, description = '') {
  const input = el('input', { type: 'radio', name });
  const wrapper = el('label', {}, '', [input, el('span', {}, label), ...(description ? [el('span', {}, description)] : [])]);
  return { input, wrapper };
}
function checkboxOption(label: string) {
  const input = el('input', { type: 'checkbox' });
  return { input, wrapper: el('label', {}, '', [input, el('span', {}, label)]) };
}
type Choice = { input: El; wrapper: El };
function form(question: string, choices: Choice[], submitLabel = 'Submit', extra: El[] = []) {
  const group = el('fieldset', {}, '', [el('legend', {}, question), ...choices.map(choice => choice.wrapper)]);
  const submit = el('button', {}, submitLabel);
  const root = el('form', {}, '', [group, ...extra, submit]);
  const radios = choices.filter(choice => choice.input.attrs.type === 'radio');
  for (const choice of choices) choice.input.onClick = () => {
    if (choice.input.attrs.type === 'radio') { for (const other of radios) other.input.checked = other === choice; } else choice.input.checked = !choice.input.checked;
  };
  Object.defineProperty(submit, 'disabled', { get: () => !choices.some(choice => choice.input.checked) });
  return { root, group, submit, choices };
}

function install(content: El[], path = '/code/session_abc123') {
  const body = el('body', {}, '', content);
  const html = el('html', {}, '', [body]);
  const listeners: ((...args: any[]) => any)[] = [];
  const sent: any[] = [];
  const observers: { disconnected: boolean; callback: () => void }[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0; const intervals = new Set<number>();
  const context: any = {
    document: { documentElement: html, querySelectorAll: (selector: string) => html.querySelectorAll(selector), getElementById: (id: string) => html.descendants().find(node => node.id === id) ?? null },
    location: { origin: 'https://claude.ai', pathname: path },
    chrome: { runtime: { id: 'ext', onMessage: { addListener: (fn: any) => listeners.push(fn), removeListener: (fn: any) => { listeners.splice(listeners.indexOf(fn), 1); } }, sendMessage: async (message: any) => { sent.push(message); } } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { entry: { disconnected: boolean; callback: () => void }; constructor(callback: () => void) { this.entry = { disconnected: false, callback }; observers.push(this.entry); } observe() {} disconnect() { this.entry.disconnected = true; } },
    setTimeout: (callback: () => void, delay: number) => { if (delay === 150) { return setTimeout(callback, delay) as unknown as number; } timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => { intervals.add(++timerId); return timerId; }, clearInterval: (id: number) => { intervals.delete(id); },
    Date, Promise, Object, Array, Set, Map, JSON, Math, String,
  };
  context.globalThis = context;
  const run = () => runInNewContext(questionsSource, context);
  run();
  const call = (message: any) => new Promise<any>(resolve => { const handled = listeners[listeners.length - 1](message, { id: 'ext' }, resolve); if (handled !== true && message.type === 'read-questions') return; });
  const read = async () => JSON.parse(JSON.stringify((await call({ type: 'read-questions' })).questions)) as any[];
  const answer = async (decision: any) => (await call({ type: 'answer-question', decision })).status as string;
  const decide = (question: any, answers: Record<string, string[]>, ttl = 4000) => ({ id: question.id, sessionId: question.sessionId, fingerprint: question.fingerprint, answers, expiresAt: Date.now() + ttl });
  return { context, listeners, sent, observers, read, answer, decide, run, html, body, flush: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}
const envForm = () => form('Which environment should I deploy to?', [radioOption('env', 'Production', '线上环境'), radioOption('env', 'Staging (Recommended)', '预发环境')]);

test('识别可见的单选问答表单，推荐项带标记，重新渲染后指纹保持稳定', async () => {
  const first = envForm(); const page = install([first.root]);
  const [question] = await page.read();
  assert.equal(question.sessionId, 'abc123'); assert.ok(question.fingerprint.length <= 128 && question.id.length <= 200);
  assert.deepEqual(question.prompts, [{ question: 'Which environment should I deploy to?', multiSelect: false, options: [{ label: 'Production', description: '线上环境', recommended: false }, { label: 'Staging (Recommended)', description: '预发环境', recommended: true }] }]);
  const second = envForm(); const rerendered = install([second.root]);
  assert.equal((await rerendered.read())[0].id, question.id); assert.equal((await rerendered.read())[0].fingerprint, question.fingerprint);
  const other = install([envForm().root], '/code/session_other');
  assert.notEqual((await other.read())[0].fingerprint, question.fingerprint);
});

test('按完整标签回答并只点击一次提交，重放、过期、错标签或指纹不符都不动作', async () => {
  const fixture = envForm(); const page = install([fixture.root]);
  const [question] = await page.read(); const prompt = question.prompts[0].question;
  assert.equal(await page.answer(page.decide(question, { [prompt]: ['Staging'] })), 'unknown');
  assert.equal(await page.answer({ ...page.decide(question, { [prompt]: ['Staging (Recommended)'] }), fingerprint: 'other' }), 'unknown');
  assert.equal(await page.answer({ ...page.decide(question, { [prompt]: ['Staging (Recommended)'] }), sessionId: 'other' }), 'unknown');
  assert.equal(await page.answer(page.decide(question, { [prompt]: ['Staging (Recommended)'] }, -1)), 'unknown');
  assert.equal(await page.answer(page.decide(question, { [prompt]: ['Production', 'Staging (Recommended)'] })), 'unknown');
  assert.equal(await page.answer(page.decide(question, { '另一个问题': ['Production'] })), 'unknown');
  assert.equal(fixture.submit.clicks, 0); assert.ok(fixture.choices.every(choice => choice.input.clicks === 0));
  const decision = page.decide(question, { [prompt]: ['Staging (Recommended)'] });
  assert.equal(await page.answer(decision), 'submitted');
  assert.equal(fixture.choices[1].input.checked, true); assert.equal(fixture.choices[0].input.checked, false); assert.equal(fixture.submit.clicks, 1);
  assert.equal(await page.answer(decision), 'unknown'); assert.equal(fixture.submit.clicks, 1);
});

test('提交按钮被禁用时不强行点击；选项被禁用也不改变', async () => {
  const fixture = envForm(); const page = install([fixture.root]);
  Object.defineProperty(fixture.submit, 'disabled', { get: () => true });
  const [question] = await page.read();
  assert.equal(await page.answer(page.decide(question, { [question.prompts[0].question]: ['Production'] })), 'unknown');
  assert.equal(fixture.submit.clicks, 0);
});

test('多选问答没有明确推荐时全部标为非推荐，仍可按明确答案勾选', async () => {
  const fixture = form('Which checks should run?', [checkboxOption('Lint'), checkboxOption('Unit tests'), checkboxOption('E2E')]); const page = install([fixture.root]);
  const [question] = await page.read();
  assert.equal(question.prompts[0].multiSelect, true); assert.ok(question.prompts[0].options.every((option: any) => !option.recommended));
  assert.equal(await page.answer(page.decide(question, { [question.prompts[0].question]: ['Lint', 'E2E'] })), 'submitted');
  assert.deepEqual(fixture.choices.map(choice => choice.input.checked), [true, false, true]); assert.equal(fixture.submit.clicks, 1);
});

test('正文引用、代码块、无分组、缺提交按钮、重复提交按钮和单个复选框都不上报', async () => {
  const quoted = envForm(); const quote = el('blockquote', {}, '', [quoted.root]);
  const code = el('pre', {}, '', [envForm().root]);
  const loose = el('form', {}, '', [radioOption('x', 'A').wrapper, radioOption('x', 'B (Recommended)').wrapper, el('button', {}, 'Submit')]);
  const noSubmit = envForm(); noSubmit.root.children = noSubmit.root.children.filter(kid => kid !== noSubmit.submit);
  const twice = envForm(); twice.root.add(el('button', {}, 'Send'));
  const consent = form('Accept terms?', [checkboxOption('I agree')]);
  const fakeLabel = el('p', {}, 'Staging (Recommended)'); const prose = el('div', {}, '', [fakeLabel, el('button', {}, 'Submit')]);
  const hidden = envForm(); hidden.root.hidden = true;
  const page = install([quote, code, loose, noSubmit.root, twice.root, consent.root, prose, hidden.root]);
  assert.deepEqual(await page.read(), []);
  assert.equal(install([envForm().root], '/code').read !== undefined, true); assert.deepEqual(await install([envForm().root], '/code').read(), []);
});

test('登录、验证码和权限类问题不标推荐，也不会被回答', async () => {
  for (const title of ['Enter the verification code', 'Grant permission to edit all files?', '请先登录账号']) {
    const fixture = form(title, [radioOption('s', 'Yes (Recommended)'), radioOption('s', 'No')]); const page = install([fixture.root]);
    const [question] = await page.read(); assert.ok(question.prompts[0].options.every((option: any) => !option.recommended), title);
    assert.equal(await page.answer(page.decide(question, { [title]: ['Yes (Recommended)'] })), 'unknown'); assert.equal(fixture.submit.clicks, 0);
  }
});

test('同一表单多个问题需全部回答；缺少任一问题则不动作', async () => {
  const first = form('Pick a region', [radioOption('r', 'EU (Recommended)'), radioOption('r', 'US')]);
  const second = el('fieldset', {}, '', [el('legend', {}, 'Pick a size'), radioOption('z', 'Small').wrapper, radioOption('z', 'Large').wrapper]);
  first.root.children.splice(1, 0, second); second.parentElement = first.root;
  const page = install([first.root]);
  const [question] = await page.read(); assert.equal(question.prompts.length, 2);
  assert.equal(await page.answer(page.decide(question, { 'Pick a region': ['EU (Recommended)'] })), 'unknown'); assert.equal(first.submit.clicks, 0);
});

test('变化时通知后台；重复注入销毁旧实例，只保留一个监听和观察器', async () => {
  const fixture = envForm(); const page = install([fixture.root]);
  page.flush(); await Promise.resolve(); assert.deepEqual(JSON.parse(JSON.stringify(page.sent)), [{ type: 'questions-changed' }]);
  page.observers[0].callback(); page.flush(); await Promise.resolve(); assert.equal(page.sent.length, 1);
  page.body.children.length = 0; page.observers[0].callback(); page.flush(); await Promise.resolve(); assert.equal(page.sent.length, 2);
  page.run(); assert.equal(page.listeners.length, 1); assert.equal(page.observers.length, 2); assert.equal(page.observers[0].disconnected, true); assert.equal(page.observers[1].disconnected, false);
});

test('非法问题批次不报告完整读取，不能据此清理待办', async () => {
  const fixture = background(true);
  fixture.setQuestions([sample, { ...sample, id: 'bad', sessionId: 'someone-else' }]);
  await fixture.flush();
  assert.deepEqual(fixture.bodies[0].questions, []);
  assert.deepEqual(fixture.bodies[0].observedSessionIds, []);
});

function background(paired: boolean) {
  const state: Record<string, any> = paired ? { pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) } } : {};
  const noop = { addListener() {} };
  const tab = { id: 7, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_abc123' };
  const messages: any[] = []; const bodies: any[] = []; let respondWith: (body: any) => any = () => ({});
  let questionsOnPage: any[] = []; let answerStatus = 'submitted'; let startup: () => void = () => {};
  let onMessage: (...args: any[]) => unknown = () => {};
  const chrome = {
    storage: { local: { async get(keys: string | string[]) { const out: Record<string, any> = {}; for (const key of Array.isArray(keys) ? keys : [keys]) if (state[key] !== undefined) out[key] = structuredClone(state[key]); return out; }, async set(values: Record<string, any>) { Object.assign(state, structuredClone(values)); } }, onChanged: noop },
    tabs: { async query() { return [{ ...tab }]; }, async get() { return { ...tab }; }, async sendMessage(_id: number, message: any) { messages.push(message); if (message.type === 'read-questions') return { sessionId: 'abc123', questions: structuredClone(questionsOnPage) }; if (message.type === 'answer-question') return { status: answerStatus }; return { title: '会话' }; }, async group() { return 1; }, onUpdated: noop, onRemoved: noop },
    tabGroups: { async get() { return { id: 1, windowId: 1, title: '' }; }, async update() {}, onUpdated: noop, onRemoved: noop },
    runtime: { onStartup: { addListener: (fn: any) => { startup = fn; } }, onInstalled: noop, onMessage: { addListener: (handler: typeof onMessage) => { onMessage = handler; } } }, alarms: { create() {}, onAlarm: noop }, scripting: {},
  };
  let offline = false;
  const fetchImpl = async (_url: string, init: any) => { const body = JSON.parse(init.body); bodies.push(body); if (offline) throw new Error('offline'); const extra = respondWith(body); return { ok: true, async json() { return { sessions: body.sessions.map((session: any) => ({ sessionId: session.sessionId, groupTitle: session.title })), ...extra }; } }; };
  runInNewContext(backgroundSource, { chrome, fetch: fetchImpl, crypto: { randomUUID }, AbortSignal, Map, Object, String, Number, Array, URL, Date, Promise, JSON, Set, setTimeout: (callback: () => void, delay: number) => (delay >= 2000 ? 0 : setTimeout(callback, delay)), clearTimeout });
  const flush = () => new Promise(resolve => setTimeout(resolve, 60));
  const send = (message: any, senderTab = tab) => new Promise<any>(resolve => { if (onMessage(message, { tab: senderTab }, resolve) !== true) resolve(null); });
  return { state, messages, bodies, send, flush, setOffline: (value: boolean) => { offline = value; }, sync: async () => { startup(); await flush(); }, setQuestions: (list: any[]) => { questionsOnPage = list; }, setStatus: (status: string) => { answerStatus = status; }, respond: (fn: (body: any) => any) => { respondWith = fn; } };
}
test('权限点击先持久化去重，同一会话跨标签只允许一次并验证回执来源', async () => {
  const fixture = background(false);
  const reservation = { type: 'approval-reserve', digest: 'a'.repeat(64), button: 'Allow once' };
  const otherTab = { id: 8, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_abc123' };
  const results = await Promise.all([fixture.send(reservation), fixture.send(reservation, otherTab)]);
  assert.deepEqual(results.map(result => result.allowed), [true, false]);
  await fixture.send({ ...reservation, reservationId: results[0].reservationId, type: 'approval-result', status: 'dismissed' }, otherTab);
  assert.equal(fixture.state.approvalAudit[0].status, 'reserved');
  await fixture.send({ ...reservation, reservationId: results[0].reservationId, type: 'approval-result', status: 'dismissed' });
  assert.equal(fixture.state.approvalAudit[0].status, 'dismissed');
  assert.equal((await fixture.send(reservation)).allowed, false);
  fixture.state.approvalAudit[0].observedAt = new Date(Date.now() - 11000).toISOString();
  const next = await fixture.send(reservation);
  assert.equal(next.allowed, true);
  await fixture.send({ ...reservation, reservationId: results[0].reservationId, type: 'approval-result', status: 'dismissed' });
  assert.equal(fixture.state.approvalAudit[1].status, 'reserved');
  await fixture.send({ ...reservation, reservationId: next.reservationId, type: 'approval-result', status: 'still-visible' });
  fixture.state.approvalAudit[1].observedAt = new Date(Date.now() - 11000).toISOString();
  assert.equal((await fixture.send(reservation)).allowed, false);
  assert.equal(await fixture.send(reservation, { ...otherTab, url: 'https://other.example' }), null);
  fixture.state.approvalEnabled = false;
  assert.equal((await fixture.send({ ...reservation, digest: 'b'.repeat(64) })).allowed, false);
});
const sample = { id: 'bq_1', sessionId: 'abc123', fingerprint: 'f'.repeat(32), prompts: [{ question: '部署到哪里？', multiSelect: false, options: [{ label: '预发 (Recommended)', description: '', recommended: true }, { label: '线上', description: '', recommended: false }] }] };

test('后台上报问题、核对后只派发一次，并在下次同步回传结果', async () => {
  const fixture = background(true); fixture.setQuestions([sample]);
  const decision = () => ({ id: 'bq_1', sessionId: 'abc123', fingerprint: sample.fingerprint, answers: { '部署到哪里？': ['预发 (Recommended)'] }, expiresAt: Date.now() + 4000 });
  let first = true; fixture.respond(() => { if (!first) return {}; first = false; return { decisions: [decision(), decision()] }; });
  await fixture.flush();
  assert.deepEqual(fixture.bodies[0].questions, [sample]); assert.deepEqual(fixture.bodies[0].results, []);
  assert.deepEqual(fixture.bodies[0].observedSessionIds, ['abc123']);
  assert.equal(fixture.messages.filter(message => message.type === 'answer-question').length, 1);
  assert.equal(fixture.messages.find(message => message.type === 'answer-question').decision.id, 'bq_1');
  assert.deepEqual(fixture.bodies[1].results, [{ id: 'bq_1', sessionId: 'abc123', fingerprint: sample.fingerprint, status: 'submitted' }]);
  await fixture.sync(); assert.deepEqual(fixture.bodies.at(-1).results, []);
  fixture.respond(() => ({ decisions: [decision()] })); await fixture.sync();
  assert.equal(fixture.messages.filter(message => message.type === 'answer-question').length, 1);
});

test('过期、指纹不符或页面已变化的决定不派发，标记为未知', async () => {
  const fixture = background(true); fixture.setQuestions([sample]);
  let step = 0;
  fixture.respond(() => { step++; if (step > 1) return {}; return { decisions: [
    { id: 'bq_1', sessionId: 'abc123', fingerprint: sample.fingerprint, answers: { '部署到哪里？': ['线上'] }, expiresAt: Date.now() - 1 },
    { id: 'bq_1', sessionId: 'abc123', fingerprint: 'x'.repeat(32), answers: { '部署到哪里？': ['线上'] }, expiresAt: Date.now() + 4000 },
    { id: 'gone', sessionId: 'abc123', fingerprint: 'y', answers: { a: ['b'] }, expiresAt: Date.now() + 4000 },
  ] }; });
  await fixture.flush();
  assert.equal(fixture.messages.filter(message => message.type === 'answer-question').length, 0);
  assert.deepEqual(fixture.bodies[1].results.map((result: any) => result.status), ['unknown', 'unknown', 'unknown']);
});

test('扩展返回未知时保留未知状态；未配对不读取也不回答问答', async () => {
  const fixture = background(true); fixture.setQuestions([sample]); fixture.setStatus('unknown');
  const decision = { id: 'bq_1', sessionId: 'abc123', fingerprint: sample.fingerprint, answers: { '部署到哪里？': ['线上'] }, expiresAt: Date.now() + 4000 };
  let step = 0; fixture.respond(() => (++step === 1 ? { decisions: [decision] } : {}));
  await fixture.flush();
  assert.equal(fixture.bodies[1].results[0].status, 'unknown');
  const lone = background(false); lone.setQuestions([sample]); await lone.flush();
  assert.equal(lone.messages.some(message => message.type === 'read-questions' || message.type === 'answer-question'), false); assert.equal(lone.bodies.length, 0);
});

test('同步失败时保留待回传结果，恢复后补发且已处理的决定不会再次派发', async () => {
  const fixture = background(true); fixture.setQuestions([sample]);
  const decision = { id: 'bq_1', sessionId: 'abc123', fingerprint: sample.fingerprint, answers: { '部署到哪里？': ['线上'] }, expiresAt: Date.now() + 4000 };
  fixture.respond(() => { fixture.setOffline(true); return { decisions: [decision] }; });
  await fixture.flush();
  await fixture.sync(); await fixture.sync();
  const failed = fixture.bodies.slice(1);
  assert.ok(failed.length >= 2); assert.ok(failed.every(body => body.results.length === 1 && body.results[0].status === 'submitted'));
  fixture.setOffline(false); await fixture.sync();
  assert.equal(fixture.bodies.at(-1).results.length, 1);
  await fixture.sync(); assert.deepEqual(fixture.bodies.at(-1).results, []);
  assert.equal(fixture.messages.filter(message => message.type === 'answer-question').length, 1);
});
