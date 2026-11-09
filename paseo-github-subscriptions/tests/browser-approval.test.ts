import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../browser-extension/approval.js', import.meta.url), 'utf8');
async function page(options: { title?: string; text?: string; disabled?: boolean; enabled?: boolean; origin?: string; excluded?: boolean; withDeny?: boolean; checked?: boolean; radio?: boolean; dismissed?: boolean; storageFailure?: boolean; outerChecked?: boolean; outerPlan?: boolean } = {}) {
  const timers: (() => void)[] = [];
  let changes: (values: any, area: string) => void = () => {};
  let repeat: () => void = () => {};
  let clicks = 0;
  const audit = new Map<string, string>();
  const reject = { innerText: 'Deny', getBoundingClientRect: () => ({ width: 50, height: 20 }) };
  const button: any = { isConnected: true, innerText: options.title ?? 'Allow once', disabled: options.disabled ?? false, getAttribute: () => null, closest: () => options.excluded ? {} : null, getBoundingClientRect: () => ({ width: 100, height: 30 }), click: () => { clicks++; if (options.dismissed) button.isConnected = false; } };
  const buttons = options.withDeny === false ? [button] : [button, reject];
  const scope = { innerText: options.text ?? 'Claude needs permission to run npm test. Allow once Deny', querySelectorAll: () => buttons, querySelector: (selector: string) => selector.includes(':checked') && options.checked || selector.includes('radiogroup') && options.radio ? {} : null, parentElement: null };
  if (options.outerChecked || options.outerPlan) {
    const dialog = { ...scope, querySelector: (selector: string) => selector.includes(':checked') && options.outerChecked ? {} : selector.includes('heading') && options.outerPlan ? { textContent: 'Plan: change permissions' } : null };
    button.closest = (selector: string) => selector.includes('dialog') ? dialog : null;
  }
  button.parentElement = scope;
  const context = { document: { querySelectorAll: () => buttons, documentElement: {}, body: {} }, location: { origin: options.origin ?? 'https://claude.ai', pathname: '/code/session_example' },
    chrome: { storage: { local: { get: async () => ('enabled' in options ? { approvalEnabled: options.enabled } : { approvalEnabled: true }) }, onChanged: { addListener: (handler: typeof changes) => { changes = handler; } } }, runtime: { sendMessage: async (message: any) => {
      if (options.storageFailure) throw new Error('storage failed');
      if (message.type === 'approval-reserve') { if (audit.has(message.digest)) return { allowed: false }; audit.set(message.digest, 'reserved'); return { allowed: true }; }
      audit.set(message.digest, message.status);
    } } },
    crypto: { subtle: { digest: async (_algorithm: string, data: Uint8Array) => createHash('sha256').update(data).digest() } }, TextEncoder, Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), MutationObserver: class { observe() {} },
    setTimeout: (handler: () => void) => { timers.push(handler); }, setInterval: (handler: () => void) => { repeat = handler; }, Date, WeakMap };
  runInNewContext(source, context);
  await Promise.resolve();
  const flush = async () => { for (let step = 0; step < 15; step++) { while (timers.length) timers.shift()!(); await Promise.resolve(); } };
  await flush();
  return { count: () => clicks, audit, button, scope, context, scan: async () => { repeat(); await flush(); }, toggle: async (enabled: boolean | undefined) => { changes({ approvalEnabled: { newValue: enabled } }, 'local'); await flush(); } };
}

test('首次安装未同步时默认不点击；收到 approvalEnabled===true 后点击且窗口仍显示时不重复点击', async () => {
  const unsynced = await page({ enabled: undefined });
  assert.equal(unsynced.count(), 0, 'approvalEnabled 为 undefined 时不应自动点击');
  await unsynced.toggle(true);
  assert.equal(unsynced.count(), 1);
  await unsynced.toggle(undefined);
  unsynced.scope.innerText = 'Claude needs permission for second command';
  await unsynced.scan();
  assert.equal(unsynced.count(), 1, 'approvalEnabled 变回 undefined 时应停止自动点击');

  const fixture = await page(); assert.equal(fixture.count(), 1);
  await fixture.scan(); assert.equal(fixture.count(), 1);
  assert.deepEqual([...fixture.audit.values()], ['still-visible']);
  fixture.scope.innerText = 'Claude needs permission for another command'; await fixture.scan(); assert.equal(fixture.count(), 2);
  runInNewContext(source, fixture.context); await fixture.scan(); assert.equal(fixture.count(), 2);
});

test('关闭自动点击时立即停止，重新开启后处理当前权限窗口', async () => {
  const fixture = await page({ enabled: false }); assert.equal(fixture.count(), 0);
  await fixture.toggle(true); assert.equal(fixture.count(), 1);
  await fixture.toggle(false); fixture.scope.innerText = 'Claude needs permission for a new command'; await fixture.scan(); assert.equal(fixture.count(), 1);
});

test('永久授权按钮、禁用按钮、代码正文或单选框不触发权限点击；计划/推荐/记住选择文案不误拦普通授权', async () => {
  for (const options of [{ checked: true }, { outerChecked: true }, { title: 'Approve', text: 'Implement permission checks. Approve Reject' }, { radio: true }, { storageFailure: true }]) {
    assert.equal((await page(options)).count(), 0, JSON.stringify(options));
  }
  for (const options of [{ outerPlan: true }, { title: 'Allow', text: 'Permission required. Remember this choice. Allow Deny' }, { text: 'Plan: update permissions. Allow once Deny' }, { text: 'AskUserQuestion: Allow once (Recommended) Deny' }]) {
    assert.equal((await page(options)).count(), 1, JSON.stringify(options));
  }
  const fixture = await page({ dismissed: true });
  assert.equal(fixture.count(), 1);
  assert.deepEqual([...fixture.audit.values()], ['dismissed']);
});

test('权限按钮带快捷键符号时仍可识别', async () => {
  for (const title of ['Allow ⌘⏎', 'Allow ⏎', 'Allow once ⌘ Enter', 'Allow Ctrl+Enter', '允许一次 ⌃↵']) {
    const fixture = await page({ title }); assert.equal(fixture.count(), 1, title);
  }
});

test('只点权限窗口，不点永久授权、禁用按钮、代码正文或非权限按钮', async () => {
  for (const options of [{ title: 'Always allow' }, { title: 'Allow this session' }, { disabled: true }, { excluded: true }, { withDeny: false }, { origin: 'https://other.example' }, { title: 'Approve', text: 'Choose an answer: Approve Deny' }]) {
    const fixture = await page(options); assert.equal(fixture.count(), 0, JSON.stringify(options));
  }
  const generic = await page({ title: 'Allow', text: 'Allow Claude to run this command? Allow Deny' }); assert.equal(generic.count(), 1);
});

class DomNode {
  parentElement: DomNode | null = null;
  children: DomNode[] = [];
  tagName: string;
  attrs: Record<string, string> = {};
  disabled = false;
  hidden = false;
  clicks = 0;
  events: any[] = [];
  onClick: (() => void) | null = null;
  private textParts: Array<DomNode | string> = [];

  constructor(tagName: string, rawAttrs: Record<string, any> = {}, childSpecs: any[] = []) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === '.disabled') this.disabled = Boolean(v);
      else this.attrs[k] = String(v);
    }
    if ('disabled' in this.attrs) this.disabled = true;
    for (const spec of childSpecs) {
      if (typeof spec === 'string') {
        this.textParts.push(spec);
      } else if (Array.isArray(spec)) {
        const child = DomNode.fromTuple(spec);
        child.parentElement = this;
        this.children.push(child);
        this.textParts.push(child);
      }
    }
  }

  static fromTuple(tuple: any[]): DomNode {
    const [tag, attrs, ...children] = tuple;
    return new DomNode(tag, attrs || {}, children);
  }

  appendChild(child: DomNode) {
    child.parentElement = this;
    this.children.push(child);
    this.textParts.push(child);
    return child;
  }

  get isConnected(): boolean {
    let cur: DomNode | null = this;
    while (cur?.parentElement) cur = cur.parentElement;
    return cur?.tagName === 'HTML';
  }

  get innerText(): string {
    return this.textParts.map(part => (typeof part === 'string' ? part : part.innerText)).filter(Boolean).join(' ');
  }

  get textContent(): string {
    return this.innerText;
  }

  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name]! : null;
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }

  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  setText(value: string) {
    this.textParts = [value];
  }

  getBoundingClientRect() {
    return this.hidden ? { width: 0, height: 0 } : { width: 100, height: 24 };
  }

  matches(selector: string): boolean {
    return selector.split(',').some(raw => {
      const part = raw.trim();
      if (!part) return false;
      const tagMatch = part.match(/^[a-z0-9]+/i);
      if (tagMatch && this.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
      const attrRe = /\[([a-z0-9_-]+)(?:="([^"]*)")?\]/gi;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(part)) !== null) {
        const attrName = m[1]!;
        const attrVal = m[2];
        if (!Object.hasOwn(this.attrs, attrName)) return false;
        if (attrVal !== undefined && this.attrs[attrName] !== attrVal) return false;
      }
      if (part.includes(':checked')) return false;
      return true;
    });
  }

  closest(selector: string): DomNode | null {
    for (let cur: DomNode | null = this; cur; cur = cur.parentElement) {
      if (cur.matches(selector)) return cur;
    }
    return null;
  }

  descendants(): DomNode[] {
    return this.children.filter(child => child.parentElement === this).flatMap(child => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): DomNode[] {
    return this.descendants().filter(node => node.matches(selector));
  }

  querySelector(selector: string): DomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  click() {
    this.clicks++;
    this.onClick?.();
  }

  dispatchEvent(event: any) {
    this.events.push(event);
    return true;
  }
}

