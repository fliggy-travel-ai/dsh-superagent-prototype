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
    chrome: { storage: { local: { get: async () => ({ approvalEnabled: options.enabled }) }, onChanged: { addListener: (handler: typeof changes) => { changes = handler; } } }, runtime: { sendMessage: async (message: any) => {
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
  return { count: () => clicks, audit, button, scope, context, scan: async () => { repeat(); await flush(); }, toggle: async (enabled: boolean) => { changes({ approvalEnabled: { newValue: enabled } }, 'local'); await flush(); } };
}

test('安装默认自动点击，窗口仍显示时记录状态且不重复点击', async () => {
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

test('永久授权开关、计划正文和选择控件不触发权限点击', async () => {
  for (const options of [{ checked: true }, { outerChecked: true }, { outerPlan: true }, { title: 'Allow', text: 'Permission required. Remember this choice. Allow Deny' }, { title: 'Approve', text: 'Implement permission checks. Approve Reject' }, { text: 'Plan: update permissions. Allow once Deny' }, { radio: true }, { storageFailure: true }]) {
    assert.equal((await page(options)).count(), 0, JSON.stringify(options));
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

test('只点权限窗口，不点永久授权、禁用按钮、代码正文或选择题', async () => {
  for (const options of [{ title: 'Always allow' }, { title: 'Allow this session' }, { disabled: true }, { excluded: true }, { withDeny: false }, { title: 'Allow', text: 'Which option do you prefer? Allow Deny' }, { text: 'AskUserQuestion: Allow once (Recommended) Deny' }, { origin: 'https://other.example' }, { title: 'Approve', text: 'Choose an answer: Approve Deny' }]) {
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
    return this.children.flatMap(child => [child, ...child.descendants()]);
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

test('MCP 权限卡片样本：打开 More allow options 菜单只点 Allow once，无该项时按 Escape 关闭并记 skipped，永不点 Always allow', async () => {
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

    // 页面上另有一个 aria-labelledby 指向无关按钮的菜单，其内也有 Allow once，必须被忽略
    const strayItem = new DomNode('div', { role: 'menuitem' }, ['Allow once']);
    const strayMenu = new DomNode('div', { role: 'menu', 'aria-labelledby': 'unrelated-button-id' }, [strayItem]);
    body.appendChild(strayMenu);

    const createdMenuItems: DomNode[] = [];
    moreButton.onClick = () => {
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

  // 2. 菜单中只有 Always allow、没有 Allow once（即便页面其他菜单有 Allow once）：按 Escape 关闭菜单并记 skipped，永不点 Always allow 或其他菜单的 Allow once
  const missingRun = await runMcpScenario([{ role: 'menuitem', text: 'Always allow' }], true);
  assert.equal(missingRun.alwaysAllowButton.clicks, 0);
  assert.equal(missingRun.denyButton.clicks, 0);
  assert.equal(missingRun.moreButton.clicks, 1);
  assert.equal(missingRun.createdMenuItems[0]!.clicks, 0);
  assert.equal(missingRun.strayItem.clicks, 0);
  const escapeEvents = [...missingRun.moreButton.events, ...missingRun.body.events].filter(ev => ev?.key === 'Escape');
  assert.ok(escapeEvents.length >= 1);
  assert.deepEqual(missingRun.audit, [{ button: 'Allow once', status: 'skipped' }]);
});
