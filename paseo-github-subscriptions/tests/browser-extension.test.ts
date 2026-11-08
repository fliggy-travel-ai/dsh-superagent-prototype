import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

test('相同标题的会话独立分组，重复同步幂等，人工改名与断线被保留', async () => {
  const source = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const events = () => { const callbacks: ((...args: any[]) => any)[] = []; return { addListener(fn: (...args: any[]) => any) { callbacks.push(fn); }, fire(...args: any[]) { for (const fn of callbacks) void fn(...args); } }; };
  const changed = events(), updated = events(), removed = events(), tabUpdated = events(), tabRemoved = events(), startup = events(), installed = events(), alarm = events(), message = events();
  const state: Record<string, any> = { instanceName: '我的环境', pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) } };
  const tabs = [ { id: 1, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_a?artifact=test' }, { id: 2, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_b/#details' } ];
  const tabTitles: Record<number, string> = {};
  const injected: number[] = [];
  const groups = new Map<number, { id: number; windowId: number; title: string }>(); let nextId = 1; let online = true; let requests = 0; let observedName = ''; let pause: Promise<void> | undefined;
  const chrome = {
    storage: { local: { async get(keys: string | string[]) { const out: Record<string, any> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (state[k] !== undefined) out[k] = structuredClone(state[k]); return out; }, async set(values: Record<string, any>) { Object.assign(state, structuredClone(values)); } }, onChanged: changed },
    tabs: { async query(query: any) { return tabs.filter(t => query.groupId === undefined || t.groupId === query.groupId).map(t => ({ ...t })); }, async sendMessage(id: number) { return { title: tabTitles[id] ?? '同名' }; }, async group(input: any) { const id = input.groupId ?? nextId++; if (!groups.has(id)) groups.set(id, { id, windowId: 1, title: '' }); for (const t of tabs) if (input.tabIds.includes(t.id)) t.groupId = id; return id; }, onUpdated: tabUpdated, onRemoved: tabRemoved },
    tabGroups: { async get(id: number) { const group = groups.get(id); if (!group) throw new Error(); return { ...group }; }, async update(id: number, data: any) { const g = groups.get(id)!; Object.assign(g, data); updated.fire({ ...g }); return { ...g }; }, onUpdated: updated, onRemoved: removed },
    runtime: { onStartup: startup, onInstalled: installed, onMessage: message }, alarms: { create() {}, onAlarm: alarm },
    scripting: { async executeScript(input: any) { assert.deepEqual(Array.from(input.files), ['title.js', 'approval.js', 'questions.js', 'activity.js']); injected.push(input.target.tabId); } },
  };
  const fakeFetch = async (_url: string, init: any) => { requests++; if (!online) throw new Error('offline'); const input = JSON.parse(init.body); observedName = input.instanceName; if (pause) await pause; return { ok: true, async json() { return { sessions: input.sessions.map((s: any) => ({ sessionId: s.sessionId, groupTitle: s.title })) }; } }; };
  runInNewContext(source, { chrome, fetch: fakeFetch, crypto: { randomUUID }, AbortSignal, Map, Object, String, Number, Array, URL });
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  await flush(); assert.equal(groups.size, 2); assert.notEqual(tabs[0].groupId, tabs[1].groupId); assert.ok(state.instanceId); assert.equal(observedName, '我的环境');
  assert.equal(groups.get(tabs[0].groupId)?.title, '同名 · a'); assert.equal(groups.get(tabs[1].groupId)?.title, '同名 · b');
  startup.fire(); await flush(); assert.equal(groups.size, 2); assert.equal(requests, 2);
  let release: () => void = () => {}; pause = new Promise(resolve => { release = resolve; });
  startup.fire(); await flush();
  const group = groups.get(tabs[0].groupId)!; group.title = '手工名称'; updated.fire({ ...group }); await flush();
  release(); pause = undefined; await flush();
  startup.fire(); await flush(); assert.equal(group.title, '手工名称'); assert.equal(groups.size, 2);
  online = false; tabs.push({ id: 3, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_c' }); startup.fire(); await flush();
  assert.equal(tabs[2].groupId, -1); assert.equal(groups.size, 2);
  delete state.pairing;
  const requestsBefore = requests;
  startup.fire(); await flush();
  assert.equal(groups.size, 3); assert.notEqual(tabs[2].groupId, -1);
  assert.equal(requests, requestsBefore); assert.equal(group.title, '手工名称');
  tabTitles[1] = '更改后的第一个会话'; tabTitles[2] = '更改后的第二个会话';
  message.fire({ type: 'session-title-changed' }, { tab: tabs[1] }); await flush();
  assert.equal(groups.get(tabs[1].groupId)?.title, '更改后的第二个会话');
  assert.equal(group.title, '手工名称'); assert.equal(groups.size, 3);
  tabTitles[2] = 'Claude Code';
  alarm.fire({ name: 'sync' }); await flush();
  assert.equal(groups.get(tabs[1].groupId)?.title, '更改后的第二个会话');
  assert.equal(groups.size, 3);
  installed.fire(); await flush(); assert.deepEqual(injected, [1, 2, 3]);
});