test('MCP 权限卡片样本：打开 More allow options 菜单只点 Allow once，无该项时再次点击菜单按钮关闭并记 skipped，不发 Escape 且永不点 Always allow 或 Deny', async () => {
  const mcpCardFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp.json', import.meta.url), 'utf8'));
  const mcpMenuFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-menu.json', import.meta.url), 'utf8'));

  async function runMcpScenario(
    menuItems: Array<{ role: string; text: string; 'aria-keyshortcuts'?: string }>,
    dismissOnClick = true,
    menuLabelledBy?: string,
  ) {
    const cardTree = DomNode.fromTuple(mcpCardFixture.tree);
    const body = new DomNode('body', {}, []);
    body.appendChild(cardTree);
    const html = new DomNode('html', {}, []);
    html.appendChild(body);

    const allButtons = html.querySelectorAll('button');
    const denyButton = allButtons.find(b => b.innerText.includes('Deny'))!;
    const alwaysAllowButton = allButtons.find(b => b.innerText.includes('Always allow'))!;
    const moreButton = allButtons.find(b => b.getAttribute('aria-label') === 'More allow options')!;

    // 模拟页面监听 Escape 快捷键触发 Deny（Deny 按钮有 aria-keyshortcuts="Escape"）
    const origBodyDispatch = body.dispatchEvent.bind(body);
    body.dispatchEvent = (ev: any) => {
      if (ev?.key === 'Escape') denyButton.click();
      return origBodyDispatch(ev);
    };
    const origMoreDispatch = moreButton.dispatchEvent.bind(moreButton);
    moreButton.dispatchEvent = (ev: any) => {
      if (ev?.key === 'Escape') denyButton.click();
      return origMoreDispatch(ev);
    };

    // 页面上另有一个 aria-labelledby 指向无关按钮的菜单，其内也有 Allow once，必须被忽略
    const strayItem = new DomNode('div', { role: 'menuitem' }, ['Allow once']);
    const strayMenu = new DomNode('div', { role: 'menu', 'aria-labelledby': 'unrelated-button-id' }, [strayItem]);
    body.appendChild(strayMenu);

    const createdMenuItems: DomNode[] = [];
    let activeMenu: DomNode | null = null;
    moreButton.onClick = () => {
      if (activeMenu && activeMenu.parentElement) {
        activeMenu.parentElement = null;
        activeMenu = null;
        return;
      }
      const menu = new DomNode('div', {
        role: mcpMenuFixture.menu.role,
        ...mcpMenuFixture.menu.attrs,
        'aria-labelledby': menuLabelledBy ?? moreButton.getAttribute('id') ?? '',
      }, []);
      for (const itemSpec of menuItems) {
        const item = new DomNode('div', {
          role: itemSpec.role,
          ...(itemSpec['aria-keyshortcuts'] ? { 'aria-keyshortcuts': itemSpec['aria-keyshortcuts'] } : {}),
        }, [itemSpec.text]);
        item.onClick = () => {
          if (dismissOnClick) cardTree.parentElement = null;
        };
        createdMenuItems.push(item);
        menu.appendChild(item);
      }
      activeMenu = menu;
      body.appendChild(menu);
    };

    const timers: (() => void)[] = [];
    const audit: Array<{ button: string; status: string }> = [];
    const context = {
      document: {
        documentElement: html,
        body,
        activeElement: moreButton,
        querySelectorAll: (sel: string) => html.querySelectorAll(sel),
        querySelector: (sel: string) => html.querySelector(sel),
        dispatchEvent: (ev: any) => body.dispatchEvent(ev),
      },
      location: { origin: 'https://claude.ai', pathname: '/code/session_mcp123' },
      chrome: {
        storage: {
          local: { get: async () => ({ approvalEnabled: true }) },
          onChanged: { addListener: () => {} },
        },
        runtime: {
          sendMessage: async (message: any) => {
            if (message.type === 'approval-reserve') {
              audit.push({ button: message.button, status: 'reserved' });
              return { allowed: true, reservationId: 'res-mcp-1' };
            }
            if (message.type === 'approval-result') {
              audit[audit.length - 1]!.status = message.status;
            }
          },
        },
      },
      crypto: { subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
      TextEncoder,
      Uint8Array,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { observe() {} },
      setTimeout: (fn: () => void) => { timers.push(fn); },
      setInterval: () => {},
      Date,
      WeakMap,
    };

    runInNewContext(source, context);
    for (let step = 0; step < 20; step++) {
      while (timers.length) timers.shift()!();
      await Promise.resolve();
    }

    return { denyButton, alwaysAllowButton, moreButton, createdMenuItems, strayItem, body, audit };
  }

  // 1. 菜单含 Allow once（真实样本）：打开菜单并只点击 aria-labelledby 指向 moreButton.id 的菜单里的 Allow once，不点 Always allow、Deny 或无关菜单项
  const okRun = await runMcpScenario(mcpMenuFixture.menu.items, true);
  assert.equal(okRun.alwaysAllowButton.clicks, 0);
  assert.equal(okRun.denyButton.clicks, 0);
  assert.equal(okRun.moreButton.clicks, 1);
  assert.equal(okRun.createdMenuItems.length, 1);
  assert.equal(okRun.createdMenuItems[0]!.clicks, 1);
  assert.equal(okRun.strayItem.clicks, 0);
  assert.deepEqual(okRun.audit, [{ button: 'Allow once', status: 'dismissed' }]);

  // 2. 菜单中只有 Always allow、没有 Allow once（即便页面其他菜单有 Allow once）：再次点击 moreButton 关闭菜单并记 skipped，不派发 Escape，Deny 点击次数为 0
  const missingRun = await runMcpScenario([{ role: 'menuitem', text: 'Always allow' }], true);
  assert.equal(missingRun.alwaysAllowButton.clicks, 0);
  assert.equal(missingRun.denyButton.clicks, 0);
  assert.equal(missingRun.moreButton.clicks, 2);
  assert.equal(missingRun.createdMenuItems[0]!.clicks, 0);
  assert.equal(missingRun.strayItem.clicks, 0);
  const escapeEvents = [...missingRun.moreButton.events, ...missingRun.body.events].filter(ev => ev?.key === 'Escape');
  assert.equal(escapeEvents.length, 0);
  assert.deepEqual(missingRun.audit, [{ button: 'Allow once', status: 'skipped' }]);
});

test('新样式 MCP 权限卡片样本：可见按钮含 Allow once 与 More allow options 时直接只点 Allow once，指纹包含 [data-approval-card-root] 全文、aria-label 与 data-ddev-card-id，关闭后清除 data-ddev-card-id', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const cardTree = DomNode.fromTuple(directFixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(cardTree);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const cardRoot = html.querySelector('[data-approval-card-root]')!;
  const allButtons = html.querySelectorAll('button');
  const denyButton = allButtons.find(b => b.innerText.includes('Deny'))!;
  const allowOnceButton = allButtons.find(b => b.innerText.includes('Allow once'))!;
  const moreButton = allButtons.find(b => b.getAttribute('aria-label') === 'More allow options')!;

  let cardIdAtClick: string | null = null;
  let cardLabelAtClick: string | null = null;
  allowOnceButton.onClick = () => {
    cardIdAtClick = cardRoot.getAttribute('data-ddev-card-id');
    cardLabelAtClick = cardRoot.getAttribute('data-ddev-card-label');
    cardTree.parentElement = null;
  };

  const timers: (() => void)[] = [];
  const reserves: Array<{ digest: string; cardId?: string; labelDigest?: string; button: string }> = [];
  const results: Array<{ digest: string; status: string }> = [];
  let uuidCounter = 0;

  const context = {
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: '/code/session_direct123' },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: async (message: any) => {
          if (message.type === 'approval-reserve') {
            reserves.push({ digest: message.digest, cardId: message.cardId, labelDigest: message.labelDigest, button: message.button });
            return { allowed: true, reservationId: 'res-direct-1' };
          }
          if (message.type === 'approval-result') {
            results.push({ digest: message.digest, status: message.status });
          }
        },
      },
    },
    crypto: {
      randomUUID: () => `card-uuid-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); },
    setInterval: () => {},
    Date,
    WeakMap,
  };

  runInNewContext(source, context);
  for (let step = 0; step < 20; step++) {
    while (timers.length) timers.shift()!();
    await Promise.resolve();
  }

  assert.equal(allowOnceButton.clicks, 1);
  assert.equal(denyButton.clicks, 0);
  assert.equal(moreButton.clicks, 0);
  assert.equal(cardIdAtClick, 'card-uuid-1');
  assert.equal(cardLabelAtClick, 'Permission request: use list hosts (paseo)');
  assert.equal(cardRoot.getAttribute('data-ddev-card-id'), null);
  assert.equal(cardRoot.getAttribute('data-ddev-card-label'), null);
  assert.equal(reserves.length, 1);
  assert.equal(reserves[0]!.cardId, 'card-uuid-1');
  assert.equal(reserves[0]!.button, 'Allow once');

  const expectedRaw = `v2\n/code/session_direct123\ncard-uuid-1\nPermission request: use list hosts (paseo)\n${cardRoot.innerText}`;
  const expectedDigest = createHash('sha256').update(expectedRaw).digest('hex');
  const expectedLabelDigest = createHash('sha256').update('v2-label\n/code/session_direct123\nPermission request: use list hosts (paseo)').digest('hex');
  assert.equal(reserves[0]!.digest, expectedDigest);
  assert.equal(reserves[0]!.labelDigest, expectedLabelDigest);
  assert.deepEqual(results, [{ digest: expectedDigest, status: 'dismissed' }]);
});

test('连续两张内容完全相同的卡片都被点，不同工具卡片在首张 still-visible 后仍被点，且旧指纹 still-visible 记录不挡新卡片', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_01XKJ85kumsMsemTjaRUfwh7';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  const legacyV1Digest = createHash('sha256').update(`${sessionPath}\nDeny Allow once ⌘ Command ⏎ Enter`).digest('hex');
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  // 预置 01XKJ85kumsMsemTjaRUfwh7 在 07:44:05 UTC 的旧版 still-visible 记录（无 cardId）
  const storageState: Record<string, any> = {
    instanceId: 'inst-1',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [
      {
        sessionId: '01XKJ85kumsMsemTjaRUfwh7',
        tabId: 1,
        digest: legacyV1Digest,
        reservationId: 'legacy-res-1',
        button: 'Allow once',
        at: '2026-11-08T07:44:03.500Z',
        observedAt: '2026-11-08T07:44:05.000Z',
        status: 'still-visible',
      },
    ],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-uuid-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const body = new DomNode('body', {}, []);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const timers: (() => void)[] = [];
  let scanTrigger: () => void = () => {};

  const pageContext = {
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-card-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const flush = async () => {
    for (let step = 0; step < 25; step++) {
      while (timers.length) timers.shift()!();
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  // 第 1 张 list_hosts 卡片：即使存在旧指纹 still-visible 记录，仍正常点击并关闭
  const card1 = DomNode.fromTuple(directFixture.tree);
  body.appendChild(card1);
  const allow1 = card1.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allow1.onClick = () => { card1.parentElement = null; };

  runInNewContext(source, pageContext);
  await flush();
  assert.equal(allow1.clicks, 1);

  // 第 2 张内容完全相同的 list_hosts 卡片（满足同 label 5 秒最小间隔后出现）：分配新 data-ddev-card-id，仍被点击
  nowMs += 5000;
  const card2 = DomNode.fromTuple(directFixture.tree);
  body.appendChild(card2);
  const allow2 = card2.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allow2.onClick = () => { card2.parentElement = null; };

  scanTrigger();
  await flush();
  assert.equal(allow2.clicks, 1);
  assert.notEqual(storageState.approvalAudit[1].cardId, storageState.approvalAudit[2].cardId);

  // 第 3 张卡片（list_hosts）点击后未关闭（记为 still-visible），随后被替换为第 4 张卡片（list_providers）：因 labelDigest 不同，无需等待 5 秒即立即被点
  nowMs += 5000;
  const card3 = DomNode.fromTuple(directFixture.tree);
  body.appendChild(card3);
  const allow3 = card3.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  scanTrigger();
  await flush();
  assert.equal(allow3.clicks, 1);
  assert.equal(storageState.approvalAudit.at(-1).status, 'still-visible');

  card3.parentElement = null;
  const providersFixture = JSON.parse(
    JSON.stringify(directFixture.tree).replaceAll('list hosts', 'list providers').replaceAll('list_hosts', 'list_providers'),
  );
  const card4 = DomNode.fromTuple(providersFixture);
  body.appendChild(card4);
  const allow4 = card4.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allow4.onClick = () => { card4.parentElement = null; };

  scanTrigger();
  await flush();
  assert.equal(allow4.clicks, 1);
  assert.equal(storageState.approvalAudit.at(-1).status, 'dismissed');
});

test('同一张卡片 still-visible 按间隔重试，即使文字随流式输出变化也严格受单卡点击上限（如 4 次）与最长重试时长约束', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_retry123';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const approvalConfig = {
    observeDelayMs: 1500,
    retryIntervalMs: 5000,
    maxRetryDurationMs: 180000,
    maxClicksPerCard: 4,
  };

  const storageState: Record<string, any> = {
    instanceId: 'inst-retry',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    __paseoApprovalConfig: approvalConfig,
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-retry-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const card = DomNode.fromTuple(directFixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(card);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const allowOnceButton = card.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  const denyButton = card.querySelectorAll('button').find(b => b.innerText.includes('Deny'))!;
  const moreButton = card.querySelectorAll('button').find(b => b.getAttribute('aria-label') === 'More allow options')!;
  const titleRegion = card.querySelector('[data-testid="approval-title-region"]')!;

  const timers: Array<{ fn: () => void; delay: number }> = [];
  let scanTrigger: () => void = () => {};

  const pageContext = {
    __paseoApprovalConfig: approvalConfig,
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-retry-card-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const runTimersUpTo = async (maxDelay: number) => {
    for (let step = 0; step < 30; step++) {
      await new Promise(resolve => setImmediate(resolve));
      const idx = timers.findIndex(t => t.delay <= maxDelay);
      if (idx !== -1) {
        const [item] = timers.splice(idx, 1);
        if (item!.delay >= 1500) nowMs += item!.delay;
        item!.fn();
      }
    }
    timers.length = 0;
  };

  // 第 1 次点击（首次尝试）：卡片不关闭，记为 still-visible
  runInNewContext(source, pageContext);
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 1);
  assert.equal(storageState.approvalAudit[0].status, 'still-visible');

  // 仅过 2 秒（未满 5 秒重试间隔），即使流式输出改变卡片文字并触发扫描，也不会点击
  nowMs += 2000;
  titleRegion.setText('Allow Claude to use list hosts (paseo)? streaming chunk 1');
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 1);

  // 满 5 秒重试间隔后依次执行第 2、3、4 次点击（每次流式文字都在变化，但因 data-ddev-card-id 相同，共享计数）
  for (let expectedClicks = 2; expectedClicks <= 4; expectedClicks++) {
    nowMs += 5000;
    titleRegion.setText(`Allow Claude to use list hosts (paseo)? streaming chunk ${expectedClicks}`);
    scanTrigger();
    await runTimersUpTo(1500);
    assert.equal(allowOnceButton.clicks, expectedClicks);
  }

  // 达到单卡点击上限 4 次后，即使再过 10 秒且文字继续变化，也不会产生第 5 次点击
  for (let extra = 0; extra < 3; extra++) {
    nowMs += 10000;
    titleRegion.setText(`Allow Claude to use list hosts (paseo)? after cap ${extra}`);
    scanTrigger();
    await runTimersUpTo(5000);
  }
  assert.equal(allowOnceButton.clicks, 4);
  assert.equal(denyButton.clicks, 0);
  assert.equal(moreButton.clicks, 0);
  assert.equal(storageState.approvalAudit.length, 4);
  assert.ok(storageState.approvalAudit.every((entry: any) => entry.button === 'Allow once' && entry.status === 'still-visible'));
});

test('首次出现等待 800 毫秒再点击；后台（visibilityState !== visible）时不点击不计数，切回前台（visibilitychange）同样先等 800 毫秒再点击并重新计算重试时长', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_vis123';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const approvalConfig = {
    observeDelayMs: 1500,
    retryIntervalMs: 5000,
    maxRetryDurationMs: 180000,
    maxClicksPerCard: 4,
  };

  const storageState: Record<string, any> = {
    instanceId: 'inst-vis',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    __paseoApprovalConfig: approvalConfig,
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-vis-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const card = DomNode.fromTuple(directFixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(card);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const allowOnceButton = card.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  const visibilityListeners: Array<(event?: any) => void> = [];
  const timers: Array<{ fn: () => void; delay: number }> = [];
  let scanTrigger: () => void = () => {};

  const docObj = {
    visibilityState: 'hidden',
    documentElement: html,
    body,
    activeElement: body,
    querySelectorAll: (sel: string) => html.querySelectorAll(sel),
    querySelector: (sel: string) => html.querySelector(sel),
    addEventListener: (event: string, listener: (ev?: any) => void) => {
      if (event === 'visibilitychange') visibilityListeners.push(listener);
    },
  };

  const pageContext = {
    __paseoApprovalConfig: approvalConfig,
    document: docObj,
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-vis-card-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const runTimersUpTo = async (maxDelay: number, clearRemaining = true) => {
    for (let step = 0; step < 30; step++) {
      await new Promise(resolve => setImmediate(resolve));
      const idx = timers.findIndex(t => t.delay <= maxDelay);
      if (idx !== -1) {
        const [item] = timers.splice(idx, 1);
        if (item!.delay >= 300) nowMs += item!.delay;
        item!.fn();
      }
    }
    if (clearRemaining) timers.length = 0;
  };

  // 1. 页面初始处于后台（visibilityState === 'hidden'）：即使过去 10 分钟、反复触发扫描，也不点击、不产生任何预约记录
  runInNewContext(source, pageContext);
  await runTimersUpTo(5000);
  nowMs += 600_000;
  scanTrigger();
  await runTimersUpTo(5000);
  assert.equal(allowOnceButton.clicks, 0);
  assert.equal(storageState.approvalAudit.length, 0);

  // 2. 切回前台（visibilityState = 'visible'）：
  //    先验证非可信事件（isTrusted: false）被忽略；可信事件（isTrusted: true）触发 800ms 延迟后执行第 1 次点击
  docObj.visibilityState = 'visible';
  for (const fn of visibilityListeners) fn({ isTrusted: false });
  await runTimersUpTo(5000);
  assert.equal(allowOnceButton.clicks, 0);
  assert.equal(storageState.approvalAudit.length, 0);

  for (const fn of visibilityListeners) fn({ isTrusted: true });
  await runTimersUpTo(200, false);
  assert.equal(allowOnceButton.clicks, 0);
  assert.equal(storageState.approvalAudit.length, 0);
  assert.ok(timers.some(t => t.delay === 800));

  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 1);
  assert.equal(storageState.approvalAudit[0].status, 'still-visible');

  // 3. 切回后台 10 分钟（超过 3 分钟最长重试时长）：后台期间不点击、不计数
  docObj.visibilityState = 'hidden';
  for (const fn of visibilityListeners) fn({ isTrusted: true });
  nowMs += 600_000;
  scanTrigger();
  await runTimersUpTo(5000);
  assert.equal(allowOnceButton.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 1);

  // 4. 再次切回前台：非可信事件不会重置重试时长；可信事件同样先等 800ms 初始延迟（未满 800ms 前不点击），延迟结束后执行第 2 次点击，且重试时长重新计算，5 秒后第 3、4 次重试正常进行
  docObj.visibilityState = 'visible';
  for (const fn of visibilityListeners) fn({ isTrusted: false });
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 1);

  for (const fn of visibilityListeners) fn({ isTrusted: true });
  await runTimersUpTo(200, false);
  assert.equal(allowOnceButton.clicks, 1);
  assert.ok(timers.some(t => t.delay === 800));

  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 2);

  nowMs += 5000;
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 3);

  nowMs += 5000;
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 4);

  // 5. 达到单卡总点击上限（4 次）后，即使再次切后台再切回前台，也不会突破点击总次数上限
  docObj.visibilityState = 'hidden';
  for (const fn of visibilityListeners) fn({ isTrusted: true });
  nowMs += 60_000;
  docObj.visibilityState = 'visible';
  for (const fn of visibilityListeners) fn({ isTrusted: true });
  await runTimersUpTo(5000);
  assert.equal(allowOnceButton.clicks, 4);
  assert.equal(storageState.approvalAudit.length, 4);
});

test('同一节点先后显示两张卡片，两张都被点（覆盖关闭后复用同节点与 still-visible 时 aria-label 变更复用同节点）', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_reuse123';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const storageState: Record<string, any> = {
    instanceId: 'inst-reuse',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-reuse-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const cardTree = DomNode.fromTuple(directFixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(cardTree);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const cardRoot = html.querySelector('[data-approval-card-root]')!;
  const allowOnceButton = cardRoot.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  const titleRegion = cardRoot.querySelector('[data-testid="approval-title-region"]')!;

  const timers: Array<{ fn: () => void; delay: number }> = [];
  let scanTrigger: () => void = () => {};

  const pageContext = {
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-reuse-card-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const runTimersUpTo = async (maxDelay: number) => {
    for (let step = 0; step < 30; step++) {
      await new Promise(resolve => setImmediate(resolve));
      const idx = timers.findIndex(t => t.delay <= maxDelay);
      if (idx !== -1) {
        const [item] = timers.splice(idx, 1);
        if (item!.delay >= 300) nowMs += item!.delay;
        item!.fn();
      }
    }
    timers.length = 0;
  };

  // 场景 A：第 1 张卡片点击后隐藏（记为 dismissed，触发删除 data-ddev-card-id），随后 React 在同一个 cardRoot 节点上展示第 2 张卡片
  allowOnceButton.onClick = () => {
    allowOnceButton.hidden = true;
  };

  runInNewContext(source, pageContext);
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 1);
  assert.equal(storageState.approvalAudit[0].status, 'dismissed');
  assert.equal(cardRoot.getAttribute('data-ddev-card-id'), null);
  const firstCardId = storageState.approvalAudit[0].cardId;

  // 同一个 cardRoot 节点更新为新卡片（list_providers）并重新显示按钮：重新分配 cardId 并点击
  allowOnceButton.hidden = false;
  allowOnceButton.onClick = null; // 第 2 张卡片不关闭（记为 still-visible）
  cardRoot.setAttribute('aria-label', 'Permission request: use list providers (paseo)');
  titleRegion.setText('Allow Claude to use list providers (paseo)?');
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 2);
  assert.equal(storageState.approvalAudit.length, 2);
  assert.equal(storageState.approvalAudit[1].status, 'still-visible');
  const secondCardId = storageState.approvalAudit[1].cardId;
  assert.notEqual(secondCardId, firstCardId);
  assert.equal(cardRoot.getAttribute('data-ddev-card-id'), secondCardId);

  // 场景 B：第 2 张卡片处于 still-visible，React 直接复用同一个 cardRoot 节点把 aria-label 更新为第 3 张卡片（get status）：重新生成 cardId 并立即点击
  allowOnceButton.onClick = () => {
    allowOnceButton.hidden = true;
  };
  cardRoot.setAttribute('aria-label', 'Permission request: use get status (paseo)');
  titleRegion.setText('Allow Claude to use get status (paseo)?');
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceButton.clicks, 3);
  assert.equal(storageState.approvalAudit.length, 3);
  assert.equal(storageState.approvalAudit[2].status, 'dismissed');
  const thirdCardId = storageState.approvalAudit[2].cardId;
  assert.notEqual(thirdCardId, secondCardId);
  assert.equal(cardRoot.getAttribute('data-ddev-card-id'), null);
});

test('旧样式菜单卡片 skipped 计入单卡点击上限，且支持菜单稍后出现 Allow once 时重试成功', async () => {
  const mcpCardFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp.json', import.meta.url), 'utf8'));
  const mcpMenuFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-menu.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_menuretry';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const approvalConfig = {
    initialDelayMs: 300,
    observeDelayMs: 1500,
    retryIntervalMs: 5000,
    maxRetryDurationMs: 180000,
    maxClicksPerCard: 3,
  };

  const storageState: Record<string, any> = {
    instanceId: 'inst-menu',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    __paseoApprovalConfig: approvalConfig,
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-menu-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const cardTree = DomNode.fromTuple(mcpCardFixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(cardTree);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const allButtons = html.querySelectorAll('button');
  const denyButton = allButtons.find(b => b.innerText.includes('Deny'))!;
  const alwaysAllowButton = allButtons.find(b => b.innerText.includes('Always allow'))!;
  const moreButton = allButtons.find(b => b.getAttribute('aria-label') === 'More allow options')!;

  let includeAllowOnce = false;
  let activeMenu: DomNode | null = null;
  let allowOnceItemClicks = 0;

  moreButton.onClick = () => {
    if (activeMenu && activeMenu.parentElement) {
      activeMenu.parentElement = null;
      activeMenu = null;
      return;
    }
    const menu = new DomNode('div', {
      role: mcpMenuFixture.menu.role,
      ...mcpMenuFixture.menu.attrs,
      'aria-labelledby': moreButton.getAttribute('id') ?? '',
    }, []);
    const items = includeAllowOnce
      ? mcpMenuFixture.menu.items
      : [{ role: 'menuitem', text: 'Always allow' }];
    for (const itemSpec of items) {
      const item = new DomNode('div', { role: itemSpec.role }, [itemSpec.text]);
      item.onClick = () => {
        if (itemSpec.text.includes('Allow once')) {
          allowOnceItemClicks++;
        }
      };
      menu.appendChild(item);
    }
    activeMenu = menu;
    body.appendChild(menu);
  };

  const timers: Array<{ fn: () => void; delay: number }> = [];
  let scanTrigger: () => void = () => {};

  const pageContext = {
    __paseoApprovalConfig: approvalConfig,
    document: {
      documentElement: html,
      body,
      activeElement: moreButton,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-menu-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const runTimersUpTo = async (maxDelay: number) => {
    for (let step = 0; step < 30; step++) {
      await new Promise(resolve => setImmediate(resolve));
      const idx = timers.findIndex(t => t.delay <= maxDelay);
      if (idx !== -1) {
        const [item] = timers.splice(idx, 1);
        if (item!.delay >= 300) nowMs += item!.delay;
        item!.fn();
      }
    }
    timers.length = 0;
  };

  // 第 1 次尝试：菜单中无 Allow once，点两次 moreButton（打开+关闭），记为 skipped
  runInNewContext(source, pageContext);
  await runTimersUpTo(1500);
  assert.equal(moreButton.clicks, 2);
  assert.equal(storageState.approvalAudit.length, 1);
  assert.equal(storageState.approvalAudit[0].status, 'skipped');

  // 第 2 次尝试（5 秒后）：菜单中出现了 Allow once，打开菜单并点击 Allow once（此处不关闭卡片以测试第 3 次及上限）
  includeAllowOnce = true;
  nowMs += 5000;
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allowOnceItemClicks, 1);
  assert.equal(storageState.approvalAudit.length, 2);
  assert.equal(storageState.approvalAudit[1].status, 'still-visible');

  // 第 3 次尝试（再过 5 秒）：菜单再次缺少 Allow once，记为 skipped，此时总尝试次数达到 maxClicksPerCard = 3
  includeAllowOnce = false;
  nowMs += 5000;
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(storageState.approvalAudit.length, 3);
  assert.equal(storageState.approvalAudit[2].status, 'skipped');

  // 已达单卡上限 3 次（含 skipped），后续即使再过 10 秒也不会再打开菜单
  const moreClicksAfterCap = moreButton.clicks;
  includeAllowOnce = true;
  nowMs += 10000;
  scanTrigger();
  await runTimersUpTo(5000);
  assert.equal(moreButton.clicks, moreClicksAfterCap);
  assert.equal(denyButton.clicks, 0);
  assert.equal(alwaysAllowButton.clicks, 0);
  assert.equal(storageState.approvalAudit.length, 3);
});

test('同时存在两张卡片时，第一张处于冷却期或达上限不阻塞第二张卡片立即被点', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const sessionPath = '/code/session_twocards';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const storageState: Record<string, any> = {
    instanceId: 'inst-two',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  runInNewContext(backgroundSource, {
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-two-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const card1 = DomNode.fromTuple(directFixture.tree);
  const providersFixture = JSON.parse(
    JSON.stringify(directFixture.tree).replaceAll('list hosts', 'list providers').replaceAll('list_hosts', 'list_providers'),
  );
  const card2 = DomNode.fromTuple(providersFixture);

  const body = new DomNode('body', {}, []);
  body.appendChild(card1);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const allow1 = card1.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  const allow2 = card2.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allow2.onClick = () => { card2.parentElement = null; };

  const timers: Array<{ fn: () => void; delay: number }> = [];
  let scanTrigger: () => void = () => {};

  const pageContext = {
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: sessionPath },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message: any) =>
          new Promise(resolve => {
            bgOnMessage(message, { tab: { id: 1, url: sessionUrl } }, resolve);
          }),
      },
    },
    crypto: {
      randomUUID: () => `dom-two-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: (fn: () => void) => { scanTrigger = fn; },
    Date: FakeDate,
    WeakMap,
  };

  const runTimersUpTo = async (maxDelay: number) => {
    for (let step = 0; step < 30; step++) {
      await new Promise(resolve => setImmediate(resolve));
      const idx = timers.findIndex(t => t.delay <= maxDelay);
      if (idx !== -1) {
        const [item] = timers.splice(idx, 1);
        if (item!.delay >= 300) nowMs += item!.delay;
        item!.fn();
      }
    }
    timers.length = 0;
  };

  // 第 1 张卡片首次点击后未消失（记为 still-visible，进入 5 秒冷却期）
  runInNewContext(source, pageContext);
  await runTimersUpTo(1500);
  assert.equal(allow1.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 1);
  assert.equal(storageState.approvalAudit[0].status, 'still-visible');

  // 仅过 1 秒（第 1 张仍在冷却期且仍在 DOM 中），页面同时出现第 2 张卡片：scan 跳过第 1 张并立即点击第 2 张
  nowMs += 1000;
  body.appendChild(card2);
  scanTrigger();
  await runTimersUpTo(1500);
  assert.equal(allow1.clicks, 1);
  assert.equal(allow2.clicks, 1);
  assert.equal(storageState.approvalAudit.length, 2);
  assert.equal(storageState.approvalAudit[1].status, 'dismissed');
});

