import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { hashAccountKey, toneFromUsedPct, unavailable, windowFromUsedPct, type UsageAccount, type UsageDetail, type UsageReport } from '@getpaseo/plugin/server/usage';
import { BrowserUsagePostSchema, BrowserUsageWindowSchema, type BrowserUsagePost, type BrowserUsageWindow } from '../shared/browser-usage.ts';
import type { BrowserBridge } from './browser-bridge.ts';

const MAX_AGE = 150_000;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 60 * 1000;
const WEEKLY_SYNC_DIFF_MS = 10 * 60 * 1000;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserUsageInputSchema = z.strictObject({ instanceId: id });

const StoredRecordSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().trim().min(1).max(120),
  lastPostAt: z.number().finite(),
  status: z.enum(['pending', 'ok', 'signed_out', 'failed']),
  reason: z.enum(['no_window', 'parse', 'timeout', 'challenge', 'tab_closed']).optional(),
  fiveHour: BrowserUsageWindowSchema.nullable(),
  weekly: BrowserUsageWindowSchema.nullable(),
});
export type BrowserUsageRecord = z.infer<typeof StoredRecordSchema>;

const REASON_LABELS: Record<NonNullable<BrowserUsagePost['reason']>, string> = {
  no_window: '没有打开的浏览器窗口',
  parse: '页面格式无法识别',
  timeout: '页面加载超时',
  challenge: '需要完成安全验证',
  tab_closed: '读取页面被关闭',
};

export function formatRelativeTime(observedMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - observedMs);
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) return '刚刚';
  if (totalMinutes < 60) return `${totalMinutes} 分钟前`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours} 小时 ${minutes} 分钟前`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days} 天 ${hours} 小时前`;
}

function clampObservedAt(iso: string, nowMs: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed <= nowMs ? new Date(parsed).toISOString() : new Date(nowMs).toISOString();
}

function mergeWindow(previous: BrowserUsageWindow | null, incoming: BrowserUsageWindow | null, nowMs: number): BrowserUsageWindow | null {
  if (!incoming) return previous;
  const clamped: BrowserUsageWindow = { ...incoming, observedAt: clampObservedAt(incoming.observedAt, nowMs) };
  if (!previous) return clamped;
  return Date.parse(clamped.observedAt) >= Date.parse(previous.observedAt) ? clamped : previous;
}

export class BrowserUsageStore {
  private directory: string;
  private nowFn: () => number;
  private records = new Map<string, BrowserUsageRecord>();
  private lastSavedAt = 0;
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string, nowFn: () => number = Date.now) {
    this.directory = directory;
    this.nowFn = nowFn;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }

  private prune(now: number): void {
    for (const [key, item] of this.records) {
      if (now - item.lastPostAt >= RETENTION_MS) this.records.delete(key);
    }
  }

  private async save(now: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'browser-usage.json');
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ records: [...this.records.values()] }), { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
    this.lastSavedAt = now;
  }

  async load(now = this.nowFn()): Promise<void> {
    return this.serial(async () => {
      if (this.loaded) return;
      try {
        const raw = JSON.parse(await readFile(join(this.directory, 'browser-usage.json'), 'utf8'));
        const parsed = z.strictObject({ records: StoredRecordSchema.array() }).parse(raw);
        for (const item of parsed.records) {
          if (!this.records.has(item.instanceId)) this.records.set(item.instanceId, item);
        }
        this.prune(now);
        this.lastSavedAt = now;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('浏览器额度状态无效');
      }
      this.loaded = true;
    });
  }

  record = async (body: unknown, now = this.nowFn()): Promise<void> => {
    const input = BrowserUsagePostSchema.parse(body);
    return this.serial(async () => {
      this.prune(now);
      const previous = this.records.get(input.instanceId);
      const fiveHour = mergeWindow(previous?.fiveHour ?? null, input.fiveHour, now);
      const weekly = mergeWindow(previous?.weekly ?? null, input.weekly, now);
      const reason = input.status === 'failed' ? input.reason : undefined;
      const next: BrowserUsageRecord = {
        instanceId: input.instanceId,
        instanceName: input.instanceName,
        lastPostAt: now,
        status: input.status,
        ...(reason ? { reason } : {}),
        fiveHour,
        weekly,
      };
      const changed = !previous
        || previous.instanceName !== next.instanceName
        || previous.status !== next.status
        || previous.reason !== next.reason
        || JSON.stringify(previous.fiveHour) !== JSON.stringify(next.fiveHour)
        || JSON.stringify(previous.weekly) !== JSON.stringify(next.weekly);
      this.records.set(input.instanceId, next);
      if (changed || now - this.lastSavedAt >= SAVE_INTERVAL_MS) {
        await this.save(now);
      }
    });
  };

  async get(instanceId: string, now = this.nowFn()): Promise<BrowserUsageRecord | null> {
    await this.tail;
    this.prune(now);
    const found = this.records.get(instanceId);
    return found ? structuredClone(found) : null;
  }

  async discover(now = this.nowFn()): Promise<UsageAccount[]> {
    await this.tail;
    this.prune(now);
    const list = [...this.records.values()];
    const counts = new Map<string, number>();
    for (const item of list) counts.set(item.instanceName, (counts.get(item.instanceName) ?? 0) + 1);
    return list.map(item => {
      const key = hashAccountKey(item.instanceId);
      const duplicate = (counts.get(item.instanceName) ?? 0) > 1;
      return {
        key,
        label: duplicate ? `${item.instanceName} · ${key.slice(0, 4)}` : item.instanceName,
        input: { instanceId: item.instanceId },
      };
    });
  }
}

