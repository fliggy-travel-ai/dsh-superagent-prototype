import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBluetoothTargets, parseBluetoothDevices, readBluetoothConfig, saveBluetoothTarget } from '../server/bluetooth-target.ts';

test('设备配置原子保存，换回相同设备仍产生新版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bluetooth-target-'));
  try {
    assert.equal(await readBluetoothConfig(directory), null);
    const target = { name: '随身手机', address: 'AA:BB:CC:DD:EE:01' };
    const first = await saveBluetoothTarget(target, directory);
    const second = await saveBluetoothTarget(target, directory);
    assert.notEqual(first.revision, second.revision);
    assert.deepEqual(await readBluetoothConfig(directory), second);
    assert.equal((await stat(join(directory, 'proximity-target.json'))).mode & 0o777, 0o600);
    await assert.rejects(saveBluetoothTarget({ ...target, name: 'bad\nname' }, directory));
    assert.deepEqual(await readBluetoothConfig(directory), second);
    await writeFile(join(directory, 'proximity-target.json'), '{bad');
    const snapshot = await listBluetoothTargets(directory, async () => [{ ...target, connected: true, rssi: -60 }]);
    assert.match(snapshot.error ?? '', /配置损坏/);
    assert.equal(snapshot.devices.length, 1);
    await writeFile(join(directory, 'proximity-target.json'), 'x'.repeat(4097));
    await assert.rejects(readBluetoothConfig(directory), /过大/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('设备列表只合并相同地址，保留没有地址的同名设备', () => {
  const devices = parseBluetoothDevices({ SPBluetoothDataType: [{ device_connected: [
    { 手机: { device_address: 'aa-bb-cc-dd-ee-01', device_rssi: '-61' } },
    { 手机: { device_address: 'aa-bb-cc-dd-ee-02', device_rssi: '-90' } },
    { 耳机: {} }, { 耳机: {} },
  ], device_not_connected: [{ 手机: { device_address: 'aa-bb-cc-dd-ee-01' } }] }] });
  assert.equal(devices.length, 4);
  assert.equal(devices[0].address, 'AA:BB:CC:DD:EE:01');
  assert.equal(devices[0].rssi, -61);
  assert.equal(devices[0].connected, true);
});