test('跨标签页同 label 去重、同会话每分钟总次数限制、reserved 30 秒超时转 still-visible、skipped 后保留 Allow once 与 3 分钟限制、非法配置忽略', async () => {
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const sessionPath = '/code/session_guards123';
  const sessionUrl = `https://claude.ai${sessionPath}`;
  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const storageState: Record<string, any> = {
    instanceId: 'inst-guards',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };

  let bgOnMessage: any = null;
  let uuidCounter = 0;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (typeof keys === 'string') return { [keys]: storageState[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageState[k]]));
          return { ...storageState };
        },
        set: async (vals: Record<string, any>) => { Object.assign(storageState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabGroups: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn: any) => { bgOnMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  // 注入非数字/负数配置，验证 numCfg 忽略非法值并回退到默认常量
  runInNewContext(backgroundSource, {
    __paseoApprovalConfig: {
      retryIntervalMs: 'not-a-number',
      maxRetryDurationMs: -100,
      maxClicksPerCard: NaN,
      reservedTimeoutMs: null,
    },
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => `bg-guards-${++uuidCounter}` },
    AbortSignal,
    Map,
    Object,
    String,
    Number,
    Array,
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Set,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const sendBg = (message: any, tabId = 1) =>
    new Promise<any>(resolve => {
      bgOnMessage(message, { tab: { id: tabId, url: sessionUrl } }, resolve);
    });

  const makeDigest = (seed: string) => createHash('sha256').update(seed).digest('hex');
  const labelDigestA = makeDigest('label-list-hosts');

  // 1. 跨标签页去重（带各自不同 cardId，但相同 sessionId + labelDigest）：
  //    Tab 1 预约成功后，Tab 2 立即用不同 cardId 预约同一 labelDigest 被拒绝；即使 Tab 1 报 dismissed，5 秒内新 cardId 仍被拒绝
  const digestTab1 = makeDigest('tab1-card1');
  const digestTab2 = makeDigest('tab2-card2');
  const resTab1 = await sendBg({
    type: 'approval-reserve',
    digest: digestTab1,
    cardId: 'tab1-card-id',
    labelDigest: labelDigestA,
    button: 'Allow once',
  }, 1);
  assert.equal(resTab1.allowed, true);

  const resTab2WhileReserved = await sendBg({
    type: 'approval-reserve',
    digest: digestTab2,
    cardId: 'tab2-card-id',
    labelDigest: labelDigestA,
    button: 'Allow once',
  }, 2);
  assert.equal(resTab2WhileReserved.allowed, false);

  await sendBg({
    type: 'approval-result',
    digest: digestTab1,
    reservationId: resTab1.reservationId,
    status: 'dismissed',
  }, 1);

  nowMs += 2000; // 未满 5 秒 labelMinIntervalMs
  const resTab2Within5s = await sendBg({
    type: 'approval-reserve',
    digest: digestTab2,
    cardId: 'tab2-card-id',
    labelDigest: labelDigestA,
    button: 'Allow once',
  }, 2);
  assert.equal(resTab2Within5s.allowed, false);

  // 2. reserved 30 秒超时：若内容脚本预约后未发 approval-result，30 秒内拒绝，超过 30 秒自动转为 still-visible 并允许重试
  nowMs += 5000;
  const labelDigestB = makeDigest('label-timeout-test');
  const digestStuck = makeDigest('stuck-card-1');
  const resStuck = await sendBg({
    type: 'approval-reserve',
    digest: digestStuck,
    cardId: 'stuck-card',
    labelDigest: labelDigestB,
    button: 'Allow once',
  }, 1);
  assert.equal(resStuck.allowed, true);

  nowMs += 10_000; // 10 秒时尚未超时，仍为 reserved
  const resBeforeTimeout = await sendBg({
    type: 'approval-reserve',
    digest: digestStuck,
    cardId: 'stuck-card',
    labelDigest: labelDigestB,
    button: 'Allow once',
  }, 1);
  assert.equal(resBeforeTimeout.allowed, false);

  nowMs += 25_000; // 合计 35 秒（超过 30 秒超时 + 5 秒重试间隔），旧 reserved 自动转为 still-visible 并放行重试
  const resAfterTimeout = await sendBg({
    type: 'approval-reserve',
    digest: digestStuck,
    cardId: 'stuck-card',
    labelDigest: labelDigestB,
    button: 'Allow once',
  }, 1);
  assert.equal(resAfterTimeout.allowed, true);
  assert.equal(storageState.approvalAudit.find((e: any) => e.reservationId === resStuck.reservationId).status, 'still-visible');

  // 3. 当最近一条记录为 skipped 时，effectivePrevious 仍保留 Allow once 校验与 3 分钟最长重试时长限制
  await sendBg({
    type: 'approval-result',
    digest: digestStuck,
    reservationId: resAfterTimeout.reservationId,
    status: 'skipped',
  }, 1);

  nowMs += 6000;
  // 3a. 即使上一条是 skipped，重试时 button 若不是 Allow once（例如普通 Allow），仍被拒绝
  const resNonAllowOnce = await sendBg({
    type: 'approval-reserve',
    digest: digestStuck,
    cardId: 'stuck-card',
    labelDigest: labelDigestB,
    button: 'Allow',
  }, 1);
  assert.equal(resNonAllowOnce.allowed, false);

  // 3b. 超过首次尝试 3 分钟（180 秒）后，即使上一条是 skipped，仍因超过 maxRetryDurationMs 被拒绝
  nowMs += 200_000;
  const resAfter3Min = await sendBg({
    type: 'approval-reserve',
    digest: digestStuck,
    cardId: 'stuck-card',
    labelDigest: labelDigestB,
    button: 'Allow once',
  }, 1);
  assert.equal(resAfter3Min.allowed, false);

  // 4. 单会话每分钟最多 12 次限制（APPROVAL_MAX_CLICKS_PER_SESSION_WINDOW = 12）
  nowMs += 120_000; // 进入新的 1 分钟窗口
  for (let i = 1; i <= 12; i++) {
    nowMs += 1000;
    const d = makeDigest(`burst-card-${i}`);
    const ld = makeDigest(`burst-label-${i}`);
    const r = await sendBg({
      type: 'approval-reserve',
      digest: d,
      cardId: `burst-id-${i}`,
      labelDigest: ld,
      button: 'Allow once',
    }, 1);
    assert.equal(r.allowed, true, `attempt ${i} should be allowed`);
    await sendBg({
      type: 'approval-result',
      digest: d,
      reservationId: r.reservationId,
      status: 'dismissed',
    }, 1);
  }
  // 同一分钟窗口内的第 13 次请求被拒绝
  nowMs += 1000;
  const res13th = await sendBg({
    type: 'approval-reserve',
    digest: makeDigest('burst-card-13'),
    cardId: 'burst-id-13',
    labelDigest: makeDigest('burst-label-13'),
    button: 'Allow once',
  }, 1);
  assert.equal(res13th.allowed, false);
});

test('直接点击路径：800ms 等待期间换卡并把按钮节点改成 Always allow，所有按钮点击次数为 0', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));

  async function runDirectWaitSwap(changeCardAriaLabel: boolean) {
    const cardTree = DomNode.fromTuple(directFixture.tree);
    const body = new DomNode('body', {}, []);
    body.appendChild(cardTree);
    const html = new DomNode('html', {}, []);
    html.appendChild(body);

    const cardRoot = html.querySelector('[data-approval-card-root]')!;
    const allButtons = html.querySelectorAll('button');
    const denyButton = allButtons.find(b => b.innerText.includes('Deny'))!;
    const allowOnceButton = allButtons.find(b => b.innerText.includes('Allow once'))!;
    const moreButton = allButtons.find(b => b.getAttribute('aria-label') === 'More allow options')!;
    const titleRegion = cardRoot.querySelector('[data-testid="approval-title-region"]')!;

    const timers: Array<{ fn: () => void; delay: number }> = [];
    const reserves: any[] = [];
    let uuidCounter = 0;

    const context = {
      document: {
        documentElement: html,
        body,
        activeElement: body,
        querySelectorAll: (sel: string) => html.querySelectorAll(sel),
        querySelector: (sel: string) => html.querySelector(sel),
      },
      location: { origin: 'https://claude.ai', pathname: '/code/session_directswap' },
      chrome: {
        storage: {
          local: { get: async () => ({ approvalEnabled: true }) },
          onChanged: { addListener: () => {} },
        },
        runtime: {
          sendMessage: async (message: any) => {
            if (message.type === 'approval-reserve') {
              reserves.push(message);
              return { allowed: true, reservationId: 'res-swap-1' };
            }
          },
        },
      },
      crypto: {
        randomUUID: () => `swap-direct-${++uuidCounter}`,
        subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
      },
      TextEncoder,
      Uint8Array,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { observe() {} },
      setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
      setInterval: () => {},
      Date,
      WeakMap,
    };

    runInNewContext(source, context);
    // 先执行 150ms scan 定时器，进入 clickOnce 并挂起在 800ms 等待定时器上
    for (let step = 0; step < 10; step++) {
      await Promise.resolve();
      const idx = timers.findIndex(t => t.delay < 800);
      if (idx !== -1) timers.splice(idx, 1)[0]!.fn();
    }
    assert.ok(timers.some(t => t.delay === 800));

    // 在 800ms 等待期间：卡片 A 换为卡片 B，且 React 复用原本的 Allow once 按钮节点改成 Always allow
    if (changeCardAriaLabel) {
      cardRoot.setAttribute('aria-label', 'Permission request: use list providers (paseo)');
    }
    titleRegion.setText('Allow Claude to use list providers (paseo)?');
    allowOnceButton.setText('Always allow ⌘ Command ⏎ Enter');

    // 触发 800ms 及后续所有定时器
    for (let step = 0; step < 20; step++) {
      while (timers.length) timers.shift()!.fn();
      await Promise.resolve();
    }

    assert.equal(allowOnceButton.clicks, 0);
    assert.equal(denyButton.clicks, 0);
    assert.equal(moreButton.clicks, 0);
    assert.equal(reserves.length, 0);
  }

  await runDirectWaitSwap(true);
  await runDirectWaitSwap(false);
});

