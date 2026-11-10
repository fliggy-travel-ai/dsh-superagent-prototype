import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeRpc, parseRpcArgs } from '../scripts/rpc-lib.ts';

test('只允许指定操作或只读快照，输入须是 JSON 对象', () => {
  for (const method of ['capacity.snapshot', 'capacity.clear-review', 'dispatch.finalize', 'escalation.snapshot']) assert.equal(parseRpcArgs([method, '{}']).method, method);
  for (const method of ['capacity.clear', 'plugin.reload', 'snapshot', '.snapshot', 'unknown.snapshot']) assert.throws(() => parseRpcArgs([method, '{}']));
  assert.throws(() => parseRpcArgs(['capacity.snapshot', '[]'])); assert.throws(() => parseRpcArgs(['capacity.snapshot', '{']));
});
test('RPC 使用主实例并隐藏返回值中的连接信息与凭据', async () => {
  let actual: unknown;
  const result = await invokeRpc({ invokePluginRpc: async (...args) => { actual = args; return { count: 1, hostname: 'example.invalid', serverId: 'local-id', privateKey: 'sample', token: 'sample', nested: [{ url: 'https://example.invalid', value: 'ok' }], info: 'token=sample-value example.invalid' }; } }, 'capacity.snapshot', {});
  assert.deepEqual(actual, ['github-subscriptions', 'capacity.snapshot', {}]); assert.deepEqual(result, { count: 1, nested: [{ value: 'ok' }], info: 'token=[已隐藏] [已隐藏地址]' });
});
