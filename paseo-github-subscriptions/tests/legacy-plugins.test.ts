import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyPluginEnabled } from '../server/core/legacy-plugins.ts';
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
    writeFileSync(join(home, 'config.json'), '{坏');
    assert.equal(legacyPluginEnabled(home, 'old'), false);
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