test('菜单点击路径：800ms 等待期间换卡并把按钮节点改成 Always allow，所有按钮点击次数为 0', async () => {
  const mcpCardFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp.json', import.meta.url), 'utf8'));

  async function runMenuWaitSwap(changeCardAriaLabel: boolean, keepMoreAriaLabel: boolean) {
    const cardTree = DomNode.fromTuple(mcpCardFixture.tree);
    const body = new DomNode('body', {}, []);
    body.appendChild(cardTree);
    const html = new DomNode('html', {}, []);
    html.appendChild(body);

    const cardRoot = html.querySelector('[data-approval-card-root]')!;
    const allButtons = html.querySelectorAll('button');
    const denyButton = allButtons.find(b => b.innerText.includes('Deny'))!;
    const alwaysAllowButton = allButtons.find(b => b.innerText.includes('Always allow'))!;
    const moreButton = allButtons.find(b => b.getAttribute('aria-label') === 'More allow options')!;
    const titleRegion = cardRoot.querySelector('[data-testid="approval-title-region"]')!;

    const timers: Array<{ fn: () => void; delay: number }> = [];
    const reserves: any[] = [];
    let uuidCounter = 0;

    const context = {
      document: {
        documentElement: html,
        body,
        activeElement: body,
        querySelectorAll: (sel: string) => html.querySelectorAll(sel),
        querySelector: (sel: string) => html.querySelector(sel),
      },
      location: { origin: 'https://claude.ai', pathname: '/code/session_menuswap' },
      chrome: {
        storage: {
          local: { get: async () => ({ approvalEnabled: true }) },
          onChanged: { addListener: () => {} },
        },
        runtime: {
          sendMessage: async (message: any) => {
            if (message.type === 'approval-reserve') {
              reserves.push(message);
              return { allowed: true, reservationId: 'res-menuswap-1' };
            }
          },
        },
      },
      crypto: {
        randomUUID: () => `swap-menu-${++uuidCounter}`,
        subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
      },
      TextEncoder,
      Uint8Array,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { observe() {} },
      setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
      setInterval: () => {},
      Date,
      WeakMap,
    };

    runInNewContext(source, context);
    // 先执行 150ms scan 定时器，进入 clickMenuOnce 并挂起在 800ms 等待定时器上
    for (let step = 0; step < 10; step++) {
      await Promise.resolve();
      const idx = timers.findIndex(t => t.delay < 800);
      if (idx !== -1) timers.splice(idx, 1)[0]!.fn();
    }
    assert.ok(timers.some(t => t.delay === 800));

    // 在 800ms 等待期间：卡片 A 换为卡片 B，且 React 复用原本的 More allow options 按钮节点改成 Always allow
    if (changeCardAriaLabel) {
      cardRoot.setAttribute('aria-label', 'Permission request: use list providers (paseo)');
    }
    titleRegion.setText('Allow Claude to use list providers (paseo)?');
    moreButton.setText('Always allow');
    if (!keepMoreAriaLabel) {
      moreButton.removeAttribute('aria-label');
    }

    // 触发 800ms 及后续所有定时器
    for (let step = 0; step < 20; step++) {
      while (timers.length) timers.shift()!.fn();
      await Promise.resolve();
    }

    assert.equal(alwaysAllowButton.clicks, 0);
    assert.equal(denyButton.clicks, 0);
    assert.equal(moreButton.clicks, 0);
    assert.equal(reserves.length, 0);
  }

  await runMenuWaitSwap(true, true);
  await runMenuWaitSwap(false, false);
  await runMenuWaitSwap(false, true);
});

