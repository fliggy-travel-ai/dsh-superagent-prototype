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
