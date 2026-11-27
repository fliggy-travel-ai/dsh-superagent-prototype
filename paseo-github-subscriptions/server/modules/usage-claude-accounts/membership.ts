import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageDetail } from '@getpaseo/plugin/server/usage';
import { z } from 'zod';
import { MembershipEmailSchema, MembershipRenewalSchema, type MembershipRenewal } from '../../../shared/claude-membership.ts';

const MembershipFileSchema = z.record(MembershipEmailSchema, MembershipRenewalSchema);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Asia/Shanghai 的当前续费日历使用 UTC+08:00。UTC 方法只操作转换后的北京时间。
const SHANGHAI_OFFSET = 8 * HOUR;
const pad = (value: number) => String(value).padStart(2, '0');

export function membershipDetail(renewal: MembershipRenewal | undefined, now = Date.now()): UsageDetail | undefined {
  if (!renewal) return;
  const local = new Date(now + SHANGHAI_OFFSET);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const [hours, minutes] = renewal.time.split(':').map(Number);
  const occurrence = (monthIndex: number) => {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return Date.UTC(year, monthIndex, Math.min(renewal.day, lastDay), hours, minutes);
  };
  const current = occurrence(month);
  const next = current >= local.getTime() ? current : occurrence(month + 1);
  const remaining = next - local.getTime();
  const days = Math.floor(remaining / DAY);
  const wholeHours = Math.floor(remaining / HOUR);
  const wholeMinutes = Math.floor(remaining / MINUTE);
  const countdown = days >= 1 ? `${days}天${wholeHours % 24}小时`
    : wholeHours >= 1 ? `${wholeHours}小时${wholeMinutes % 60}分` : `${wholeMinutes}分`;
  const date = new Date(next);
  return {
    id: 'membership_renewal',
    label: '会员到期',
    value: `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${renewal.time}（剩 ${countdown}）`,
    tone: remaining < DAY ? 'danger' : remaining < 3 * DAY ? 'warning' : 'default',
  };
}

export class MembershipStore {
  private readonly directory: string;
  private readonly path: string;
  private lastReadError: string | null = null;

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, 'membership-renewals.json');
  }

  read(): Record<string, MembershipRenewal> {
    let content: string;
    try { content = readFileSync(this.path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      throw new Error(`会员到期设置文件无法读取（${code ?? '未知错误'}）`);
    }
    try { return MembershipFileSchema.parse(JSON.parse(content)); }
    catch { throw new Error('会员到期设置文件格式无效，请检查 membership-renewals.json'); }
  }

  set(email: string, renewal: MembershipRenewal | null): void {
    const entries = this.read();
    if (renewal === null) {
      if (!Object.hasOwn(entries, email)) return;
      delete entries[email];
    } else {
      entries[MembershipEmailSchema.parse(email)] = MembershipRenewalSchema.parse(renewal);
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      writeFileSync(temp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* 保留原写入错误。 */ }
      throw new Error(`会员到期设置文件无法保存（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）`);
    }
  }

  detail(email: string): UsageDetail | undefined {
    let renewal: MembershipRenewal | undefined;
    try {
      renewal = this.read()[email];
      this.lastReadError = null;
    } catch (error) {
      const message = (error as Error).message;
      if (this.lastReadError !== message) console.warn(message);
      this.lastReadError = message;
    }
    return membershipDetail(renewal);
  }
}