test('approval-reserve 被后台拒绝时，内容脚本在本地给该卡片记短暂退避，scan 跳过它继续处理后面的卡片', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));

  const card1 = DomNode.fromTuple(directFixture.tree);
  const providersFixture = JSON.parse(
    JSON.stringify(directFixture.tree).replaceAll('list hosts', 'list providers').replaceAll('list_hosts', 'list_providers'),
  );
  const card2 = DomNode.fromTuple(providersFixture);

  const body = new DomNode('body', {}, []);
  body.appendChild(card1);
  body.appendChild(card2);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const allow1 = card1.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  const allow2 = card2.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allow2.onClick = () => { card2.parentElement = null; };

  let nowMs = 1_700_000_000_000;
  const FakeDate = Object.assign(
    function (value?: any) {
      return value !== undefined ? new Date(value) : new Date(nowMs);
    } as unknown as DateConstructor,
    {
      now: () => nowMs,
      parse: Date.parse,
      UTC: Date.UTC,
    },
  );

  const timers: Array<{ fn: () => void; delay: number }> = [];
  const reservedCardIds: string[] = [];
  let uuidCounter = 0;

  const context = {
    document: {
      documentElement: html,
      body,
      activeElement: body,
      querySelectorAll: (sel: string) => html.querySelectorAll(sel),
      querySelector: (sel: string) => html.querySelector(sel),
    },
    location: { origin: 'https://claude.ai', pathname: '/code/session_rejectbackoff' },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: async (message: any) => {
          if (message.type === 'approval-reserve') {
            reservedCardIds.push(message.cardId);
            // 后台拒绝第 1 张卡片，放行第 2 张卡片
            if (message.cardId === 'backoff-card-1') {
              return { allowed: false };
            }
            return { allowed: true, reservationId: 'res-backoff-2' };
          }
          return { allowed: true };
        },
      },
    },
    crypto: {
      randomUUID: () => `backoff-card-${++uuidCounter}`,
      subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() },
    },
    TextEncoder,
    Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void, delay = 0) => { timers.push({ fn, delay }); },
    setInterval: () => {},
    Date: FakeDate,
    WeakMap,
  };

  runInNewContext(source, context);
  for (let step = 0; step < 35; step++) {
    await new Promise(resolve => setImmediate(resolve));
    if (timers.length) {
      const item = timers.shift()!;
      item.fn();
    }
  }

  // 第 1 张卡片被后台拒绝后记录 5 秒本地退避，不点击；随后自动重扫跳过第 1 张，成功点击第 2 张卡片
  assert.equal(allow1.clicks, 0);
  assert.equal(allow2.clicks, 1);
  assert.deepEqual(reservedCardIds, ['backoff-card-1', 'backoff-card-2']);
});





