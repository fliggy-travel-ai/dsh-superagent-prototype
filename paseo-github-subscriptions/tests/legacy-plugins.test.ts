import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyPluginEnabled, legacyPluginStatus } from '../server/core/legacy-plugins.ts';
import { startWithRetry } from '../server/core/start-retry.ts';

test('旧插件在 config.json 的 plugins 中且没有停用，算仍启用', () => {
  const home = mkdtempSync(join(tmpdir(), 'legacy-plugins-'));
  try {
    assert.equal(legacyPluginEnabled(home, 'old'), false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: { old: { enabled: true }, off: { enabled: false }, bare: {} } }));
    assert.equal(legacyPluginEnabled(home, 'old'), true);
    assert.equal(legacyPluginEnabled(home, 'bare'), true);
    assert.equal(legacyPluginEnabled(home, 'off'), false);
    assert.equal(legacyPluginEnabled(home, 'missing'), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('config.json 不存在才算没启用；读不到或解析失败按仍启用处理并给出原因', () => {
  const home = mkdtempSync(join(tmpdir(), 'legacy-plugins-'));
  try {
    assert.deepEqual(legacyPluginStatus(home, 'old'), { enabled: false, problem: null });
    writeFileSync(join(home, 'config.json'), '{坏');
    const broken = legacyPluginStatus(home, 'old');
    assert.equal(broken.enabled, true);
    assert.match(broken.problem!, /config\.json.*无法解析.*按旧插件仍启用/);
    assert.equal(legacyPluginEnabled(home, 'old'), true);
    rmSync(join(home, 'config.json'));
    mkdirSync(join(home, 'config.json'));
    assert.equal(legacyPluginStatus(home, 'old').enabled, true);
    assert.match(legacyPluginStatus(home, 'old').problem!, /无法读取/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('启动失败后按间隔重试，成功后停止；停止信号取消重试', async () => {
  const controller = new AbortController();
  let calls = 0; const errors: string[] = [];
  await startWithRetry(async () => { calls++; if (calls < 3) throw new Error(`第${calls}次失败`); }, { delayMs: 1, signal: controller.signal, onError: error => errors.push((error as Error).message) });
  assert.equal(calls, 3);
  assert.deepEqual(errors, ['第1次失败', '第2次失败']);
  const stop = new AbortController(); let attempts = 0;
  const waiting = startWithRetry(async () => { attempts++; throw new Error('一直失败'); }, { delayMs: 5, signal: stop.signal, onError: () => { if (attempts === 2) stop.abort(); } });
  await waiting;
  assert.equal(attempts, 2);
});
