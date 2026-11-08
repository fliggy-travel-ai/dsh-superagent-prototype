import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuardPresence, speakGuardNotification } from '../server/guard-presence.ts';
import { saveBluetoothTarget } from '../server/bluetooth-target.ts';

test('选设备后核对实际采样版本和标志归属，手动覆盖不依赖设备', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-target-'));
  const write = async (extra: Record<string, unknown>) => {
    await writeFile(join(directory, 'auto-answer.flag'), '0');
    await writeFile(join(directory, 'proximity-state.json'), JSON.stringify({ flag: '0', forced_away: false, override_until: 0, rssi: -60, seen: true, ...extra }));
  };
  try {
    const target = await saveBluetoothTarget({ name: '随身手机', address: null }, directory);
    await write({}); assert.match((await readGuardPresence(directory)).reason, /采样程序未更新/);
    await write({ target: { ...target, revision: 'old' } }); assert.match((await readGuardPresence(directory)).reason, /等待来源主机采样/);
    await write({ target }); assert.match((await readGuardPresence(directory)).reason, /稳定判定/);
    await write({ target, flag_target: target }); assert.equal((await readGuardPresence(directory)).mode, 'online');
    await saveBluetoothTarget({ name: '随身手机', address: null }, directory);
    assert.equal((await readGuardPresence(directory)).mode, 'unknown');
    await write({ override_until: Date.now() / 1000 + 120, seen: false, rssi: null });
    assert.equal((await readGuardPresence(directory)).mode, 'online');
    await writeFile(join(directory, 'proximity-target.json'), '{bad');
    await write({ target, flag_target: target }); assert.match((await readGuardPresence(directory)).reason, /配置损坏/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('按旧 guard 状态判断蓝牙和手动模式，并拒绝失联或不一致状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-presence-'));
  const statePath = join(dir, 'proximity-state.json');
  const write = async (extra: Record<string, unknown>, flag = '0') => {
    await writeFile(join(dir, 'auto-answer.flag'), flag);
    await writeFile(statePath, JSON.stringify({ flag, forced_away: false, override_until: 0, rssi: -70, seen: true, ...extra }));
  };
  try {
    assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await write({});
    let result = await readGuardPresence(dir);
    assert.equal(result.mode, 'online'); assert.equal(result.source, 'bluetooth'); assert.ok(result.observedAt);
    await write({ rssi: -90 }, '1');
    result = await readGuardPresence(dir); assert.equal(result.mode, 'offline'); assert.equal(result.source, 'bluetooth');
    await write({ rssi: null, seen: false });
    result = await readGuardPresence(dir); assert.equal(result.mode, 'unknown'); assert.equal(result.source, 'bluetooth');
    await write({ rssi: null, seen: true }); assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await write({ forced_away: true, rssi: null, seen: false }, '1');
    result = await readGuardPresence(dir); assert.equal(result.mode, 'offline'); assert.equal(result.source, 'manual');
    await write({ override_until: Date.now() / 1000 + 120, rssi: null, seen: false });
    result = await readGuardPresence(dir); assert.equal(result.mode, 'online'); assert.equal(result.source, 'manual');
    await writeFile(join(dir, 'auto-answer.flag'), '1');
    assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await write({ forced_away: true }, '0'); assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await write({ forced_away: true }, '1');
    const old = new Date(Date.now() - 121_000); await utimes(statePath, old, old);
    result = await readGuardPresence(dir); assert.equal(result.mode, 'unknown'); assert.equal(result.source, 'unavailable');
    const future = new Date(Date.now() + 30_000); await utimes(statePath, future, future); assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await writeFile(statePath, '{bad'); assert.equal((await readGuardPresence(dir)).mode, 'unknown');
    await write({ rssi: 'invalid' }); assert.equal((await readGuardPresence(dir)).mode, 'unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('语音使用参数数组调用 say，且验证与失败不播放真实声音', async () => {
  const calls: { executable: string; args: string[] }[] = [];
  const execute = async (executable: string, args: string[]) => { calls.push({ executable, args }); };
  await speakGuardNotification('有一个问题等待确认', execute);
  assert.deepEqual(calls, [{ executable: '/usr/bin/say', args: ['-v', 'Flo', '--rate', '200', '--', '有一个问题等待确认'] }]);
  await assert.rejects(speakGuardNotification('  ', execute));
  await assert.rejects(speakGuardNotification('x'.repeat(501), execute));
  await assert.rejects(speakGuardNotification('ok', async () => { throw new Error('playback failed'); }), /playback failed/);
  assert.equal(calls.length, 1);
});