// #1704 评论 6732392628：阅读门槛（“Scroll to the end to allow this.”）自动滚到底，复核提示消失后再点 Allow once。
async function runReadGateScenario(options: { clearsOnScroll: boolean; persistentChecked?: boolean; uncheckableChecked?: boolean; rounds?: number; changeOnScroll?: (card: DomNode) => void }) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-read-gate.json', import.meta.url), 'utf8'));
  const cardTree = DomNode.fromTuple(fixture.tree);
  const body = new DomNode('body', {}, []);
  body.appendChild(cardTree);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);
  const card = html.querySelector('[data-approval-card-root]')!;
  const rows = card.querySelector('[data-testid="approval-read-rows"]')! as any;
  const hint = card.querySelector('[data-testid="approval-read-hint"]')!;
  const buttons = html.querySelectorAll('button');
  const deny = buttons.find(b => b.innerText.includes('Deny'))!;
  const allowOnce = buttons.find(b => b.innerText.includes('Allow once'))!;
  const more = buttons.find(b => b.getAttribute('aria-label') === 'More allow options')!;
  if (options.persistentChecked) card.appendChild(new DomNode('input', { type: 'checkbox', 'aria-checked': 'true', role: 'checkbox' }, []));
  if (options.uncheckableChecked) {
    const box = new DomNode('input', { type: 'checkbox', 'aria-checked': 'true', role: 'checkbox' }, []);
    box.onClick = () => box.setAttribute('aria-checked', box.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    card.appendChild(box);
  }
  // 参数区可滚动；滚到底并触发 scroll 事件后页面才去掉门槛提示（clearsOnScroll 为假时页面不认这次滚动）
  rows.scrollHeight = 400; rows.clientHeight = 100; rows.scrollTop = 0;
  const scrollEvents: any[] = [];
  rows.dispatchEvent = (event: any) => {
    scrollEvents.push(event);
    if (event?.type === 'scroll' && options.clearsOnScroll && rows.scrollTop + rows.clientHeight >= rows.scrollHeight) { hint.hidden = true; options.changeOnScroll?.(card); }
    return true;
  };
  // 门槛还在时页面不接受“允许”
  allowOnce.onClick = () => { if (hint.hidden) cardTree.parentElement = null; };

  const timers: (() => void)[] = [];
  const results: Array<{ status: string; readGate?: string }> = [];
  let uuid = 0;
  const context = {
    document: { documentElement: html, body, activeElement: body, querySelectorAll: (sel: string) => html.querySelectorAll(sel), querySelector: (sel: string) => html.querySelector(sel) },
    location: { origin: 'https://claude.ai', pathname: '/code/session_gate123' },
    chrome: {
      storage: { local: { get: async () => ({ approvalEnabled: true }) }, onChanged: { addListener: () => {} } },
      runtime: { sendMessage: async (message: any) => {
        if (message.type === 'approval-reserve') return { allowed: true, reservationId: `res-${results.length}` };
        if (message.type === 'approval-result') results.push({ status: message.status, ...(message.readGate ? { readGate: message.readGate } : {}) });
      } },
    },
    crypto: { randomUUID: () => `gate-uuid-${++uuid}`, subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
    TextEncoder, Uint8Array, Event: class { type: string; constructor(type: string) { this.type = type; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); }, setInterval: () => {}, Date, WeakMap,
  };
  runInNewContext(source, context);
  for (let step = 0; step < (options.rounds ?? 40); step++) {
    while (timers.length) timers.shift()!();
    await Promise.resolve();
  }
  return { allowOnce, deny, more, rows, scrollEvents, results, cardTree };
}

test('阅读门槛：原本会自动批准的卡片先把参数区滚到底，提示消失后只点 Allow once，记录 read_gate_scrolled', async () => {
  const run = await runReadGateScenario({ clearsOnScroll: true });
  assert.ok(run.rows.scrollTop + run.rows.clientHeight >= run.rows.scrollHeight, '参数区没有滚到底');
  assert.ok(run.scrollEvents.some(event => event.type === 'scroll'), '没有派发 scroll 事件');
  assert.equal(run.allowOnce.clicks, 1);
  assert.equal(run.deny.clicks, 0);
  assert.equal(run.more.clicks, 0);
  assert.equal(run.cardTree.parentElement, null);
  assert.deepEqual(run.results, [{ status: 'dismissed', readGate: 'read_gate_scrolled' }]);
});

test('阅读门槛：滚动后提示仍在时不点 Allow once，记 skipped / read_gate_blocked，按原有上限停止重试', async () => {
  const run = await runReadGateScenario({ clearsOnScroll: false, rounds: 400 });
  assert.equal(run.allowOnce.clicks, 0);
  assert.equal(run.deny.clicks, 0);
  assert.equal(run.more.clicks, 0);
  assert.ok(run.results.length >= 1);
  assert.ok(run.results.every(result => result.status === 'skipped' && result.readGate === 'read_gate_blocked'), JSON.stringify(run.results));
  assert.ok(run.results.length <= 36, `重试次数 ${run.results.length} 超过单卡上限`);
});

test('阅读门槛：卡片带可取消勾选框时先取消再点 Allow once；若取消失败仍勾选则不点且记 skipped', async () => {
  const okRun = await runReadGateScenario({ clearsOnScroll: true, uncheckableChecked: true });
  assert.ok(okRun.rows.scrollTop + okRun.rows.clientHeight >= okRun.rows.scrollHeight, '参数区没有滚到底');
  assert.equal(okRun.allowOnce.clicks, 1);
  assert.equal(okRun.deny.clicks, 0);
  assert.deepEqual(okRun.results, [{ status: 'dismissed', readGate: 'read_gate_scrolled' }]);

  const failRun = await runReadGateScenario({ clearsOnScroll: true, persistentChecked: true });
  assert.equal(failRun.allowOnce.clicks, 0, '取消勾选失败仍处于勾选状态时不得点击 Allow once');
  assert.equal(failRun.deny.clicks, 0);
  assert.ok(failRun.results.length >= 1);
  assert.ok(failRun.results.every(r => r.status === 'skipped'));
});

test('后台把阅读门槛结果 readGate 写进点同意记录并随同步上报', async () => {
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const sessionUrl = 'https://claude.ai/code/session_gatebg123';
  const storageState: Record<string, any> = {
    instanceId: 'inst-gate',
    pairing: { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };
  let onMessage: any = null;
  let uuid = 0;
  const bodies: any[] = [];
  const chrome = {
    storage: { local: { get: async (keys: any) => typeof keys === 'string' ? { [keys]: storageState[keys] } : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, storageState[k]])) : { ...storageState }, set: async (values: Record<string, any>) => { Object.assign(storageState, values); } }, onChanged: { addListener: () => {} } },
    tabs: { query: async () => [], onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    tabGroups: { onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    runtime: { onMessage: { addListener: (fn: any) => { onMessage = fn; } }, onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  const timers: Array<() => void> = [];
  runInNewContext(backgroundSource, {
    chrome, crypto: { randomUUID: () => `bg-gate-${++uuid}` }, AbortSignal, Map, Object, String, Number, Array, URL, Date, Promise, JSON, Set,
    fetch: async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ sessions: [] }) }; },
    setTimeout: (fn: () => void) => { timers.push(fn); return 0; }, clearTimeout: () => {},
  });
  const send = (message: any) => new Promise<any>(resolve => { onMessage(message, { tab: { id: 7, url: sessionUrl } }, resolve); });
  const digest = createHash('sha256').update('gate-card').digest('hex');
  const reserved = await send({ type: 'approval-reserve', digest, cardId: 'gate-card', labelDigest: createHash('sha256').update('gate-label').digest('hex'), button: 'Allow once' });
  assert.equal(reserved.allowed, true);
  await send({ type: 'approval-result', digest, reservationId: reserved.reservationId, status: 'dismissed', readGate: 'read_gate_scrolled' });
  assert.equal(storageState.approvalAudit.at(-1).readGate, 'read_gate_scrolled');
  // 非法取值不写入
  const digest2 = createHash('sha256').update('gate-card-2').digest('hex');
  const reserved2 = await send({ type: 'approval-reserve', digest: digest2, cardId: 'gate-card-2', labelDigest: createHash('sha256').update('gate-label-2').digest('hex'), button: 'Allow once' });
  await send({ type: 'approval-result', digest: digest2, reservationId: reserved2.reservationId, status: 'skipped', readGate: 'whatever' });
  assert.equal(storageState.approvalAudit.at(-1).readGate, undefined);

  storageState.pairing = { url: 'http://127.0.0.1:17373/sync', token: 'a'.repeat(64) };
  for (let step = 0; step < 30 && !bodies.some(body => body.approvals?.some((item: any) => item.readGate)); step++) { while (timers.length) timers.shift()!(); await new Promise(resolve => setImmediate(resolve)); onMessage({ type: 'session-title-changed' }, { tab: { id: 7, url: sessionUrl } }, () => {}); }
  const synced = bodies.flatMap(body => body.approvals ?? []);
  assert.ok(synced.some((item: any) => item.digest === digest && item.readGate === 'read_gate_scrolled'), JSON.stringify(synced));

  const { BrowserApprovalSchema } = await import('../shared/browser.ts');
  assert.equal(BrowserApprovalSchema.safeParse({ sessionId: 'abc', reservationId: 'r', digest, button: 'Allow once', at: new Date().toISOString(), status: 'dismissed', readGate: 'read_gate_scrolled' }).success, true);
  assert.equal(BrowserApprovalSchema.safeParse({ sessionId: 'abc', reservationId: 'r', digest, button: 'Allow once', at: new Date().toISOString(), status: 'dismissed', readGate: 'other' }).success, false);
});