export function toUsageReport(record: BrowserUsageRecord | null | undefined, now = Date.now(), channelEnabled = true): UsageReport {
  if (!record) {
    return unavailable({ kind: 'no_quota', detail: '该浏览器环境已长时间未连接' });
  }
  const hasData = Boolean(record.fiveHour || record.weekly);
  const online = channelEnabled && now - record.lastPostAt < MAX_AGE;
  const isCurrentOk = online && record.status === 'ok' && hasData;

  let stateText: string | null = null;
  if (!channelEnabled) {
    if (!hasData) return unavailable({ kind: 'no_quota', detail: '未打开浏览器，无法检测剩余额度，还没有同步过额度' });
    stateText = '开发自动化插件的浏览器通道已关闭，无法检测剩余额度，只展示上一次同步的额度';
  } else if (!online) {
    if (!hasData) return unavailable({ kind: 'no_quota', detail: '未打开浏览器，无法检测剩余额度，还没有同步过额度' });
    stateText = '未打开浏览器，无法检测剩余额度，只展示上一次同步的额度';
  } else if (record.status === 'signed_out') {
    if (!hasData) return unavailable({ kind: 'no_quota', detail: '该浏览器环境未登录 claude.ai' });
    stateText = '该浏览器环境未登录 claude.ai，只展示上一次同步的额度';
  } else if (record.status === 'failed') {
    const reasonLabel = record.reason ? REASON_LABELS[record.reason] : '页面格式无法识别';
    if (!hasData) return { status: 'error', error: `额度读取失败（${reasonLabel}）` };
    stateText = `额度读取失败（${reasonLabel}），只展示上一次同步的额度`;
  } else if (record.status === 'pending' || !hasData) {
    if (!hasData) return unavailable({ kind: 'no_quota', detail: '正在等待第一次读取额度' });
    stateText = '正在等待第一次读取额度，只展示上一次同步的额度';
  }

  if (stateText) {
    const resetPassed = [record.fiveHour?.resetsAt, record.weekly?.resetsAt].some(r => r && Date.parse(r) <= now);
    if (resetPassed) {
      stateText += '；部分窗口已过重置时间，实际用量可能更低';
    }
  }

  const windows = [
    windowFromUsedPct({
      id: 'five_hour',
      label: '5 小时窗口',
      shortLabel: '5h',
      summary: true,
      utilizationPct: record.fiveHour?.usedPct ?? null,
      resetsAt: record.fiveHour?.resetsAt ?? null,
      tone: isCurrentOk && record.fiveHour ? toneFromUsedPct(record.fiveHour.usedPct) : 'default',
    }),
    windowFromUsedPct({
      id: 'weekly',
      label: '每周窗口',
      shortLabel: 'wk',
      utilizationPct: record.weekly?.usedPct ?? null,
      resetsAt: record.weekly?.resetsAt ?? null,
      tone: isCurrentOk && record.weekly ? toneFromUsedPct(record.weekly.usedPct) : 'default',
    }),
  ];

  const details: UsageDetail[] = [];
  if (stateText) {
    details.push({ id: 'state', label: '状态', value: stateText, tone: 'warning' });
  }
  const fiveMs = record.fiveHour ? Date.parse(record.fiveHour.observedAt) : -Infinity;
  const weeklyMs = record.weekly ? Date.parse(record.weekly.observedAt) : -Infinity;
  const latestMs = Math.max(fiveMs, weeklyMs);
  if (Number.isFinite(latestMs)) {
    details.push({
      id: 'synced',
      label: isCurrentOk ? '同步时间' : '上一次同步',
      value: formatRelativeTime(latestMs, now),
    });
  }
  if (record.fiveHour && record.weekly && Math.abs(fiveMs - weeklyMs) > WEEKLY_SYNC_DIFF_MS) {
    details.push({
      id: 'weekly-synced',
      label: '每周窗口同步时间',
      value: formatRelativeTime(weeklyMs, now),
    });
  }

  return { status: 'available', windows, details };
}

export function registerBrowserUsage(
  server: Pick<PluginServerContext, 'registerUsageSource'>,
  readyBrowser: () => Promise<BrowserBridge>,
  directory: string,
  nowFn: () => number = Date.now,
): BrowserUsageStore {
  const store = new BrowserUsageStore(directory, nowFn);
  const loaded = store.load().catch(() => {});
  let channelEnabled = true;
  const attach = async () => {
    await loaded;
    try {
      const browser = await readyBrowser();
      browser?.setUsageRoute?.(store.record);
      channelEnabled = browser?.snapshot?.()?.settings?.enabled ?? true;
    } catch {}
  };
  void attach();
  server.registerUsageSource?.({
    id: 'claude-browser',
    label: 'claude.ai 浏览器环境',
    input: BrowserUsageInputSchema,
    async discover(scope) {
      if (scope.kind !== 'global') return [];
      await attach();
      return store.discover();
    },
    async fetch(rawInput) {
      await attach();
      const { instanceId } = BrowserUsageInputSchema.parse(rawInput);
      return toUsageReport(await store.get(instanceId), nowFn(), channelEnabled);
    },
  });
  return store;
}
