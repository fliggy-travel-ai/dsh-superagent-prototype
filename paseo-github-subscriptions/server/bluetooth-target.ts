import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BluetoothConfigSchema, BluetoothTargetSchema, type BluetoothConfig, type BluetoothSnapshot, type BluetoothTarget } from '../shared/bluetooth.ts';

export const guardDirectory = () => join(homedir(), '.claude-guard');
const execute = promisify(execFile);
export async function readBluetoothConfig(directory = guardDirectory()): Promise<BluetoothConfig | null> {
  let file;
  try { file = await open(join(directory, 'proximity-target.json'), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    if ((await file.stat()).size > 4096) throw new Error('设备配置过大');
    return BluetoothConfigSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
export async function saveBluetoothTarget(input: BluetoothTarget, directory = guardDirectory()): Promise<BluetoothConfig> {
  const target = { ...BluetoothTargetSchema.parse(input), revision: randomUUID() };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, 'proximity-target.json');
  const temporary = `${destination}.${target.revision}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(target)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination);
    return target;
  } finally { await rm(temporary, { force: true }); }
}
export function parseBluetoothDevices(raw: unknown): BluetoothSnapshot['devices'] {
  const devices: BluetoothSnapshot['devices'] = [];
  if (!raw || typeof raw !== 'object') throw new Error('蓝牙报告无效');
  const controllers = (raw as Record<string, unknown>).SPBluetoothDataType;
  if (!Array.isArray(controllers)) throw new Error('蓝牙报告缺少设备信息');
  for (const controller of controllers) for (const category of ['device_connected', 'device_not_connected']) {
    for (const entry of controller?.[category] ?? []) for (const [name, properties] of Object.entries(entry)) {
      if (!properties || typeof properties !== 'object') continue;
      const values = properties as Record<string, unknown>;
      const address = typeof values.device_address === 'string' ? values.device_address.replaceAll('-', ':').toUpperCase() : null;
      const target = BluetoothTargetSchema.safeParse({ name, address });
      if (!target.success) continue;
      const signal = typeof values.device_rssi === 'number' || typeof values.device_rssi === 'string' ? Number(values.device_rssi) : NaN;
      const device = { ...target.data, connected: category === 'device_connected', rssi: Number.isFinite(signal) && signal < 0 && signal >= -127 ? signal : null };
      const previous = address ? devices.find(item => item.address === address) : undefined;
      if (!previous) devices.push(device);
      else if (device.connected) Object.assign(previous, device);
    }
  }
  return devices;
}
let cached: { at: number; devices: BluetoothSnapshot['devices'] } | undefined;
let pending: Promise<BluetoothSnapshot['devices']> | undefined;
async function scan() {
  if (cached && Date.now() - cached.at < 10_000) return cached.devices;
  pending ??= execute('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], { timeout: 22_000, maxBuffer: 2_000_000 })
    .then(({ stdout }) => { const devices = parseBluetoothDevices(JSON.parse(stdout)); cached = { at: Date.now(), devices }; return devices; })
    .finally(() => { pending = undefined; });
  return pending;
}
export async function listBluetoothTargets(directory = guardDirectory(), discover = scan): Promise<BluetoothSnapshot> {
  let configError: string | null = null;
  let target = await readBluetoothConfig(directory).catch(() => { configError = '设备配置损坏，请重新选择设备'; return null; });
  if (!target) {
    let reported: BluetoothConfig | undefined;
    try {
      const file = await open(join(directory, 'proximity-state.json'), 'r');
      try { if ((await file.stat()).size <= 16_384) reported = BluetoothConfigSchema.parse(JSON.parse(await file.readFile('utf8')).target); }
      finally { await file.close(); }
    } catch {}
    target = reported ?? { name: process.env.PROX_DEVICE || '贝贝猫的iPhone', address: null, revision: 'legacy' };
  }
  try { return { target, devices: await discover(), error: configError }; }
  catch { return { target, devices: [], error: configError ?? '蓝牙设备刷新失败，已保留当前选择；请检查来源主机的蓝牙状态' }; }
}