test('阅读门槛：滚动后出现 Plan/remember 或默认勾选框时仍自动取消勾选并批准；若变成提问卡则不点击且记 skipped', async () => {
  let checkbox: DomNode | null = null;
  const planAndCheckboxRun = await runReadGateScenario({
    clearsOnScroll: true,
    changeOnScroll: (card: DomNode) => {
      checkbox = new DomNode('input', { type: 'checkbox', role: 'checkbox', 'aria-checked': 'true' }, []);
      checkbox.onClick = () => checkbox!.setAttribute('aria-checked', checkbox!.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      card.appendChild(checkbox);
      card.appendChild(new DomNode('p', {}, ['Plan: proceed with ExitPlanMode, AskUserQuestion (Recommended) 请选择 Always allow remember this choice']));
    },
  });
  assert.equal(checkbox!.clicks, 1);
  assert.equal(checkbox!.getAttribute('aria-checked'), 'false');
  assert.equal(planAndCheckboxRun.allowOnce.clicks, 1);
  assert.equal(planAndCheckboxRun.deny.clicks, 0);
  assert.deepEqual(planAndCheckboxRun.results, [{ status: 'dismissed', readGate: 'read_gate_scrolled' }]);

  const morphedToQuestionRun = await runReadGateScenario({
    clearsOnScroll: true,
    changeOnScroll: (card: DomNode) => {
      card.appendChild(new DomNode('button', { 'data-question-answer': '0' }, ['Option A']));
    },
  });
  assert.equal(morphedToQuestionRun.allowOnce.clicks, 0);
  assert.equal(morphedToQuestionRun.deny.clicks, 0);
  assert.ok(morphedToQuestionRun.results.every(result => result.status === 'skipped' && !result.readGate));
});

test('1737-remove-automation：结构识别权限卡不受 plan/AskUserQuestion/always/16000 字符限制且先取消勾选框；提问卡永不自动点；总开关同步到扩展', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));
  const singleQ = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-single.json', import.meta.url), 'utf8'));
  const multiQ = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-multi.json', import.meta.url), 'utf8'));
  const pagedQ = JSON.parse(await readFile(new URL('./fixtures/claude-web/question-paged-1.json', import.meta.url), 'utf8'));

  // 1. 权限卡含 plan、AskUserQuestion、请选择、always、remember、超 16000 字符参数，且按钮为普通 Allow，带已勾选 checkbox：先取消勾选再点 Allow
  const card = DomNode.fromTuple(directFixture.tree);
  const titleRegion = card.querySelector('[data-testid="approval-title-region"]')!;
  titleRegion.setText('Plan: proceed with AskUserQuestion (Recommended) 请选择 Which option Remember this choice Always allow ' + 'x'.repeat(18000));
  const allowBtn = card.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  allowBtn.setText('Allow ⌘⏎');
  const cardRoot = card.querySelector('[data-approval-card-root]')!;
  cardRoot.appendChild(new DomNode('pre', {}, ['git commit -m "plan: mention ExitPlanMode and plan mode in body"']));
  const rememberBox = new DomNode('div', { role: 'checkbox', 'aria-checked': 'true' }, ['Remember this choice']);
  cardRoot.appendChild(rememberBox);

  // 同时页面存在真实提问卡（甚至其中一个选项文字带 Allow once / Deny）
  const q1 = DomNode.fromTuple(singleQ.tree);
  const q2 = DomNode.fromTuple(multiQ.tree);
  const q3 = DomNode.fromTuple(pagedQ.tree);
  const trickyQ = DomNode.fromTuple(singleQ.tree);
  const trickyButtons = trickyQ.querySelectorAll('button');
  trickyButtons[0]!.setText('Allow once');
  trickyButtons[1]!.setText('Deny');

  const body = new DomNode('body', {}, []);
  body.appendChild(q1);
  body.appendChild(q2);
  body.appendChild(q3);
  body.appendChild(trickyQ);
  body.appendChild(card);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  let enabledFlag = true;
  let onStorageChanged: (changes: any, area: string) => void = () => {};
  const timers: Array<() => void> = [];
  let uuid = 0;

  const context = {
    document: { documentElement: html, body, activeElement: body, querySelectorAll: (sel: string) => html.querySelectorAll(sel), querySelector: (sel: string) => html.querySelector(sel) },
    location: { origin: 'https://claude.ai', pathname: '/code/session_struct123' },
    chrome: {
      storage: {
        local: { get: async () => ({ approvalEnabled: enabledFlag }) },
        onChanged: { addListener: (fn: typeof onStorageChanged) => { onStorageChanged = fn; } },
      },
      runtime: {
        sendMessage: async (message: any) => {
          if (message.type === 'approval-reserve') return { allowed: enabledFlag, reservationId: `res-${++uuid}` };
          return { allowed: true };
        },
      },
    },
    crypto: { randomUUID: () => `struct-uuid-${++uuid}`, subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
    TextEncoder, Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); }, setInterval: () => {}, Date, WeakMap,
  };

  const clickOrder: string[] = [];
  rememberBox.onClick = () => {
    clickOrder.push('uncheck-remember');
    rememberBox.setAttribute('aria-checked', 'false');
  };
  allowBtn.onClick = () => {
    clickOrder.push('click-allow');
    card.parentElement = null;
  };

  runInNewContext(source, context);
  for (let step = 0; step < 25; step++) {
    while (timers.length) timers.shift()!();
    await Promise.resolve();
  }

  // 提问卡里的任何按钮都不能被点击
  for (const qCard of [q1, q2, q3, trickyQ]) {
    for (const btn of qCard.querySelectorAll('button')) {
      assert.equal(btn.clicks, 0, `提问卡按钮不应被点击：${btn.innerText}`);
    }
  }
  // 权限卡先取消勾选框，再点 Allow
  assert.deepEqual(clickOrder, ['uncheck-remember', 'click-allow']);
  assert.equal(rememberBox.clicks, 1);
  assert.equal(allowBtn.clicks, 1);

  // 2. 验证 BrowserBridge 总开关（enabled: false/true）通过 /sync 同步到 background.js 的 approvalEnabled，关闭时不点
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  const { BrowserBridge } = await import('../server/browser-bridge.ts');
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');

  const getPort = async () => {
    const srv = createServer();
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const p = (srv.address() as { port: number }).port;
    await new Promise<void>(r => srv.close(() => r()));
    return p;
  };

  const dir = await mkdtemp(join(tmpdir(), 'browser-switch-sync-'));
  const bridge = new BrowserBridge(dir, async () => null);
  try {
    await bridge.start();
    const p = await getPort();
    await bridge.configure({ enabled: true, port: p });
    const pairing = await bridge.pairing();

    const bgState: Record<string, any> = {
      instanceId: 'inst-sync',
      instanceName: '测试浏览器',
      pairing,
      approvalAudit: [],
    };
    let startupFn: () => void = () => {};
    let bgMsgFn: any = null;
    const extOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const bgChrome = {
      storage: {
        local: {
          get: async (keys: any) => typeof keys === 'string' ? { [keys]: bgState[keys] } : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, bgState[k]])) : { ...bgState },
          set: async (vals: Record<string, any>) => {
            Object.assign(bgState, vals);
            if ('approvalEnabled' in vals) {
              enabledFlag = vals.approvalEnabled !== false;
              onStorageChanged({ approvalEnabled: { newValue: vals.approvalEnabled } }, 'local');
            }
          },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: {
        query: async () => [{ id: 1, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_struct123' }],
        sendMessage: async () => ({ title: '测试会话' }),
        group: async () => 1,
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      tabGroups: {
        get: async () => ({ id: 1, windowId: 1, title: '测试会话' }),
        update: async () => ({}),
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      runtime: {
        onStartup: { addListener: (fn: () => void) => { startupFn = fn; } },
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: (fn: any) => { bgMsgFn = fn; } },
      },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      scripting: {},
    };

    runInNewContext(backgroundSource, {
      chrome: bgChrome,
      fetch: (url: string, init: any) => fetch(url, { ...init, headers: { ...init.headers, origin: extOrigin } }),
      crypto: { randomUUID: () => `sync-uuid-${++uuid}` },
      AbortSignal, Map, Object, String, Number, Array, URL, Date, Promise, JSON, Set,
      setTimeout: (fn: () => void, d: number) => (d >= 2000 ? 0 : setTimeout(fn, d)),
      clearTimeout,
    });

    await new Promise(r => setTimeout(r, 80));
    assert.equal(bgState.approvalEnabled, true);

    // 关闭插件里的“网页版 claude.ai”总开关，触发扩展同步
    await bridge.configure({ enabled: false, port: p });
    startupFn();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(bgState.approvalEnabled, false, '插件关闭总开关后应同步 approvalEnabled=false 到扩展');

    // 总开关关闭时，后台拒绝 approval-reserve，内容脚本也不点击新权限卡
    const reserveWhenOff = await new Promise<any>(resolve => {
      bgMsgFn({ type: 'approval-reserve', digest: 'c'.repeat(64), button: 'Allow once' }, { tab: { id: 1, url: 'https://claude.ai/code/session_struct123' } }, resolve);
    });
    assert.equal(reserveWhenOff.allowed, false);

    const cardWhenOff = DomNode.fromTuple(directFixture.tree);
    body.appendChild(cardWhenOff);
    const allowWhenOff = cardWhenOff.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
    for (let step = 0; step < 20; step++) {
      while (timers.length) timers.shift()!();
      await Promise.resolve();
    }
    assert.equal(allowWhenOff.clicks, 0, '总开关关闭时不应点击权限卡');
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('记住此选择安全取消：等一帧渲染复核、label 与隐藏 input 去重只点一次、不触碰卡片根节点外的父级或外层 dialog 开关', async () => {
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));

  // 场景 A：label + 隐藏 input（若各点一次会勾回去），以及卡片外父节点 / 外层 dialog 上的开关（绝不能被点）
  const card = DomNode.fromTuple(directFixture.tree);
  const cardRoot = card.matches('[data-approval-card-root]') ? card : card.querySelector('[data-approval-card-root]')!;
  const allowBtn = card.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;

  let rememberChecked = true;
  const hiddenInput = new DomNode('input', { id: 'rem-1', type: 'checkbox', 'aria-checked': 'true' }, []);
  hiddenInput.hidden = true;
  (hiddenInput as any).checked = true;
  const rememberLabel = new DomNode('label', { for: 'rem-1', role: 'checkbox', 'aria-checked': 'true' }, ['Remember this choice']);
  rememberLabel.appendChild(hiddenInput);

  const toggleRemember = () => {
    // 模拟真实框架：点击后下一轮渲染才更新 DOM 状态，且再次点击会重新勾回 true
    setTimeoutFlagged(() => {
      rememberChecked = !rememberChecked;
      (hiddenInput as any).checked = rememberChecked;
      hiddenInput.setAttribute('aria-checked', String(rememberChecked));
      rememberLabel.setAttribute('aria-checked', String(rememberChecked));
    });
  };
  rememberLabel.onClick = toggleRemember;
  hiddenInput.onClick = toggleRemember;
  cardRoot.appendChild(rememberLabel);

  const outerWrapper = new DomNode('div', {}, []);
  const outerParentSwitch = new DomNode('button', { role: 'switch', 'aria-checked': 'true' }, ['Page toggle']);
  outerWrapper.appendChild(outerParentSwitch);
  outerWrapper.appendChild(card);
  const outerDialog = new DomNode('div', { role: 'dialog' }, []);
  const outerDialogSwitch = new DomNode('input', { type: 'checkbox', 'aria-checked': 'true' }, []);
  (outerDialogSwitch as any).checked = true;
  outerDialog.appendChild(outerDialogSwitch);
  outerDialog.appendChild(outerWrapper);

  const body = new DomNode('body', {}, []);
  body.appendChild(outerDialog);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const timers: Array<() => void> = [];
  const setTimeoutFlagged = (fn: () => void) => { timers.push(fn); };
  const results: string[] = [];
  let uuid = 0;

  allowBtn.onClick = () => {
    assert.equal(rememberChecked, false, '点击 Allow once 时记住选择框必须真正变为未勾选');
    card.parentElement = null;
  };

  const context = {
    document: { documentElement: html, body, activeElement: body, querySelectorAll: (sel: string) => html.querySelectorAll(sel), querySelector: (sel: string) => html.querySelector(sel) },
    location: { origin: 'https://claude.ai', pathname: '/code/session_remember123' },
    chrome: {
      storage: { local: { get: async () => ({ approvalEnabled: true }) }, onChanged: { addListener: () => {} } },
      runtime: { sendMessage: async (msg: any) => {
        if (msg.type === 'approval-reserve') return { allowed: true, reservationId: `rem-${++uuid}` };
        if (msg.type === 'approval-result') results.push(msg.status);
      } },
    },
    crypto: { randomUUID: () => `rem-uuid-${++uuid}`, subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
    TextEncoder, Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); }, setInterval: () => {}, Date, WeakMap,
  };

  runInNewContext(source, context);
  for (let step = 0; step < 30; step++) {
    while (timers.length) timers.shift()!();
    await Promise.resolve();
  }

  assert.equal(outerParentSwitch.clicks, 0, '不应点击卡片父元素上的开关');
  assert.equal(outerDialogSwitch.clicks, 0, '不应点击外层 dialog 上的复选框');
  assert.equal(rememberLabel.clicks + hiddenInput.clicks, 1, 'label 与隐藏 input 去重后只能点一次');
  assert.equal(rememberChecked, false);
  assert.equal(allowBtn.clicks, 1);
  assert.deepEqual(results, ['dismissed']);
});

