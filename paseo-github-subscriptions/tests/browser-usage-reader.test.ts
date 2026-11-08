import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const readerSource = await readFile(new URL('../browser-extension/usage-reader.js', import.meta.url), 'utf8');
const dialogFixtureHtml = await readFile(new URL('./fixtures/claude-usage/usage-dialog.html', import.meta.url), 'utf8');
const ringFixtureHtml = await readFile(new URL('./fixtures/claude-usage/session-usage-ring.html', import.meta.url), 'utf8');

interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  children: Array<FakeElement | string>;
  parentElement: FakeElement | null;
  readonly textContent: string;
  contains(other: FakeElement | null): boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function parseHtmlDocument(html: string, pathname = '/new', title = 'New session - Claude') {
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  const matchSelector = (node: FakeElement, selector: string): boolean => {
    const exactAttr = selector.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
    if (exactAttr) return node.attrs[exactAttr[1]] === exactAttr[2];
    const prefixAttr = selector.match(/^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)\^="([^"]*)"\]$/);
    if (prefixAttr) return node.tag === prefixAttr[1] && (node.attrs[prefixAttr[2]] ?? '').startsWith(prefixAttr[3]);
    return node.tag === selector;
  };
  const makeNode = (tag: string, attrs: Record<string, string>, parentElement: FakeElement | null): FakeElement => {
    const node: FakeElement = {
      tag,
      attrs,
      children: [],
      parentElement,
      get textContent(): string {
        return node.children.map(child => typeof child === 'string' ? child : child.textContent).join('');
      },
      contains(other: FakeElement | null): boolean {
        for (let current = other; current; current = current.parentElement) {
          if (current === node) return true;
        }
        return false;
      },
      getAttribute(name: string) {
        return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
      },
      querySelector(selector: string) {
        return node.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll(selector: string) {
        const out: FakeElement[] = [];
        const walk = (current: FakeElement) => {
          for (const child of current.children) {
            if (typeof child === 'string') continue;
            if (matchSelector(child, selector)) out.push(child);
            walk(child);
          }
        };
        walk(node);
        return out;
      },
    };
    return node;
  };
  const root = makeNode('document', {}, null);
  const stack: FakeElement[] = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  for (const match of html.matchAll(tokenRe)) {
    const [, closeTag, openTag, rawAttrs, text] = match;
    if (closeTag) {
      if (stack.length > 1 && stack[stack.length - 1].tag === closeTag.toLowerCase()) stack.pop();
    } else if (openTag) {
      const tag = openTag.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const attrMatch of (rawAttrs ?? '').matchAll(/([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g)) {
        attrs[attrMatch[1]] = attrMatch[2] ?? '';
      }
      const parent = stack[stack.length - 1];
      const elem = makeNode(tag, attrs, parent === root ? null : parent);
      parent.children.push(elem);
      if (!voidTags.has(tag) && !(rawAttrs ?? '').trim().endsWith('/')) stack.push(elem);
    } else if (text) {
      stack[stack.length - 1].children.push(text);
    }
  }
  const allElements = root.querySelectorAll('*');
  void allElements;
  const findById = (current: FakeElement, id: string): FakeElement | null => {
    for (const child of current.children) {
      if (typeof child === 'string') continue;
      if (child.attrs.id === id) return child;
      const nested = findById(child, id);
      if (nested) return nested;
    }
    return null;
  };
  return {
    location: { pathname },
    document: {
      title,
      getElementById(id: string) {
        return id ? findById(root, id) : null;
      },
      querySelector(selector: string) {
        return root.querySelector(selector);
      },
      querySelectorAll(selector: string) {
        return root.querySelectorAll(selector);
      },
    },
  };
}

function loadHelpers() {
  const ctx: Record<string, any> = { Date, URL, Math, Number, String, Array, Object, Promise, setTimeout };
  ctx.globalThis = ctx;
  runInNewContext(readerSource, ctx);
  return ctx.paseoUsage as {
    readDialog: () => any;
    parseReset: (text: string, now: number, tzOffset: number) => string | null;
    parseDialog: (data: any) => any;
    isUsageUrl: (url: string) => boolean;
    tick: () => Promise<void>;
  };
}

test('parseReset 支持当天、跨天、跨周和不同时区偏移，未知格式返回 null', () => {
  const { parseReset } = loadHelpers();
  const now = Date.parse('2026-11-08T11:07:20.885Z'); // tzOffset=300 下本地时间是周日 06:07:20.885 AM

  // 当天稍晚：6:50 AM (EST) -> 11:50 UTC
  assert.equal(parseReset('Resets at 6:50 AM', now, 300), '2026-11-08T11:50:00.000Z');
  // 当天已过或等于当前时刻：5:00 AM (EST) -> 加 1 天到次日 10:00 UTC
  assert.equal(parseReset('Resets at 5:00 AM', now, 300), '2026-11-09T10:00:00.000Z');
  // 本周内星期五 7:00 PM (EST) -> 2026-11-14T00:00:00.000Z
  assert.equal(parseReset('Resets Friday 7:00 PM', now, 300), '2026-11-14T00:00:00.000Z');
  // 同一星期几但时刻已过：Sunday 6:00 AM (EST) -> 加 7 天
  assert.equal(parseReset('Resets Sunday 6:00 AM', now, 300), '2026-11-15T11:00:00.000Z');
  // 同一星期几且时刻未到：Sunday 12:00 PM (EST) -> 当天 17:00 UTC
  assert.equal(parseReset('Resets Sunday 12:00 PM', now, 300), '2026-11-08T17:00:00.000Z');

  // tzOffset = 0 (UTC) 下：now 是周日 11:07:20.885 UTC
  assert.equal(parseReset('Resets at 6:50 AM', now, 0), '2026-11-09T06:50:00.000Z');
  assert.equal(parseReset('Resets at 12:00 AM', now, 0), '2026-11-09T00:00:00.000Z');
  assert.equal(parseReset('Resets Friday 7:00 PM', now, 0), '2026-11-13T19:00:00.000Z');

  // 非法或未知格式返回 null
  assert.equal(parseReset('Resets tomorrow', now, 300), null);
  assert.equal(parseReset('Resets at 13:00 PM', now, 300), null);
  assert.equal(parseReset('Resets at 6:60 AM', now, 300), null);
  assert.equal(parseReset('', now, 300), null);
});

test('readDialog 与 parseDialog 从真实样本 usage-dialog.html 提取两个窗口，忽略产品分类行与会话圆环样本', async () => {
  const { readDialog, parseDialog, isUsageUrl } = loadHelpers();
  const sampleNow = Date.parse('2026-11-08T11:07:20.885Z');
  const dom = parseHtmlDocument(dialogFixtureHtml, '/new', 'New session - Claude');
  const FakeDate = Object.assign(
    function () { return { getTimezoneOffset: () => 300 }; },
    { now: () => sampleNow },
  );
  const extracted = await runInNewContext(`(${readDialog.toString()})()`, {
    document: dom.document,
    location: dom.location,
    Date: FakeDate,
  });

  // 样本里有 6 个 meter（包含 Claude Code、Chats、Cowork、Other 分类）
  assert.equal(extracted.rows.length, 6);
  const parsed = structuredClone(parseDialog(extracted));
  assert.deepEqual(parsed, {
    observedAt: '2026-11-08T11:07:20.885Z',
    account: null,
    fiveHour: {
      usedPct: 59,
      resetsAt: '2026-11-08T11:50:00.000Z',
      observedAt: '2026-11-08T11:07:20.885Z',
    },
    weekly: {
      usedPct: 46,
      resetsAt: '2026-11-14T00:00:00.000Z',
      observedAt: '2026-11-08T11:07:20.885Z',
    },
  });

  // 会话圆环样本 session-usage-ring.html 不含用量页弹窗结构，不会被读取
  const ringDom = parseHtmlDocument(ringFixtureHtml, '/code/session_abc', 'Session - Claude');
  assert.ok(ringDom.document.querySelector('button[aria-label^="Usage:"]'));
  const fromRing = await runInNewContext(`(${readDialog.toString()})()`, {
    document: ringDom.document,
    location: ringDom.location,
    Date: FakeDate,
  });
  assert.equal(fromRing.rows.length, 0);
  assert.equal(parseDialog(fromRing), null);

  // 只有一行、valueText 不含 used、比例越界时返回 null
  assert.equal(parseDialog({ now: sampleNow, tzOffset: 300, rows: [extracted.rows[0]] }), null);
  assert.equal(parseDialog({
    now: sampleNow,
    tzOffset: 300,
    rows: [
      { label: 'Current session', used: '59', valueText: '59%', reset: 'Resets at 6:50 AM' },
      extracted.rows[1],
    ],
  }), null);
  assert.equal(parseDialog({
    now: sampleNow,
    tzOffset: 300,
    rows: [
      { label: 'Current session', used: '105', valueText: '105% used', reset: 'Resets at 6:50 AM' },
      extracted.rows[1],
    ],
  }), null);
  // 重置文字未知格式时仍保留窗口比例，resetsAt 为 null
  const unknownReset = parseDialog({
    now: sampleNow,
    tzOffset: 300,
    rows: [
      { label: 'Current session', used: '20', valueText: '20% used', reset: 'Resets soon' },
      { label: 'This week', used: '35', valueText: '35% used', reset: null },
    ],
  });
  assert.equal(unknownReset.fiveHour.usedPct, 20);
  assert.equal(unknownReset.fiveHour.resetsAt, null);
  assert.equal(unknownReset.weekly.usedPct, 35);
  assert.equal(unknownReset.weekly.resetsAt, null);

  // isUsageUrl 只识别用量页面地址
  assert.equal(isUsageUrl('https://claude.ai/settings/usage'), true);
  assert.equal(isUsageUrl('https://claude.ai/new#settings/usage'), true);
  assert.equal(isUsageUrl('https://claude.ai/new'), false);
  assert.equal(isUsageUrl('https://claude.ai/code/session_abc'), false);
  assert.equal(isUsageUrl('https://claude.ai/login'), false);
  assert.equal(isUsageUrl('https://example.com/settings/usage'), false);

  // 5 小时窗口尚未开始（显示 "Starts with your first message"、0% used）且每周行有 Resets 时，不越过本行误读每周重置时间
  const notStartedHtml = dialogFixtureHtml
    .replace('<span>Resets at 6:50 AM</span>', '<span>Starts with your first message</span>')
    .replace('aria-valuenow="59" aria-valuetext="59% used" aria-labelledby="_r_55_"', 'aria-valuenow="0" aria-valuetext="0% used" aria-labelledby="_r_55_"')
    .replace('<span>59% used</span>', '<span>0% used</span>');
  const notStartedDom = parseHtmlDocument(notStartedHtml, '/new', 'New session - Claude');
  const notStartedExtracted = await runInNewContext(`(${readDialog.toString()})()`, {
    document: notStartedDom.document,
    location: notStartedDom.location,
    Date: FakeDate,
  });
  const notStartedParsed = structuredClone(parseDialog(notStartedExtracted));
  assert.deepEqual(notStartedParsed, {
    observedAt: '2026-11-08T11:07:20.885Z',
    account: null,
    fiveHour: {
      usedPct: 0,
      resetsAt: null,
      observedAt: '2026-11-08T11:07:20.885Z',
    },
    weekly: {
      usedPct: 46,
      resetsAt: '2026-11-14T00:00:00.000Z',
      observedAt: '2026-11-08T11:07:20.885Z',
    },
  });
});

test('readDialog 从 IndexedDB keyval-store 只读提取 current_account 邮箱：支持对象值、JSON 字符串、缺少 current_account 与打开失败', async () => {
  const { readDialog, parseDialog } = loadHelpers();
  const sampleNow = Date.parse('2026-11-08T11:07:20.885Z');
  const dom = parseHtmlDocument(dialogFixtureHtml, '/new', 'New session - Claude');
  const FakeDate = Object.assign(
    function () { return { getTimezoneOffset: () => 300 }; },
    { now: () => sampleNow },
  );

  const txModes: string[] = [];
  function makeFakeIndexedDB(behavior: { value?: any; failOpen?: boolean; failGet?: boolean }) {
    return {
      open(dbName: string) {
        assert.equal(dbName, 'keyval-store');
        const req: Record<string, any> = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        Promise.resolve().then(() => {
          if (behavior.failOpen) {
            req.onerror?.();
            return;
          }
          req.result = {
            objectStoreNames: { contains: (name: string) => name === 'keyval', 0: 'keyval' },
            transaction(storeName: string, mode: string) {
              assert.equal(storeName, 'keyval');
              txModes.push(mode);
              return {
                objectStore() {
                  return {
                    get(key: string) {
                      assert.equal(key, 'react-query-cache');
                      const getReq: Record<string, any> = { result: undefined, onsuccess: null, onerror: null };
                      Promise.resolve().then(() => {
                        if (behavior.failGet) {
                          getReq.onerror?.();
                        } else {
                          getReq.result = behavior.value;
                          getReq.onsuccess?.();
                        }
                      });
                      return getReq;
                    },
                  };
                },
              };
            },
            close() {},
          };
          req.onsuccess?.();
        });
        return req;
      },
    };
  }

  // 1. 值为对象且含 current_account 查询结果
  const withObject = await runInNewContext(`(${readDialog.toString()})()`, {
    document: dom.document,
    location: dom.location,
    Date: FakeDate,
    indexedDB: makeFakeIndexedDB({
      value: {
        clientState: {
          queries: [
            { queryKey: ['other_query'], state: { data: { name: 'noop' } } },
            { queryKey: ['current_account'], state: { data: { email_address: 'alice@example.com' } } },
          ],
        },
      },
    }),
  });
  assert.equal(withObject.account, 'alice@example.com');
  assert.equal(parseDialog(withObject).account, 'alice@example.com');
  assert.deepEqual(txModes, ['readonly']);

  // 2. 值为 JSON 字符串
  const withJsonString = await runInNewContext(`(${readDialog.toString()})()`, {
    document: dom.document,
    location: dom.location,
    Date: FakeDate,
    indexedDB: makeFakeIndexedDB({
      value: JSON.stringify({
        clientState: {
          queries: [
            { queryKey: ['account', 'current_account'], state: { data: { email_address: 'bob@example.com' } } },
          ],
        },
      }),
    }),
  });
  assert.equal(withJsonString.account, 'bob@example.com');
  assert.equal(parseDialog(withJsonString).account, 'bob@example.com');

  // 3. 没有 current_account 查询：返回 null，不影响额度读取
  const withoutCurrentAccount = await runInNewContext(`(${readDialog.toString()})()`, {
    document: dom.document,
    location: dom.location,
    Date: FakeDate,
    indexedDB: makeFakeIndexedDB({
      value: {
        clientState: {
          queries: [{ queryKey: ['organizations'], state: { data: { id: 'org_1' } } }],
        },
      },
    }),
  });
  assert.equal(withoutCurrentAccount.account, null);
  const parsedNoAccount = parseDialog(withoutCurrentAccount);
  assert.equal(parsedNoAccount.account, null);
  assert.equal(parsedNoAccount.fiveHour.usedPct, 59);
  assert.equal(parsedNoAccount.weekly.usedPct, 46);

  // 4. IndexedDB 打开失败：返回 null，不影响额度读取
  const openFailed = await runInNewContext(`(${readDialog.toString()})()`, {
    document: dom.document,
    location: dom.location,
    Date: FakeDate,
    indexedDB: makeFakeIndexedDB({ failOpen: true }),
  });
  assert.equal(openFailed.account, null);
  const parsedOpenFailed = parseDialog(openFailed);
  assert.equal(parsedOpenFailed.account, null);
  assert.equal(parsedOpenFailed.fiveHour.usedPct, 59);
  assert.equal(parsedOpenFailed.weekly.usedPct, 46);
});

function createHarness(initialState: Record<string, any> = {}) {
  let now = Date.parse('2026-11-08T11:07:20.885Z');
  const state: Record<string, any> = structuredClone(initialState);
  let normalWindows: any[] = [{ id: 1 }];
  const tabs = new Map<number, { id: number; url: string; active: boolean; status?: string }>();
  let nextTabId = 10;
  const createdTabs: Array<{ id: number; url: string; active: boolean }> = [];
  const reloadedTabs: number[] = [];
  const removedTabs: number[] = [];
  const injectedTabs: number[] = [];
  const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let tabIdSavedBeforeInject = false;
  let alarmListener: ((alarm: { name: string }) => void) | null = null;
  let onReload: ((id: number) => void) | null = null;
  let onGetTab: ((id: number, tab: { id: number; url: string; active: boolean; status?: string }) => { id: number; url: string; active: boolean; status?: string }) | null = null;
  let scriptResponder: (tabId: number, func: () => any) => any = async (_tabId, func) => {
    const dom = parseHtmlDocument(dialogFixtureHtml, '/new', 'New session - Claude');
    const FakeDate = Object.assign(function () { return { getTimezoneOffset: () => 300 }; }, { now: () => now });
    return [{ result: await runInNewContext(`(${func.toString()})()`, { document: dom.document, location: dom.location, Date: FakeDate, Promise, setTimeout: (fn: () => void) => { fn(); return 1; } }) }];
  };

  const FakeDate: any = function (...args: any[]) {
    return args.length === 0 ? new Date(now) : new (Date as any)(...args);
  };
  FakeDate.now = () => now;
  FakeDate.UTC = Date.UTC;
  FakeDate.parse = Date.parse;

  const chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, any> = {};
          for (const k of list) if (state[k] !== undefined) out[k] = structuredClone(state[k]);
          return out;
        },
        async set(values: Record<string, any>) {
          Object.assign(state, structuredClone(values));
        },
      },
    },
    windows: {
      async getAll() {
        return [...normalWindows];
      },
    },
    tabs: {
      async create(opts: { url: string; active: boolean }) {
        const id = nextTabId++;
        const tab = { id, url: 'https://claude.ai/new#settings/usage', active: opts.active, status: 'complete' };
        tabs.set(id, tab);
        createdTabs.push({ id, url: opts.url, active: opts.active });
        return { ...tab };
      },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return onGetTab ? onGetTab(id, { ...tab }) : { ...tab };
      },
      async reload(id: number) {
        if (!tabs.has(id)) throw new Error('No tab');
        reloadedTabs.push(id);
        onReload?.(id);
      },
      async remove(id: number) {
        removedTabs.push(id);
        tabs.delete(id);
      },
    },
    scripting: {
      async executeScript(input: { target: { tabId: number }; func: () => any }) {
        if (state.usageState?.tab?.id === input.target.tabId) tabIdSavedBeforeInject = true;
        injectedTabs.push(input.target.tabId);
        return scriptResponder(input.target.tabId, input.func);
      },
    },
    alarms: {
      create() {},
      onAlarm: {
        addListener(fn: (alarm: { name: string }) => void) {
          alarmListener = fn;
        },
      },
    },
  };

  const fakeFetch = async (url: string, init: any) => {
    posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 204 };
  };

  const ctx: Record<string, any> = {
    chrome,
    fetch: fakeFetch,
    crypto: { randomUUID: () => 'env-generated-id' },
    AbortSignal,
    Date: FakeDate,
    URL,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    setTimeout: (fn: () => void) => { fn(); return 1; },
  };
  ctx.globalThis = ctx;
  runInNewContext(readerSource, ctx);

  return {
    state,
    tabs,
    createdTabs,
    reloadedTabs,
    removedTabs,
    injectedTabs,
    posts,
    isSavedBeforeInject: () => tabIdSavedBeforeInject,
    setNow: (value: number) => { now = value; },
    advanceMs: (delta: number) => { now += delta; },
    setWindows: (list: any[]) => { normalWindows = list; },
    setOnReload: (fn: ((id: number) => void) | null) => { onReload = fn; },
    setOnGetTab: (fn: ((id: number, tab: { id: number; url: string; active: boolean; status?: string }) => { id: number; url: string; active: boolean; status?: string }) | null) => { onGetTab = fn; },
    setResponder: (fn: (tabId: number, func: () => any) => any) => { scriptResponder = fn; },
    tick: () => ctx.paseoUsage.tick() as Promise<void>,
    fireAlarm: () => alarmListener?.({ name: 'usage' }),
  };
}