test('确认重置时只替换本浏览器身份并保留配对', async () => {
  const source = await readFile(new URL('../browser-extension/options.js', import.meta.url), 'utf8');
  const listeners: Record<string, (event: any) => Promise<void>> = {};
  const elements: Record<string, any> = Object.fromEntries(['status', 'approvalEnabled', 'name', 'instanceName', 'pair', 'url', 'token', 'clear', 'resetIdentity'].map(id => [id, { value: '', textContent: '', addEventListener(_event: string, fn: any) { listeners[id] = fn; } }]));
  const state: Record<string, any> = { instanceId: 'old', groups: { a: { id: 1 } }, pairing: { token: 'kept' } };
  let approved = false;
  const chrome = { storage: { local: { async get() { return {}; }, async set(value: any) { Object.assign(state, value); }, async remove(key: string) { delete state[key]; } } } };
  runInNewContext(source, { chrome, document: { getElementById: (id: string) => elements[id] }, confirm: () => approved, crypto: { randomUUID: () => 'new-instance' } });
  await listeners.resetIdentity({}); assert.equal(state.instanceId, 'old');
  approved = true; await listeners.resetIdentity({}); assert.equal(state.instanceId, 'new-instance'); assert.equal(Object.keys(state.groups).length, 0); assert.equal(state.pairing.token, 'kept');
});

test('标题支持参数、页面片段和 SPA，准确读取名称并在改名时通知', async () => {
  const source = await readFile(new URL('../browser-extension/title.js', import.meta.url), 'utf8');
  let listener: (...args: any[]) => void = () => {};
  const wrong = { href: 'https://claude.ai/code/session_other', getAttribute: () => '错误会话', querySelector: () => null };
  let sessionTitle = '正确会话';
  let cleanupSelector = '';
  const label = { cloneNode() { const clone = { textContent: `${sessionTitle} Awaiting input Cloud`, querySelectorAll(selector: string) { cleanupSelector = selector; return [{ remove() { clone.textContent = sessionTitle; } }]; } }; return clone; } };
  const right = { href: 'https://claude.ai/code/session_current?artifact=old', getAttribute: () => null, querySelector: (selector: string) => selector === '[data-row-label]' ? label : null };
  let links: (typeof wrong | typeof right)[] = [wrong];
  const document = { title: '页面标题 - Claude', querySelectorAll: () => links, querySelector: () => { throw new Error('不应读取全局标题按钮'); } };
  const location = { pathname: '/code', origin: 'https://claude.ai', search: '', hash: '' };
  let onMutation = () => {}; let tick = () => {}; let notifications = 0;
  class Observer { constructor(callback: () => void) { onMutation = callback; } observe() {} disconnect() {} }
  runInNewContext(source, { chrome: { runtime: { onMessage: { addListener(fn: any) { listener = fn; } }, async sendMessage(message: any) { assert.equal(message.type, 'session-title-changed'); notifications++; } } }, document, location, URL, MutationObserver: Observer, setTimeout(callback: () => void) { tick = callback; return 1; } });
  let result: any; listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '');
  location.pathname = '/code/session_current';
  listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '页面标题');
  location.search = '?artifact=test'; location.hash = '#details';
  links = [wrong, right]; listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '正确会话');
  assert.ok(cleanupSelector.includes('[data-find-omitted]')); assert.ok(cleanupSelector.includes('[role="status"]'));
  onMutation(); tick(); assert.equal(notifications, 1);
  onMutation(); tick(); assert.equal(notifications, 1);
  sessionTitle = '用户改过的名字';
  onMutation(); tick(); assert.equal(notifications, 2);
  listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '用户改过的名字');
  links = [wrong]; document.title = ''; listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '');
  location.origin = 'https://other.test'; listener({ type: 'read-title' }, null, (value: any) => { result = value; }); assert.equal(result.title, '');
});
