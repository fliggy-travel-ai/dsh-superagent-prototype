import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const questionsSource = await readFile(new URL('../browser-extension/questions.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

class El {
  parentElement: El | null = null; children: El[] = []; hidden = false; disabled = false; checked = false; clicks = 0; onClick: (() => void) | null = null;
  events: any[] = [];
  tagName: string; attrs: Record<string, string>; text: string;
  constructor(tagName: string, attrs: Record<string, any> = {}, text = '', kids: El[] = []) {
    this.tagName = tagName.toUpperCase();
    this.attrs = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === '.disabled') { this.disabled = Boolean(v); continue; }
      if (k === '.value') { this.attrs['.value'] = String(v); this.attrs.value = String(v); continue; }
      this.attrs[k] = String(v);
    }
    if ('disabled' in this.attrs && attrs['.disabled'] !== false) this.disabled = true;
    this.text = text;
    for (const kid of kids) this.add(kid);
  }
  add(kid: El) { kid.parentElement = this; this.children.push(kid); return this; }
  get id() { return this.attrs.id ?? ''; }
  get value() { return this.attrs.value ?? this.attrs['.value'] ?? ''; }
  set value(v: string) { this.attrs.value = String(v); this.attrs['.value'] = String(v); }
  get isConnected(): boolean { let node: El | null = this; while (node?.parentElement) node = node.parentElement; return node?.tagName === 'HTML'; }
  get innerText(): string { return [this.text, ...this.children.map(kid => kid.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getAttribute(name: string) { return Object.hasOwn(this.attrs, name) ? this.attrs[name]! : null; }
  setAttribute(name: string, val: string) { this.attrs[name] = String(val); }
  removeAttribute(name: string) { delete this.attrs[name]; }
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
  dispatchEvent(ev: any) { this.events.push(ev); return true; }
}
const el = (tag: string, attrs: Record<string, any> = {}, text = '', kids: El[] = []) => new El(tag, attrs, text, kids);

function fromFixtureTree(tuple: any[]): El {
  const [tag, attrs, ...children] = tuple;
  const textParts: string[] = [];
  const childEls: El[] = [];
  for (const item of children) {
    if (typeof item === 'string') textParts.push(item);
    else if (Array.isArray(item)) childEls.push(fromFixtureTree(item));
  }
  return new El(tag, attrs || {}, textParts.join(' '), childEls);
}

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
    setTimeout: (callback: () => void, delay: number) => { if (delay <= 150) { return setTimeout(callback, delay) as unknown as number; } timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => { intervals.add(++timerId); return timerId; }, clearInterval: (id: number) => { intervals.delete(id); },
    Date, Promise, Object, Array, Set, Map, JSON, Math, String, Number,
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
test('权限点击先持久化去重，未同步时不放行，同一会话跨标签只允许一次并验证回执来源', async () => {
  const fixture = background(false);
  const reservation = { type: 'approval-reserve', digest: 'a'.repeat(64), button: 'Allow once' };
  assert.equal((await fixture.send(reservation)).allowed, false, 'approvalEnabled 未设置时不应放行');
  fixture.state.approvalEnabled = true;
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
  assert.equal((await fixture.send(reservation)).allowed, false);
  fixture.state.approvalAudit[1].observedAt = new Date(Date.now() - 6000).toISOString();
  assert.equal((await fixture.send({ ...reservation, button: 'Allow' })).allowed, false);
  const retry = await fixture.send(reservation);
  assert.equal(retry.allowed, true);
  await fixture.send({ ...reservation, reservationId: retry.reservationId, type: 'approval-result', status: 'still-visible' });
  fixture.state.approvalAudit[0].at = new Date(Date.now() - 181000).toISOString();
  fixture.state.approvalAudit[2].observedAt = new Date(Date.now() - 6000).toISOString();
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

const singleFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-single.json', import.meta.url), 'utf8'));
const singleOtherFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-single-other.json', import.meta.url), 'utf8'));
const multiFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-multi.json', import.meta.url), 'utf8'));
const paged1Fixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-paged-1.json', import.meta.url), 'utf8'));
const paged2Fixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-paged-2.json', import.meta.url), 'utf8'));
const mcpPermFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp.json', import.meta.url), 'utf8'));

function wireCardBehaviors(cardRoot: El, opts: { multiSelect?: boolean; failVerify?: boolean } = {}) {
  const answerBtns = cardRoot.querySelectorAll('button[data-question-answer]');
  const otherBtn = answerBtns.find(b => b.getAttribute('aria-label') === 'Other') ?? null;
  const optionBtns = answerBtns.filter(b => b !== otherBtn);
  const submitOrNext = cardRoot.querySelectorAll('button').find(b => !b.matches('button[data-question-answer]') && /^(?:Submit|Next)\b/.test(b.innerText.replace(/\s+/g, ' ').trim())) ?? null;

  const updateSubmitDisabled = () => {
    if (!submitOrNext || !opts.multiSelect) return;
    const anyPressed = answerBtns.some(b => b.getAttribute('aria-pressed') === 'true');
    submitOrNext.disabled = !anyPressed;
    if (anyPressed) submitOrNext.removeAttribute('disabled');
    else submitOrNext.setAttribute('disabled', '');
  };

  for (const btn of optionBtns) {
    btn.onClick = () => {
      if (opts.failVerify) return;
      if (opts.multiSelect) {
        const next = btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
        btn.setAttribute('aria-pressed', next);
      } else {
        for (const peer of answerBtns) peer.setAttribute('aria-pressed', peer === btn ? 'true' : 'false');
      }
      updateSubmitDisabled();
    };
  }
  if (otherBtn) {
    otherBtn.onClick = () => {
      if (opts.failVerify) return;
      if (opts.multiSelect) {
        const next = otherBtn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
        otherBtn.setAttribute('aria-pressed', next);
      } else {
        for (const peer of answerBtns) peer.setAttribute('aria-pressed', peer === otherBtn ? 'true' : 'false');
      }
      if (otherBtn.getAttribute('aria-pressed') === 'true' && !cardRoot.querySelectorAll('textarea[aria-label="Other option"]').length) {
        const ta = el('textarea', { 'data-cds': 'TextArea', 'aria-label': 'Other option', '.value': '' });
        otherBtn.parentElement?.add(ta);
      }
      updateSubmitDisabled();
    };
  }
  return { optionBtns, otherBtn, submitOrNext };
}

test('claude.ai 真实单选样本：识别卡片与 allowOther，默认已选中第一项时仍点击目标，支持写入 Other 文本框，核对失败返回 unknown', async () => {
  // 1. 单选默认已选中第一项 PASEO_A，目标选 PASEO_A 时仍点击 PASEO_A 按钮
  const card1 = el('div', { 'data-tool-anchor': 'toolu_SINGLE_1' }, '', [fromFixtureTree(singleFixture.tree)]);
  const controls1 = wireCardBehaviors(card1, { multiSelect: false });
  const page1 = install([card1]);
  const [q1] = await page1.read();
  assert.equal(q1.toolUseId, 'toolu_SINGLE_1');
  assert.equal(q1.prompts.length, 1);
  assert.equal(q1.prompts[0].question, '测试单选：选哪个标记？');
  assert.equal(q1.prompts[0].multiSelect, false);
  assert.equal(q1.prompts[0].allowOther, true);
  assert.deepEqual(q1.prompts[0].options, [
    { label: 'PASEO_A', description: '第一个标记', recommended: false },
    { label: 'PASEO_B', description: '第二个标记', recommended: false },
  ]);

  assert.equal(await page1.answer({
    ...page1.decide(q1, { '测试单选：选哪个标记？': ['PASEO_A'] }),
    source: 'manual',
  }), 'submitted');
  assert.equal(controls1.optionBtns[0]!.clicks, 1);
  assert.equal(controls1.submitOrNext!.clicks, 1);

  // 2. 单选填写“其他”文本：点击 Other 按钮并写入 textarea[aria-label="Other option"]
  const card2 = fromFixtureTree(singleOtherFixture.tree);
  wireCardBehaviors(card2, { multiSelect: false });
  const page2 = install([card2]);
  const [q2] = await page2.read();
  assert.equal(await page2.answer({
    ...page2.decide(q2, { '测试单选：选哪个标记？': [] }),
    otherAnswers: { '测试单选：选哪个标记？': 'PASEO_OTHER_1704 单选' },
    source: 'manual',
  }), 'submitted');
  const ta2 = card2.querySelectorAll('textarea[aria-label="Other option"]')[0]!;
  assert.equal(ta2.value, 'PASEO_OTHER_1704 单选');
  assert.ok(ta2.events.some(ev => ev?.type === 'input' && ev?.bubbles === true));

  // 3. 写入后 150ms 核对失败返回 unknown 且不点 Submit
  const card3 = fromFixtureTree(singleFixture.tree);
  const controls3 = wireCardBehaviors(card3, { multiSelect: false, failVerify: true });
  const page3 = install([card3]);
  const [q3] = await page3.read();
  assert.equal(await page3.answer({
    ...page3.decide(q3, { '测试单选：选哪个标记？': ['PASEO_B'] }),
    source: 'manual',
  }), 'unknown');
  assert.equal(controls3.submitOrNext!.clicks, 0);

  // 4. 题目或选项标签含换行/多空白时，复核与答案键两边都做空白归一，提交成功
  const newlineCard = fromFixtureTree(multiFixture.tree);
  const newlineGroup = newlineCard.matches('[data-approval-card-root]') ? newlineCard : newlineCard.querySelectorAll('[data-approval-card-root]')[0]!;
  newlineGroup.setAttribute('aria-label', '测试多选：\n  选哪些标记？');
  wireCardBehaviors(newlineCard, { multiSelect: true });
  const page4 = install([newlineCard]);
  const [q4] = await page4.read();
  assert.equal(q4.prompts[0].question, '测试多选： 选哪些标记？');
  assert.equal(await page4.answer({
    ...page4.decide(q4, { '测试多选：\n  选哪些标记？': ['PASEO_M2,\n  含逗号'] }),
    otherAnswers: { '  测试多选：\n选哪些标记？ ': '含换行题目的其他回答' },
    source: 'manual',
  }), 'submitted');
});

test('claude.ai 真实多选与分页样本：含逗号标签、多选加 Other、两页逐页复核并从 Next 到 Submit', async () => {
  // 1. 多选题：勾选含逗号标签 + Other 文本
  const multiCard = fromFixtureTree(multiFixture.tree);
  const multiControls = wireCardBehaviors(multiCard, { multiSelect: true });
  const multiPage = install([multiCard]);
  const [mq] = await multiPage.read();
  assert.equal(mq.prompts[0].multiSelect, true);
  assert.equal(mq.prompts[0].allowOther, true);
  assert.deepEqual(mq.prompts[0].options.map((o: any) => o.label), ['PASEO_M1', 'PASEO_M2, 含逗号', 'PASEO_M3']);

  assert.equal(await multiPage.answer({
    ...multiPage.decide(mq, { '测试多选：选哪些标记？': ['PASEO_M1', 'PASEO_M2, 含逗号'] }),
    otherAnswers: { '测试多选：选哪些标记？': 'PASEO_OTHER_1704 多选' },
    source: 'manual',
  }), 'submitted');
  assert.equal(multiControls.optionBtns[0]!.getAttribute('aria-pressed'), 'true');
  assert.equal(multiControls.optionBtns[1]!.getAttribute('aria-pressed'), 'true');
  assert.equal(multiControls.optionBtns[2]!.getAttribute('aria-pressed'), 'false');
  assert.equal(multiControls.otherBtn!.getAttribute('aria-pressed'), 'true');
  const multiTa = multiCard.querySelectorAll('textarea[aria-label="Other option"]')[0]!;
  assert.equal(multiTa.value, 'PASEO_OTHER_1704 多选');
  assert.equal(multiControls.submitOrNext!.clicks, 1);

  // 2. 两题分页（question-paged-1.json -> 点击 Next 切换到 question-paged-2.json -> 点击 Submit）
  const page1Tree = fromFixtureTree(paged1Fixture.tree);
  const page2Tree = fromFixtureTree(paged2Fixture.tree);
  const p1Controls = wireCardBehaviors(page1Tree, { multiSelect: false });
  const p2Controls = wireCardBehaviors(page2Tree, { multiSelect: true });

  const pagedPage = install([page1Tree]);
  p1Controls.submitOrNext!.onClick = () => {
    pagedPage.body.children = [page2Tree];
    page2Tree.parentElement = pagedPage.body;
  };

  const [pq] = await pagedPage.read();
  assert.equal(pq.toolUseId, 'toolu_TEST1');
  assert.equal(pq.pages, 2);
  assert.equal(pq.prompts.length, 1);
  assert.equal(pq.prompts[0].question, '测试多题一：选颜色？');

  assert.equal(await pagedPage.answer({
    ...pagedPage.decide(pq, {
      '测试多题一：选颜色？': ['PASEO_BLUE'],
      '测试多题二：选形状？': ['PASEO_CIRCLE', 'PASEO_TRI'],
    }),
    otherAnswers: {
      '测试多题二：选形状？': 'PASEO_OTHER_1704 多题',
    },
    source: 'manual',
  }), 'submitted');
  assert.equal(p1Controls.optionBtns[1]!.getAttribute('aria-pressed'), 'true');
  assert.equal(p1Controls.submitOrNext!.clicks, 1);
  assert.equal(p2Controls.optionBtns[0]!.getAttribute('aria-pressed'), 'true');
  assert.equal(p2Controls.optionBtns[1]!.getAttribute('aria-pressed'), 'false');
  assert.equal(p2Controls.optionBtns[2]!.getAttribute('aria-pressed'), 'true');
  assert.equal(p2Controls.otherBtn!.getAttribute('aria-pressed'), 'true');
  const p2Ta = page2Tree.querySelectorAll('textarea[aria-label="Other option"]')[0]!;
  assert.equal(p2Ta.value, 'PASEO_OTHER_1704 多题');
  assert.equal(p2Controls.submitOrNext!.clicks, 1);
});

test('模式切换 SegmentedControl 与权限卡片不算提问；敏感词提问在 manual 时执行、automatic 时拒绝', async () => {
  // 1. 顶部模式切换 SegmentedControl 和 MCP 权限卡片不被识别为提问
  const segmented = el('div', { role: 'radiogroup', 'data-cds': 'SegmentedControl', 'aria-label': 'Mode' }, '', [
    el('span', { role: 'radio', 'aria-checked': 'true' }, 'Claude'),
    el('span', { role: 'radio', 'aria-checked': 'false' }, 'Code'),
  ]);
  const mcpPerm = fromFixtureTree(mcpPermFixture.tree);
  const page = install([segmented, mcpPerm]);
  assert.deepEqual(await page.read(), []);

  // 2. 含“权限”敏感词的提问卡片：读取时不标推荐；automatic 时拒绝；manual 时照常点击提交
  const sensitiveCard = fromFixtureTree(singleFixture.tree);
  const groupNode = sensitiveCard.matches('[data-approval-card-root]') ? sensitiveCard : sensitiveCard.querySelectorAll('[data-approval-card-root]')[0]!;
  groupNode.setAttribute('aria-label', '测试权限问题：请选择标记？');
  const optADiv = groupNode.querySelectorAll('button[data-question-answer]')[0]!.children[1]!.children[0]!;
  optADiv.text = 'PASEO_A (Recommended)';
  const controls = wireCardBehaviors(sensitiveCard, { multiSelect: false });
  const sPage = install([sensitiveCard]);

  const [sq] = await sPage.read();
  assert.equal(sq.prompts[0].options[0].recommended, false);

  assert.equal(await sPage.answer({
    ...sPage.decide(sq, { '测试权限问题：请选择标记？': ['PASEO_B'] }),
    source: 'automatic',
  }), 'unknown');
  assert.equal(controls.submitOrNext!.clicks, 0);

  assert.equal(await sPage.answer({
    ...sPage.decide(sq, { '测试权限问题：请选择标记？': ['PASEO_B'] }),
    source: 'manual',
  }), 'submitted');
  assert.equal(controls.optionBtns[1]!.getAttribute('aria-pressed'), 'true');
  assert.equal(controls.submitOrNext!.clicks, 1);
});

test('开关为关时跳过读取提问不应把会话标为完整观测（observedSessionIds 为空），重新开启后不误关待答提问', async () => {
  const fixture = background(true);
  fixture.setQuestions([sample]);
  fixture.respond(() => ({ approvalEnabled: false }));
  await fixture.flush();
  assert.equal(fixture.state.approvalEnabled, false);

  // 开关关闭期间再次同步（包括服务端重新开启开关返回 approvalEnabled: true 的那一轮）：
  // 因为本轮跳过了 readQuestions，observedSessionIds 必须为空，不能用空 questions 把待答提问标为已结束。
  fixture.respond(() => ({ approvalEnabled: true }));
  await fixture.sync();
  const reopenRequest = fixture.bodies[1]!;
  assert.deepEqual(reopenRequest.questions, []);
  assert.deepEqual(reopenRequest.observedSessionIds, [], '跳过读取提问时 complete 必须为 false，不能上报 observedSessionIds');

  // 收到 approvalEnabled: true 后立即触发下一轮同步，此时才完整读取并上报 observedSessionIds
  const afterReopen = fixture.bodies.at(-1)!;
  assert.deepEqual(afterReopen.questions, [sample]);
  assert.deepEqual(afterReopen.observedSessionIds, ['abc123']);
});