test('未配对或配对配置无效时不注入、不打开、不刷新、不发送', async () => {
  const harness = createHarness({});
  await harness.tick();
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.reloadedTabs.length, 0);
  assert.equal(harness.injectedTabs.length, 0);
  assert.equal(harness.posts.length, 0);

  harness.state.pairing = { url: 'https://evil.example/sync', token: 'a'.repeat(64) };
  await harness.tick();
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.posts.length, 0);

  harness.state.pairing = { url: 'http://127.0.0.1:17373/sync', token: 'short' };
  await harness.tick();
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.posts.length, 0);
});

test('保持单个后台用量标签页：首次后台打开并记住编号，读完不关闭，不到期只上报，到期只刷新该标签页', async () => {
  const harness = createHarness({
    instanceId: 'env-29',
    instanceName: 'SunBrowser 29',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
  });
  // 同时存在一个业务会话标签页，确认扩展不会向它注入或刷新它
  harness.tabs.set(1, { id: 1, url: 'https://claude.ai/code/session_work', active: true });

  await harness.tick();
  assert.equal(harness.createdTabs.length, 1);
  assert.deepEqual(harness.createdTabs[0], { id: 10, url: 'https://claude.ai/settings/usage', active: false });
  assert.equal(harness.isSavedBeforeInject(), true);
  assert.equal(harness.reloadedTabs.length, 0);
  assert.equal(harness.removedTabs.length, 0);
  assert.deepEqual(harness.injectedTabs, [10]);
  assert.equal(harness.state.usageState.tab.id, 10);
  assert.equal(harness.posts.length, 1);
  assert.equal(harness.posts[0].url, 'http://127.0.0.1:17373/usage');
  assert.equal(harness.posts[0].headers.authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(harness.posts[0].body.status, 'ok');
  assert.equal(harness.posts[0].body.fiveHour.usedPct, 59);
  assert.equal(harness.posts[0].body.weekly.usedPct, 46);

  // 1 分钟后（未满 10 分钟）：不打开、不刷新、不注入，但照常每分钟 POST /usage
  harness.advanceMs(60_000);
  await harness.tick();
  assert.equal(harness.createdTabs.length, 1);
  assert.equal(harness.reloadedTabs.length, 0);
  assert.equal(harness.injectedTabs.length, 1);
  assert.equal(harness.posts.length, 2);

  // 10 分钟到期：复用标签页 10，只对标签页 10 调用 reload，不新建标签页，不碰会话标签页 1
  harness.advanceMs(9 * 60_000);
  await harness.tick();
  assert.equal(harness.createdTabs.length, 1);
  assert.deepEqual(harness.reloadedTabs, [10]);
  assert.equal(harness.removedTabs.length, 0);
  assert.deepEqual(harness.injectedTabs, [10, 10]);
  assert.equal(harness.posts.length, 3);
});

test('用户把用量标签页切走改地址或关闭时，不强行改回，下一轮另开一个新标签页', async () => {
  const harness = createHarness({
    instanceId: 'env-29',
    instanceName: 'SunBrowser 29',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
  });
  await harness.tick();
  assert.equal(harness.state.usageState.tab.id, 10);

  // 场景 A：用户关闭了弹窗或切到普通会话页（地址变成 /code/session_xyz），下一轮到期
  harness.tabs.set(10, { id: 10, url: 'https://claude.ai/code/session_xyz', active: true });
  harness.advanceMs(10 * 60_000);
  await harness.tick();
  // 原标签页 10 未被 reload、未被改回、未被关闭；扩展新建后台标签页 11 并记住 11
  assert.deepEqual(harness.reloadedTabs, []);
  assert.equal(harness.tabs.get(10)?.url, 'https://claude.ai/code/session_xyz');
  assert.equal(harness.removedTabs.length, 0);
  assert.equal(harness.createdTabs.length, 2);
  assert.equal(harness.createdTabs[1].id, 11);
  assert.equal(harness.createdTabs[1].active, false);
  assert.equal(harness.state.usageState.tab.id, 11);

  // 场景 B：用户直接关闭了标签页 11，下一轮到期时另开标签页 12
  harness.tabs.delete(11);
  harness.advanceMs(10 * 60_000);
  await harness.tick();
  assert.equal(harness.createdTabs.length, 3);
  assert.equal(harness.createdTabs[2].id, 12);
  assert.equal(harness.state.usageState.tab.id, 12);

  // 场景 C：等待读取期间，用户把标签页 12 改到非用量地址（如 /new 不带 #settings/usage）
  harness.setResponder(tabId => {
    harness.tabs.set(tabId, { id: tabId, url: 'https://claude.ai/new', active: true });
    return [{ result: { path: '/new', title: 'New session - Claude', rows: [], now: Date.now(), tzOffset: 300 } }];
  });
  harness.advanceMs(10 * 60_000);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'tab_closed');
  assert.equal(harness.state.usageState.tab, undefined);
  // 上一次读取到的数值仍保留
  assert.equal(harness.state.usageState.fiveHour.usedPct, 59);
  assert.equal(harness.state.usageState.weekly.usedPct, 46);
});

