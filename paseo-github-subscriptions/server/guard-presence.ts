import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readBluetoothConfig } from './bluetooth-target.ts';

export type GuardPresence = {
  mode: 'online' | 'offline' | 'unknown';
  observedAt: string | null;
  reason: string;
  source: 'bluetooth' | 'manual' | 'unavailable';
};

const MAX_AGE_MS = 120_000;
const MAX_FUTURE_MS = 5_000;
const say = promisify(execFile);

export async function readGuardPresence(directory = join(homedir(), '.claude-guard')): Promise<GuardPresence> {
  let observedAt: string | null = null;
  try {
    const file = await open(join(directory, 'proximity-state.json'), 'r');
    let contents: string;
    let modified: number;
    try {
      const stat = await file.stat();
      modified = stat.mtimeMs;
      if (!Number.isFinite(modified) || stat.size > 16_384) throw new Error('invalid state');
      contents = await file.readFile({ encoding: 'utf8' });
    } finally { await file.close(); }
    observedAt = new Date(modified).toISOString();
    const age = Date.now() - modified;
    if (age > MAX_AGE_MS || age < -MAX_FUTURE_MS) return { mode: 'unknown', observedAt, reason: '状态已过期或时间异常', source: 'unavailable' };
    const state: unknown = JSON.parse(contents);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state');
    const record = state as Record<string, unknown>;
    if ((record.flag !== '0' && record.flag !== '1') || typeof record.forced_away !== 'boolean' || typeof record.seen !== 'boolean' || typeof record.override_until !== 'number' || !Number.isFinite(record.override_until) || (record.rssi !== null && (typeof record.rssi !== 'number' || !Number.isFinite(record.rssi)))) throw new Error('invalid state');
    const flag = (await readFile(join(directory, 'auto-answer.flag'), 'utf8')).trim();
    if (flag !== record.flag) return { mode: 'unknown', observedAt, reason: '手动标志与采样状态尚未同步', source: 'unavailable' };
    if (record.forced_away && record.flag !== '1') return { mode: 'unknown', observedAt, reason: '手动覆盖状态不一致', source: 'unavailable' };
    if (record.forced_away || (record.flag === '0' && record.override_until * 1000 > Date.now())) return { mode: record.flag === '1' ? 'offline' : 'online', observedAt, reason: '手动覆盖', source: 'manual' };
    let target;
    try { target = await readBluetoothConfig(directory); }
    catch { return { mode: 'unknown', observedAt, reason: '设备配置损坏，请重新选择设备', source: 'unavailable' }; }
    const sampled = record.target as Record<string, unknown> | undefined;
    const owner = record.flag_target as Record<string, unknown> | undefined;
    if (target && !sampled) return { mode: 'unknown', observedAt, reason: '采样程序未更新，不支持设备选择', source: 'unavailable' };
    if (record.target_error) return { mode: 'unknown', observedAt, reason: '设备配置读取失败，请重新保存设备', source: 'unavailable' };
    if (target && (sampled?.revision !== target.revision || sampled?.name !== target.name || sampled?.address !== target.address)) return { mode: 'unknown', observedAt, reason: '设备已切换，等待来源主机采样', source: 'bluetooth' };
    if (!record.seen || record.rssi === null) return { mode: 'unknown', observedAt, reason: typeof record.sample_error === 'string' ? record.sample_error.slice(0, 200) : '设备未发现或蓝牙信号不可用', source: 'bluetooth' };
    if (sampled && (!owner || owner.revision !== sampled.revision || owner.name !== sampled.name || owner.address !== sampled.address)) return { mode: 'unknown', observedAt, reason: '新设备尚未得出稳定判定', source: 'bluetooth' };
    return { mode: record.flag === '1' ? 'offline' : 'online', observedAt, reason: '蓝牙采样状态', source: 'bluetooth' };
  } catch {
    return { mode: 'unknown', observedAt, reason: '状态文件不可用或无效', source: 'unavailable' };
  }
}

type SayExecutor = (executable: string, args: string[]) => Promise<void>;

export async function speakGuardNotification(text: string, execute: SayExecutor = async (executable, args) => { await say(executable, args, { timeout: 30_000 }); }): Promise<void> {
  if (!text.trim() || text.length > 500 || text.includes('\0')) throw new Error('语音提醒文本无效');
  await execute('/usr/bin/say', ['-v', 'Flo', '--rate', '200', '--', text]);
}
