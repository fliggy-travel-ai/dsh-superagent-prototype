import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../browser-extension/activity.js', import.meta.url), 'utf8');
function page(options: { working?: boolean; streaming?: boolean; notice?: string; historical?: boolean; draft?: string; missingEditor?: boolean; hidden?: boolean; origin?: string; pathname?: string } = {}) {
  const listeners = new Set<(message: unknown, sender: unknown, respond: (value: unknown) => void) => void>();
  const element = (text: string, attributes: Record<string,string> = {}) => ({ innerText: text, getAttribute: (key: string) => attributes[key] ?? null, getBoundingClientRect: () => ({ width: options.hidden ? 0 : 100, height: 50 }), closest: () => null as unknown });
  const prose = element('最后一条助手回复');
  const assistant = { ...element('', { 'data-is-streaming': String(options.streaming ?? false) }), querySelectorAll: () => [prose] };
  const notice = { ...element(options.notice ?? '', { role: 'alert' }), closest: () => options.historical ? assistant : null };
  const editor = element(options.draft ?? '', { contenteditable: 'true' });
  const context = { location: { origin: options.origin ?? 'https://claude.ai', pathname: options.pathname ?? '/code/session_abc' },
    document: { querySelector: (selector: string) => selector.includes('code-prompt-stop') ? options.working ? element('Stop') : null : options.missingEditor ? null : editor, querySelectorAll: (selector: string) => selector.includes('assistant-message') ? [assistant] : options.notice ? [notice] : [] },
    chrome: { runtime: { onMessage: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) } } }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), Date };
  runInNewContext(source, context);
  return { listeners, navigate: (pathname: string) => { context.location.pathname = pathname; }, inject: () => runInNewContext(source, context), read: () => { let result: any; for (const listener of listeners) listener({ type: 'read-activity' }, {}, value => { result = value; }); return result; } };
}

test('从列表进入会话时立即可读活动状态，离开会话后停止返回', () => {
  const fixture = page({ pathname: '/code' });
  assert.equal(fixture.read(), undefined);
  fixture.navigate('/code/session_abc');
  assert.equal(fixture.read().state, 'waiting');
  fixture.navigate('/code');
  assert.equal(fixture.read(), undefined);
});

test('网页运行标记优先于历史文本，结束后返回最后消息', () => {
  assert.equal(page({ working: true, notice: 'Session limit reached' }).read().state, 'working');
  assert.equal(page({ streaming: true }).read().state, 'working');
  const result = page().read(); assert.equal(result.state, 'waiting'); assert.equal(result.lastMessage, '最后一条助手回复');
});
test('仅识别可见通知中的限额，历史回复与隐藏提示不误报', () => {
  assert.equal(page({ notice: 'Weekly limit reached. Resets tomorrow.' }).read().state, 'limited');
  assert.equal(page({ notice: 'Session limit reached', historical: true }).read().state, 'waiting');
  assert.equal(page({ notice: 'Session limit reached', hidden: true }).read().state, 'unknown');
});
test('输入草稿和缺失编辑器返回未知，重复注入只有一个监听', () => {
  assert.equal(page({ draft: '尚未发送' }).read().state, 'unknown');
  assert.equal(page({ missingEditor: true }).read().state, 'unknown');
  const fixture = page(); fixture.inject(); assert.equal(fixture.listeners.size, 1);
  assert.equal(page({ origin: 'https://example.com' }).listeners.size, 0);
});