test('无窗口、未登录、安全验证、解析失败、超时及 20/40/60 分钟退避与 30 分钟未登录间隔', async () => {
  const baseTime = Date.parse('2026-11-08T11:07:20.885Z');
  const harness = createHarness({
    instanceId: 'env-1',
    instanceName: '环境一',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'b'.repeat(64) },
  });

  // 先成功读取一次
  await harness.tick();
  assert.equal(harness.state.usageState.nextReadAt, baseTime + 10 * 60_000);

  // 第 1 次失败：没有普通窗口（no_window），退避 20 分钟
  harness.setNow(harness.state.usageState.nextReadAt);
  harness.tabs.delete(10);
  harness.setWindows([]);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'no_window');
  assert.equal(harness.state.usageState.fiveHour.usedPct, 59);
  assert.equal(harness.state.usageState.nextReadAt, baseTime + (10 + 20) * 60_000);

  // 第 2 次失败：安全验证（challenge），退避 40 分钟
  harness.setNow(harness.state.usageState.nextReadAt);
  harness.setWindows([{ id: 1 }]);
  harness.setResponder(() => [{ result: { path: '/new', title: 'Just a moment...', rows: [], now: Date.now(), tzOffset: 300 } }]);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'challenge');
  assert.equal(harness.state.usageState.nextReadAt, baseTime + (10 + 20 + 40) * 60_000);

  // 第 3 次失败：有 rows 但格式无法识别（parse），退避 60 分钟
  harness.setNow(harness.state.usageState.nextReadAt);
  harness.setResponder(() => [{ result: { path: '/new', title: 'Claude', rows: [{ label: '未知标签', used: '10', valueText: '10% used', reset: null }], now: Date.now(), tzOffset: 300 } }]);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'parse');
  assert.equal(harness.state.usageState.nextReadAt, baseTime + (10 + 20 + 40 + 60) * 60_000);

  // 第 4 次失败：空白超时（timeout），退避封顶 60 分钟
  harness.setNow(harness.state.usageState.nextReadAt);
  harness.setResponder(() => [{ result: { path: '/new', title: 'Claude', rows: [], now: Date.now(), tzOffset: 300 } }]);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'timeout');
  assert.equal(harness.state.usageState.nextReadAt, baseTime + (10 + 20 + 40 + 60 + 60) * 60_000);

  // 未登录（signed_out）：间隔 30 分钟，且清除 reason，保留旧窗口数值
  const signedOutAt = harness.state.usageState.nextReadAt;
  harness.setNow(signedOutAt);
  harness.setResponder(() => [{ result: { path: '/login', title: 'Sign in - Claude', rows: [], now: Date.now(), tzOffset: 300 } }]);
  await harness.tick();
  assert.equal(harness.state.usageState.status, 'signed_out');
  assert.equal(harness.state.usageState.reason, undefined);
  assert.equal(harness.state.usageState.fiveHour.usedPct, 59);
  assert.equal(harness.state.usageState.nextReadAt, signedOutAt + 30 * 60_000);
});

