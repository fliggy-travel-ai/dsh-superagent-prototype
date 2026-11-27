import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeRpc, parseRpcArgs } from '../scripts/rpc-lib.ts';

test('只允许指定操作或只读快照，输入须是 JSON 对象', () => {
  for (const method of ['capacity.snapshot', 'capacity.clear-review', 'dispatch.finalize', 'escalation.snapshot', 'modules.status']) assert.equal(parseRpcArgs([method, '{}']).method, method);
  for (const method of ['capacity.clear', 'plugin.reload', 'snapshot', '.snapshot', 'unknown.snapshot']) assert.throws(() => parseRpcArgs([method, '{}']));
  assert.throws(() => parseRpcArgs(['capacity.snapshot', '[]'])); assert.throws(() => parseRpcArgs(['capacity.snapshot', '{']));
});
test('RPC 使用主实例并隐藏返回值中的连接信息与凭据', async () => {
  let actual: unknown;
  const result = await invokeRpc({ invokePluginRpc: async (...args) => { actual = args; return { count: 1, hostname: 'example.invalid', email: 'private-value', serverId: 'local-id', privateKey: 'sample', token: 'sample', nested: [{ url: 'https://example.invalid', value: 'ok' }], info: 'token=sample-value example.invalid' }; } }, 'capacity.snapshot', {});
  assert.deepEqual(actual, ['github-subscriptions', 'capacity.snapshot', {}]); assert.deepEqual(result, { count: 1, nested: [{ value: 'ok' }], info: 'token=[已隐藏] [已隐藏地址]' });
});
test('模块状态原样输出模块 ID，原因仍脱敏', async () => {
  const snapshot = { instance: { role: 'main', legacy: true }, config: { path: '/tmp/machine.json', source: 'file', errors: [] }, modules: [{ id: 'answer.browser', label: '网页版 claude.ai', state: 'error', reason: '连接 example.invalid 失败' }] };
  const result = await invokeRpc({ invokePluginRpc: async () => snapshot }, 'modules.status', {}) as { modules: { id: string; state: string; reason: string }[] };
  assert.equal(result.modules[0]!.id, 'answer.browser');
  assert.equal(result.modules[0]!.state, 'error');
  assert.equal(result.modules[0]!.reason, '连接 [已隐藏地址] 失败');
});
