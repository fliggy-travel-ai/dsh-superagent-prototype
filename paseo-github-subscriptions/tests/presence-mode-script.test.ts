import test from 'node:test';
import assert from 'node:assert/strict';
import { runPresenceMode } from '../scripts/presence-mode-lib.ts';

function client(initial: string, observation = 'offline') {
  const settings = { mode: initial, paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' };
  const calls: Array<[string, unknown]> = [];
  return { calls, settings, invokePluginRpc: async (_id: string, method: string, input: unknown) => {
    calls.push([method, input]);
    if (method === 'presence.configure') Object.assign(settings, input);
    return { settings: { ...settings }, observation: { mode: settings.mode === 'auto' ? observation : settings.mode, reason: 'r' } };
  } };
}

test('切换只改 mode，其余设置保持，读回一致时退出码 0', async () => {
  const c = client('auto');
  const result = await runPresenceMode(c, 'offline');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(c.calls[1], ['presence.configure', { mode: 'offline', paused: false, speechEnabled: true, sourceHostId: 'srv_macbook' }]);
});

test('status 用退出码表示判定：在线 20、离线 21、未知 22', async () => {
  assert.equal((await runPresenceMode(client('online'), 'status')).exitCode, 20);
  assert.equal((await runPresenceMode(client('auto', 'offline'), 'status')).exitCode, 21);
  assert.equal((await runPresenceMode(client('auto', 'unknown'), 'status')).exitCode, 22);
});

test('非法参数拒绝且不调用切换', async () => {
  const c = client('auto');
  await assert.rejects(runPresenceMode(c, 'away'), /只能是/);
  assert.equal(c.calls.length, 0);
});