test('reload 后先返回 loading 再 complete、meter 延迟出现、超时三种情况', async () => {
  const harness = createHarness({
    instanceId: 'env-reload',
    instanceName: 'SunBrowser Reload',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'c'.repeat(64) },
  });

  // 首次读取成功（59% / 46%）
  await harness.tick();
  assert.equal(harness.posts.at(-1)?.body.status, 'ok');
  assert.equal(harness.posts.at(-1)?.body.fiveHour.usedPct, 59);
  assert.equal(harness.posts.at(-1)?.body.weekly.usedPct, 46);

  // 情况 1：reload 后标签页先返回 2 次 status: 'loading'（期间若提前注入会读到刷新前的 59%/46% 旧 DOM），第 3 次变为 'complete'（新 DOM 为 74%/52%）
  let getCallsAfterReload = 0;
  let currentTabStatus: 'loading' | 'complete' = 'complete';
  harness.setOnReload(() => {
    getCallsAfterReload = 0;
    currentTabStatus = 'loading';
  });
  harness.setOnGetTab((_id, tab) => {
    if (currentTabStatus === 'loading') {
      getCallsAfterReload += 1;
      if (getCallsAfterReload >= 3) {
        currentTabStatus = 'complete';
      }
    }
    return { ...tab, status: currentTabStatus };
  });
  const injectedStatuses: string[] = [];
  harness.setResponder(async (_tabId, func) => {
    injectedStatuses.push(currentTabStatus);
    const updatedHtml = currentTabStatus === 'complete'
      ? dialogFixtureHtml
          .replace('aria-valuenow="59" aria-valuetext="59% used"', 'aria-valuenow="74" aria-valuetext="74% used"')
          .replace('aria-valuenow="46" aria-valuetext="46% used"', 'aria-valuenow="52" aria-valuetext="52% used"')
      : dialogFixtureHtml;
    const dom = parseHtmlDocument(updatedHtml, '/new', 'New session - Claude');
    const FakeDate = Object.assign(function () { return { getTimezoneOffset: () => 300 }; }, { now: () => Date.parse('2026-11-08T11:17:20.885Z') });
    return [{ result: await runInNewContext(`(${func.toString()})()`, { document: dom.document, location: dom.location, Date: FakeDate, Promise, setTimeout: (fn: () => void) => { fn(); return 1; } }) }];
  });

  harness.advanceMs(10 * 60_000);
  await harness.tick();
  assert.equal(getCallsAfterReload, 3);
  assert.deepEqual(injectedStatuses, ['complete']);
  assert.equal(harness.posts.at(-1)?.body.status, 'ok');
  assert.equal(harness.posts.at(-1)?.body.fiveHour.usedPct, 74);
  assert.equal(harness.posts.at(-1)?.body.weekly.usedPct, 52);

  // 情况 2：标签页 complete 后，弹窗里的 [role="meter"] 延迟出现（第 4 次短轮询才渲染出来，值为 81%/58%）
  harness.setOnReload(null);
  harness.setOnGetTab((_id, tab) => ({ ...tab, status: 'complete' }));
  let meterPollDelays: number[] = [];
  harness.setResponder(async (_tabId, func) => {
    const emptyDom = parseHtmlDocument('<div data-testid="usage-page-pace"><div>Loading usage...</div></div>', '/new', 'New session - Claude');
    const readyHtml = dialogFixtureHtml
      .replace('aria-valuenow="59" aria-valuetext="59% used"', 'aria-valuenow="81" aria-valuetext="81% used"')
      .replace('aria-valuenow="46" aria-valuetext="46% used"', 'aria-valuenow="58" aria-valuetext="58% used"');
    const readyDom = parseHtmlDocument(readyHtml, '/new', 'New session - Claude');
    let queryCount = 0;
    const dynamicDocument = {
      title: 'New session - Claude',
      getElementById(id: string) {
        return readyDom.document.getElementById(id);
      },
      querySelector(selector: string) {
        queryCount += 1;
        return queryCount <= 3 ? emptyDom.document.querySelector(selector) : readyDom.document.querySelector(selector);
      },
      querySelectorAll(selector: string) {
        return queryCount <= 3 ? emptyDom.document.querySelectorAll(selector) : readyDom.document.querySelectorAll(selector);
      },
    };
    const FakeDate = Object.assign(function () { return { getTimezoneOffset: () => 300 }; }, { now: () => Date.parse('2026-11-08T11:27:20.885Z') });
    const result = await runInNewContext(`(${func.toString()})()`, {
      document: dynamicDocument,
      location: readyDom.location,
      Date: FakeDate,
      Promise,
      setTimeout: (fn: () => void, ms: number) => {
        meterPollDelays.push(ms);
        fn();
        return 1;
      },
    });
    return [{ result }];
  });

  harness.advanceMs(10 * 60_000);
  await harness.tick();
  assert.deepEqual(meterPollDelays, [500, 500, 500]);
  assert.equal(harness.posts.at(-1)?.body.status, 'ok');
  assert.equal(harness.posts.at(-1)?.body.fiveHour.usedPct, 81);
  assert.equal(harness.posts.at(-1)?.body.weekly.usedPct, 58);

  // 情况 3a：超时——reload 后标签页一直停留在 status: 'loading'，不执行 executeScript，记为 failed (timeout)，不上报刷新前旧 DOM 作为新 ok
  const injectCountBeforeLoadingTimeout = harness.injectedTabs.length;
  harness.setOnGetTab((_id, tab) => ({ ...tab, status: 'loading' }));
  harness.advanceMs(10 * 60_000);
  await harness.tick();
  assert.equal(harness.injectedTabs.length, injectCountBeforeLoadingTimeout);
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'timeout');
  assert.equal(harness.posts.at(-1)?.body.status, 'failed');
  assert.equal(harness.posts.at(-1)?.body.reason, 'timeout');
  assert.equal(harness.posts.at(-1)?.body.fiveHour.usedPct, 81);
  assert.equal(harness.posts.at(-1)?.body.fiveHour.observedAt, '2026-11-08T11:27:20.885Z');

  // 情况 3b：超时——标签页已 complete，但 [role="meter"] 在 15 秒（30 次短轮询）内始终未出现，记为 failed (timeout)
  harness.setOnGetTab((_id, tab) => ({ ...tab, status: 'complete' }));
  let timeoutPollDelays: number[] = [];
  harness.setResponder(async (_tabId, func) => {
    const emptyDom = parseHtmlDocument('<div data-testid="usage-page-pace"><div>Still loading...</div></div>', '/new', 'New session - Claude');
    const FakeDate = Object.assign(function () { return { getTimezoneOffset: () => 300 }; }, { now: () => Date.parse('2026-11-08T11:57:20.885Z') });
    const result = await runInNewContext(`(${func.toString()})()`, {
      document: emptyDom.document,
      location: emptyDom.location,
      Date: FakeDate,
      Promise,
      setTimeout: (fn: () => void, ms: number) => {
        timeoutPollDelays.push(ms);
        fn();
        return 1;
      },
    });
    return [{ result }];
  });
  harness.setNow(harness.state.usageState.nextReadAt);
  await harness.tick();
  assert.equal(timeoutPollDelays.length, 29);
  assert.equal(harness.state.usageState.status, 'failed');
  assert.equal(harness.state.usageState.reason, 'timeout');
});

test('全文检查：usage-reader.js 只向配对地址调用 fetch，不含点击、事件派发、location 赋值或关闭标签页', () => {
  assert.equal(readerSource.includes('.click('), false);
  assert.equal(readerSource.includes('dispatchEvent'), false);
  assert.equal(/location(?:\.[a-zA-Z0-9_$]+)?\s*=/.test(readerSource), false);
  assert.equal(readerSource.includes('tabs.remove'), false);
  const fetchCalls = [...readerSource.matchAll(/\bfetch\s*\(\s*([^,)]+)/g)].map(m => m[1].trim());
  assert.deepEqual(fetchCalls, ['usageUrl']);
  assert.ok(readerSource.includes("const usageUrl = pairing.url.replace(/\\/sync$/, '/usage');"));
});