test('关闭网页版 claude.ai 模块并重载插件后最小桥接返回 approvalEnabled:false 使扩展停止点击；已配对连续同步失败超 3 分钟也自动置关', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  const { resolveInstance } = await import('../shared/instances.ts');
  const { startPlugin } = await import('../server/core/plugin.ts');
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));

  const getPort = async () => {
    const srv = createServer();
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const p = (srv.address() as { port: number }).port;
    await new Promise<void>(r => srv.close(() => r()));
    return p;
  };

  const home = await mkdtemp(join(tmpdir(), 'plugin-browser-off-'));
  const stateDir = join(home, 'github-subscriptions');
  const port = await getPort();
  const savedEnv = {
    PASEO_HOME: process.env.PASEO_HOME,
    PASEO_GHSUB_STATE_DIR: process.env.PASEO_GHSUB_STATE_DIR,
    PASEO_GHSUB_MACHINE_CONFIG: process.env.PASEO_GHSUB_MACHINE_CONFIG,
  };

  const makeFakeServer = () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const ctx = {
      handle: (contract: { name: string }, fn: (input: any) => Promise<any>) => { handlers.set(contract.name, fn); },
      registerProvider: () => {},
      registerUsageSource: () => {},
      registerSettings: () => ({ read: async () => ({ status: 'invalid', revision: '0', error: 'test' }), subscribe: () => () => {} }),
      addHook: () => () => {},
      on: () => () => {},
      before: () => () => {},
    };
    return { ctx: ctx as never, handlers };
  };

  const mountPlugin = () => {
    process.env.PASEO_HOME = home;
    process.env.PASEO_GHSUB_STATE_DIR = stateDir;
    delete process.env.PASEO_GHSUB_MACHINE_CONFIG;
    const host = makeFakeServer();
    try {
      const cleanup = startPlugin(host.ctx, resolveInstance('main'));
      return { handlers: host.handlers, cleanup };
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  let cleanup1: (() => Promise<void>) | undefined;
  let cleanup2: (() => Promise<void>) | undefined;
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'machine.json'), JSON.stringify({
      version: 1,
      modules: {
        'answer.browser': true,
        'answer.presence': false,
        github: false,
        todo: false,
        'todo.stalled': false,
        'answer.escalation': false,
        'answer.quietChildren': false,
        'usage.claudeAccounts': false,
        'usage.providerQuotas': false,
        'providers.antigravity': false,
        'providers.cloudSession': false,
        'providers.cloudGateway': false,
        'sessions.defaults': false,
      },
    }));

    const first = mountPlugin();
    cleanup1 = first.cleanup;
    await first.handlers.get('browser.configure')!({ enabled: true, port });
    const pairing = await first.handlers.get('browser.pairing')!({});

    // 启动扩展后台 + 内容脚本
    const body = new DomNode('body', {}, []);
    const html = new DomNode('html', {}, []);
    html.appendChild(body);

    let nowMs = 1_700_000_000_000;
    const FakeDate = Object.assign(
      function (...args: any[]) { return args.length ? new (Date as any)(...args) : new Date(nowMs); },
      { now: () => nowMs, parse: Date.parse, UTC: Date.UTC },
    );

    const bgState: Record<string, any> = { instanceId: 'inst-reload', instanceName: '重载测试浏览器', pairing, approvalAudit: [] };
    let onContentStorageChanged: (changes: any, area: string) => void = () => {};
    let startupFn: () => void = () => {};
    let bgMsgFn: any = null;
    const extOrigin = `chrome-extension://${'b'.repeat(32)}`;
    const contentTimers: Array<() => void> = [];
    let uuid = 0;

    const bgChrome = {
      storage: {
        local: {
          get: async (keys: any) => typeof keys === 'string' ? { [keys]: bgState[keys] } : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, bgState[k]])) : { ...bgState },
          set: async (vals: Record<string, any>) => {
            Object.assign(bgState, vals);
            if ('approvalEnabled' in vals) {
              onContentStorageChanged({ approvalEnabled: { newValue: vals.approvalEnabled } }, 'local');
            }
          },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: {
        query: async () => [{ id: 1, windowId: 1, groupId: -1, url: 'https://claude.ai/code/session_reload123' }],
        sendMessage: async () => ({ title: '重载会话' }),
        group: async () => 1,
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      tabGroups: {
        get: async () => ({ id: 1, windowId: 1, title: '重载会话' }),
        update: async () => ({}),
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      runtime: {
        onStartup: { addListener: (fn: () => void) => { startupFn = fn; } },
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: (fn: any) => { bgMsgFn = fn; } },
      },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      scripting: {},
    };

    runInNewContext(backgroundSource, {
      chrome: bgChrome,
      fetch: (url: string, init: any) => fetch(url, { ...init, headers: { ...init.headers, origin: extOrigin } }),
      crypto: { randomUUID: () => `rl-bg-${++uuid}` },
      AbortSignal, Map, Object, String, Number, Array, URL, Date: FakeDate, Promise, JSON, Set,
      setTimeout: (fn: () => void, d: number) => (d >= 2000 ? 0 : setTimeout(fn, d)),
      clearTimeout,
    });

    const contentContext = {
      document: { documentElement: html, body, activeElement: body, querySelectorAll: (sel: string) => html.querySelectorAll(sel), querySelector: (sel: string) => html.querySelector(sel) },
      location: { origin: 'https://claude.ai', pathname: '/code/session_reload123' },
      chrome: {
        storage: {
          local: { get: async () => ({ approvalEnabled: bgState.approvalEnabled }) },
          onChanged: { addListener: (fn: typeof onContentStorageChanged) => { onContentStorageChanged = fn; } },
        },
        runtime: {
          sendMessage: (msg: any) => new Promise(resolve => {
            if (bgMsgFn(msg, { tab: { id: 1, url: 'https://claude.ai/code/session_reload123' } }, resolve) !== true) resolve(null);
          }),
        },
      },
      crypto: { randomUUID: () => `rl-ct-${++uuid}`, subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
      TextEncoder, Uint8Array,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { observe() {} },
      setTimeout: (fn: () => void) => { contentTimers.push(fn); },
      setInterval: () => {},
      Date: FakeDate, WeakMap,
    };
    runInNewContext(source, contentContext);

    await new Promise(r => setTimeout(r, 80));
    assert.equal(bgState.approvalEnabled, true, '开启模块时扩展同步到 approvalEnabled===true');

    // 先验证开启时能自动点第一张卡
    const cardOn = DomNode.fromTuple(directFixture.tree);
    const allowOn = cardOn.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
    allowOn.onClick = () => { cardOn.parentElement = null; };
    body.appendChild(cardOn);
    onContentStorageChanged({ approvalEnabled: { newValue: true } }, 'local');
    for (let step = 0; step < 25; step++) {
      while (contentTimers.length) contentTimers.shift()!();
      await new Promise(r => setImmediate(r));
    }
    assert.equal(allowOn.clicks, 1, '模块开启时应自动点击权限卡');

    // 关闭 answer.browser 模块并模拟插件重载（扩展在重载完成前未同步，保留旧值 true）
    await first.handlers.get('machine.settings.toggle-module')!({ id: 'answer.browser', enabled: false });
    await Promise.race([cleanup1(), new Promise(r => setTimeout(r, 1000))]);
    cleanup1 = undefined;
    assert.equal(bgState.approvalEnabled, true, '重载完成前扩展仍保留旧值 true');

    const second = mountPlugin();
    cleanup2 = second.cleanup;
    assert.equal(second.handlers.has('browser.snapshot'), false, '关闭模块重载后 answer.browser 模块不再注册 RPC');

    // 给最小桥接启动留一点时间，随后扩展按周期同步，必须收到 approvalEnabled: false 并停止点击
    await new Promise(r => setTimeout(r, 80));
    startupFn();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(bgState.approvalEnabled, false, '关闭模块并重载后最小桥接应向扩展返回 approvalEnabled: false');

    const cardAfterReload = DomNode.fromTuple(directFixture.tree);
    const allowAfterReload = cardAfterReload.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
    body.appendChild(cardAfterReload);
    for (let step = 0; step < 25; step++) {
      while (contentTimers.length) contentTimers.shift()!();
      await new Promise(r => setImmediate(r));
    }
    assert.equal(allowAfterReload.clicks, 0, '关闭模块重载同步后扩展不得再点击权限卡');

    // 验证兜底 ②：若已配对且当前 approvalEnabled===true，但桥接彻底停止（连续同步失败），超过 3 分钟后自动置为 false
    await Promise.race([cleanup2(), new Promise(r => setTimeout(r, 1000))]);
    cleanup2 = undefined;
    await bgChrome.storage.local.set({ approvalEnabled: true });
    assert.equal(bgState.approvalEnabled, true);

    startupFn();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(bgState.approvalEnabled, true, '首次同步失败未满 3 分钟时暂不置 false');

    nowMs += 60_000;
    startupFn();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(bgState.approvalEnabled, true, '连续失败 1 分钟未超 3 分钟');

    nowMs += 121_000;
    startupFn();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(bgState.approvalEnabled, false, '已配对但连续同步失败超过 3 分钟后自动置 approvalEnabled 为 false');

    for (let step = 0; step < 25; step++) {
      while (contentTimers.length) contentTimers.shift()!();
      await new Promise(r => setImmediate(r));
    }
    assert.equal(allowAfterReload.clicks, 0, '超过 3 分钟断连置关后内容脚本不点击权限卡');
  } finally {
    await Promise.race([cleanup1?.().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
    await Promise.race([cleanup2?.().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
    await rm(home, { recursive: true, force: true });
  }
});

test('复审：未配对或配对地址格式无效时立即将 approvalEnabled 置为 false 并停止点击；ExitPlanMode 标题/aria-label 卡片不自动点而正文含 plan 的普通权限卡仍自动点', async () => {
  const backgroundSource = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const directFixture = JSON.parse(await readFile(new URL('./fixtures/claude-web/permission-mcp-direct.json', import.meta.url), 'utf8'));

  // 1. 验证未配对与配对格式无效时立即置 approvalEnabled = false（无需等 3 分钟）
  const bgState: Record<string, any> = {
    instanceId: 'inst-unpair',
    pairing: { url: 'https://evil.example/sync', token: 'a'.repeat(64) },
    approvalEnabled: true,
    approvalAudit: [],
  };
  let startupFn: () => void = () => {};
  let bgMsgFn: any = null;
  const bgChrome = {
    storage: {
      local: {
        get: async (keys: any) => typeof keys === 'string' ? { [keys]: bgState[keys] } : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, bgState[k]])) : { ...bgState },
        set: async (vals: Record<string, any>) => { Object.assign(bgState, vals); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { query: async () => [], onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    tabGroups: { onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    runtime: {
      onStartup: { addListener: (fn: () => void) => { startupFn = fn; } },
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn: any) => { bgMsgFn = fn; } },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    scripting: {},
  };

  runInNewContext(backgroundSource, {
    chrome: bgChrome,
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    crypto: { randomUUID: () => 'unpair-uuid' },
    AbortSignal, Map, Object, String, Number, Array, URL, Date, Promise, JSON, Set,
    setTimeout: (fn: () => void, d: number) => (d >= 2000 ? 0 : setTimeout(fn, d)),
    clearTimeout,
  });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(bgState.approvalEnabled, false, '配对地址格式无效时应立即将 approvalEnabled 置为 false');

  // 模拟解除配对（无 pairing）但旧值为 true
  delete bgState.pairing;
  bgState.approvalEnabled = true;
  startupFn();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(bgState.approvalEnabled, false, '无配对时应立即将 approvalEnabled 置为 false');

  // 即使 reconcile 尚未跑，未配对时 approval-reserve 也必须拒绝并置 false
  bgState.approvalEnabled = true;
  const reserveUnpaired = await new Promise<any>(resolve => {
    bgMsgFn({ type: 'approval-reserve', digest: 'd'.repeat(64), button: 'Allow once' }, { tab: { id: 1, url: 'https://claude.ai/code/session_unpair123' } }, resolve);
  });
  assert.equal(reserveUnpaired.allowed, false, '未配对时 approval-reserve 必须拒绝');
  assert.equal(bgState.approvalEnabled, false);

  // 2. 验证计划确认卡（ExitPlanMode）：根 aria-label 或标题区含 ExitPlanMode / exit plan mode 不点；正文含 plan 的普通权限卡仍自动点
  const planAriaCard = DomNode.fromTuple(directFixture.tree);
  planAriaCard.querySelector('[data-approval-card-root]')!.setAttribute('aria-label', 'Permission request: ExitPlanMode');
  const planAriaAllow = planAriaCard.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;

  const planTitleCard = DomNode.fromTuple(directFixture.tree);
  planTitleCard.querySelector('[data-testid="approval-title-region"]')!.setText('Allow Claude to use ExitPlanMode?');
  const planTitleAllow = planTitleCard.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;

  const normalPlanBodyCard = DomNode.fromTuple(directFixture.tree);
  const normalRoot = normalPlanBodyCard.querySelector('[data-approval-card-root]')!;
  normalRoot.setAttribute('aria-label', 'Permission request: use bash');
  normalPlanBodyCard.querySelector('[data-testid="approval-title-region"]')!.setText('Allow Claude to run bash?');
  normalRoot.appendChild(new DomNode('pre', {}, ['echo "review plan and ExitPlanMode handling"']));
  const normalAllow = normalPlanBodyCard.querySelectorAll('button').find(b => b.innerText.includes('Allow once'))!;
  normalAllow.onClick = () => { normalPlanBodyCard.parentElement = null; };

  const body = new DomNode('body', {}, []);
  body.appendChild(planAriaCard);
  body.appendChild(planTitleCard);
  body.appendChild(normalPlanBodyCard);
  const html = new DomNode('html', {}, []);
  html.appendChild(body);

  const timers: Array<() => void> = [];
  let uuid = 0;
  runInNewContext(source, {
    document: { documentElement: html, body, activeElement: body, querySelectorAll: (sel: string) => html.querySelectorAll(sel), querySelector: (sel: string) => html.querySelector(sel) },
    location: { origin: 'https://claude.ai', pathname: '/code/session_planmode123' },
    chrome: {
      storage: { local: { get: async () => ({ approvalEnabled: true }) }, onChanged: { addListener: () => {} } },
      runtime: { sendMessage: async (msg: any) => msg.type === 'approval-reserve' ? { allowed: true, reservationId: `pm-${++uuid}` } : { allowed: true } },
    },
    crypto: { randomUUID: () => `pm-uuid-${++uuid}`, subtle: { digest: async (_alg: string, data: Uint8Array) => createHash('sha256').update(data).digest() } },
    TextEncoder, Uint8Array,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.push(fn); },
    setInterval: () => {},
    Date, WeakMap,
  });

  for (let step = 0; step < 30; step++) {
    while (timers.length) timers.shift()!();
    await Promise.resolve();
  }

  assert.equal(planAriaAllow.clicks, 0, '根 aria-label 含 ExitPlanMode 的计划确认卡不应自动点击');
  assert.equal(planTitleAllow.clicks, 0, '标题区含 ExitPlanMode 的计划确认卡不应自动点击');
  assert.equal(normalAllow.clicks, 1, '正文含 plan 字样的普通权限卡仍应自动点击');
});
