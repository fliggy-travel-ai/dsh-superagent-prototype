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
const ADSPOWER_QUERY_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ADSPOWER_URL = 'http://local.adspower.net:50325';
const DEFAULT_ADSPOWER_TIMEOUT_MS = 3000;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserUsageInputSchema = z.strictObject({ instanceId: id });

export const BrowserUsageLabelSourceSchema = z.enum(['adspower_name', 'serial_number', 'user_id', 'instance_name']);
export type BrowserUsageLabelSource = z.infer<typeof BrowserUsageLabelSourceSchema>;

export const LABEL_SOURCE_TEXT: Record<BrowserUsageLabelSource, string> = {
  adspower_name: 'AdsPower 名称',
  serial_number: 'AdsPower 序号',
  user_id: 'AdsPower user_id',
  instance_name: '扩展上报名称',
};

const StoredRecordSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().trim().min(1).max(120),
  adspowerProfile: z.string().trim().min(1).max(120).optional(),
  adspowerUserId: z.string().trim().min(1).max(120).optional(),
  adspowerSerialNumber: z.string().trim().min(1).max(120).optional(),
  adspowerName: z.string().trim().min(1).max(120).optional(),
  adspowerQueriedAt: z.number().finite().optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  labelSource: BrowserUsageLabelSourceSchema.optional(),
  labelSourceText: z.string().trim().min(1).max(120).optional(),
  lastPostAt: z.number().finite(),
  status: z.enum(['pending', 'ok', 'signed_out', 'failed']),
  reason: z.enum(['no_window', 'parse', 'timeout', 'challenge', 'tab_closed']).optional(),
  fiveHour: BrowserUsageWindowSchema.nullable(),
  weekly: BrowserUsageWindowSchema.nullable(),
});
export type BrowserUsageRecord = z.infer<typeof StoredRecordSchema>;

export interface BrowserUsageStoreOptions {
  adspowerApiUrl?: string;
  adspowerApiKey?: string;
  adspowerTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface AdsPowerUserEntry {
  userId?: string;
  serialNumber?: string;
  name?: string;
  fetchedAt: number;
}

function computeDisplay(input: {
  instanceName: string;
  profileHint?: string;
  adspowerName?: string;
  adspowerSerialNumber?: string;
  adspowerUserId?: string;
}): { displayName: string; labelSource: BrowserUsageLabelSource; labelSourceText: string } {
  const name = input.adspowerName?.trim();
  if (name) {
    return { displayName: name.slice(0, 120), labelSource: 'adspower_name', labelSourceText: LABEL_SOURCE_TEXT.adspower_name };
  }
  const serial = input.adspowerSerialNumber?.trim()
    || (input.profileHint && /^\d+$/.test(input.profileHint) ? input.profileHint : undefined);
  if (serial) {
    return { displayName: serial.slice(0, 120), labelSource: 'serial_number', labelSourceText: LABEL_SOURCE_TEXT.serial_number };
  }
  const userId = input.adspowerUserId?.trim() || input.profileHint?.trim();
  if (userId) {
    return { displayName: userId.slice(0, 120), labelSource: 'user_id', labelSourceText: LABEL_SOURCE_TEXT.user_id };
  }
  const fallback = input.instanceName.trim().slice(0, 120) || '未命名浏览器环境';
  return { displayName: fallback, labelSource: 'instance_name', labelSourceText: LABEL_SOURCE_TEXT.instance_name };
}

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
  private options: BrowserUsageStoreOptions;
  private configuredApiUrl?: string;
  private configuredApiKey?: string;
  private records = new Map<string, BrowserUsageRecord>();
  private userCache = new Map<string, AdsPowerUserEntry>();
  private serialToUserId = new Map<string, string>();
  private lastSavedAt = 0;
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string, nowFn: () => number = Date.now, options: BrowserUsageStoreOptions = {}) {
    this.directory = directory;
    this.nowFn = nowFn;
    this.options = options;
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

  private getApiBaseUrl(): string {
    const url = this.options.adspowerApiUrl?.trim()
      || this.configuredApiUrl?.trim()
      || process.env.PASEO_ADSPOWER_API_URL?.trim()
      || process.env.ADSPOWER_API_URL?.trim()
      || DEFAULT_ADSPOWER_URL;
    return url.replace(/\/+$/, '');
  }

  private getApiKey(): string {
    return this.options.adspowerApiKey?.trim()
      || this.configuredApiKey?.trim()
      || process.env.PASEO_ADSPOWER_API_KEY?.trim()
      || process.env.ADSPOWER_API_KEY?.trim()
      || '';
  }

  private async requestAdsPower(pathAndQuery: string): Promise<any | null> {
    const fetchImpl = this.options.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return null;
    const timeoutMs = this.options.adspowerTimeoutMs ?? DEFAULT_ADSPOWER_TIMEOUT_MS;
    const apiKey = this.getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${this.getApiBaseUrl()}${pathAndQuery}`, {
        method: 'GET',
        ...(Object.keys(headers).length ? { headers } : {}),
        signal: controller.signal,
      });
      if (!response?.ok) return null;
      const body = await response.json();
      if (!body || typeof body !== 'object' || body.code !== 0) return null;
      return body.data ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private getCachedUser(lookup: { userId?: string; serialNumber?: string }, now: number): AdsPowerUserEntry | null {
    if (lookup.userId) {
      const entry = this.userCache.get(lookup.userId);
      if (entry && now - entry.fetchedAt < ADSPOWER_QUERY_INTERVAL_MS) return entry;
    }
    if (lookup.serialNumber) {
      const mappedId = this.serialToUserId.get(lookup.serialNumber);
      if (mappedId) {
        const entry = this.userCache.get(mappedId);
        if (entry && now - entry.fetchedAt < ADSPOWER_QUERY_INTERVAL_MS) return entry;
      }
      const bySerial = this.userCache.get(`serial:${lookup.serialNumber}`);
      if (bySerial && now - bySerial.fetchedAt < ADSPOWER_QUERY_INTERVAL_MS) return bySerial;
    }
    return null;
  }

  private storeCachedUser(entry: AdsPowerUserEntry): void {
    if (entry.userId) {
      this.userCache.set(entry.userId, entry);
      if (entry.serialNumber) this.serialToUserId.set(entry.serialNumber, entry.userId);
    } else if (entry.serialNumber) {
      this.userCache.set(`serial:${entry.serialNumber}`, entry);
    }
  }

  private async fetchUserByHint(hint: string, now: number): Promise<{ ok: boolean; entry?: AdsPowerUserEntry }> {
    const isSerial = /^\d+$/.test(hint);
    const cached = this.getCachedUser(isSerial ? { serialNumber: hint } : { userId: hint }, now);
    if (cached) return { ok: true, entry: cached };

    const query = isSerial
      ? `/api/v1/user/list?serial_number=${encodeURIComponent(hint)}`
      : `/api/v1/user/list?user_id=${encodeURIComponent(hint)}`;
    const data = await this.requestAdsPower(query);
    if (!data || !Array.isArray(data.list)) return { ok: false };
    const item = data.list.find((row: any) =>
      isSerial
        ? String(row?.serial_number ?? '').trim() === hint
        : String(row?.user_id ?? '').trim() === hint,
    ) ?? data.list[0];
    if (!item || typeof item !== 'object') {
      const fallbackEntry: AdsPowerUserEntry = {
        ...(isSerial ? { serialNumber: hint } : { userId: hint }),
        fetchedAt: now,
      };
      this.storeCachedUser(fallbackEntry);
      return { ok: true, entry: fallbackEntry };
    }
    const userId = typeof item.user_id === 'string' && item.user_id.trim() ? item.user_id.trim().slice(0, 120) : (!isSerial ? hint : undefined);
    const rawSerial = item.serial_number !== undefined && item.serial_number !== null ? String(item.serial_number).trim() : '';
    const serialNumber = rawSerial ? rawSerial.slice(0, 120) : (isSerial ? hint : undefined);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : undefined;
    const entry: AdsPowerUserEntry = {
      ...(userId ? { userId } : {}),
      ...(serialNumber ? { serialNumber } : {}),
      ...(name ? { name } : {}),
      fetchedAt: now,
    };
    this.storeCachedUser(entry);
    return { ok: true, entry };
  }

  private clearAutoDetectedOnMultiInstance(): void {
    if (this.records.size <= 1) return;
    for (const [key, item] of this.records) {
      if (!item.adspowerProfile && (item.adspowerUserId || item.adspowerSerialNumber || item.adspowerName)) {
        const display = computeDisplay({ instanceName: item.instanceName });
        this.records.set(key, {
          instanceId: item.instanceId,
          instanceName: item.instanceName,
          displayName: display.displayName,
          labelSource: display.labelSource,
          labelSourceText: display.labelSourceText,
          lastPostAt: item.lastPostAt,
          status: item.status,
          ...(item.reason ? { reason: item.reason } : {}),
          fiveHour: item.fiveHour,
          weekly: item.weekly,
        });
      }
    }
  }

  private async save(now: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'browser-usage.json');
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const payload: Record<string, unknown> = { records: [...this.records.values()] };
    if (this.configuredApiUrl) payload.adspowerApiUrl = this.configuredApiUrl;
    if (this.configuredApiKey) payload.adspowerApiKey = this.configuredApiKey;
    await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
    this.lastSavedAt = now;
  }

  async load(now = this.nowFn()): Promise<void> {
    return this.serial(async () => {
      if (this.loaded) return;
      try {
        const raw = JSON.parse(await readFile(join(this.directory, 'browser-usage.json'), 'utf8'));
        const parsed = z.strictObject({
          records: StoredRecordSchema.array(),
          adspowerApiUrl: z.string().trim().min(1).optional(),
          adspowerApiKey: z.string().trim().min(1).optional(),
        }).parse(raw);
        if (parsed.adspowerApiUrl) this.configuredApiUrl = parsed.adspowerApiUrl;
        if (parsed.adspowerApiKey) this.configuredApiKey = parsed.adspowerApiKey;
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
      const trimmedName = input.instanceName.trim();
      const rawProfile = input.adspowerProfile?.trim();
      const profileHint = rawProfile || (/^[1-9][0-9]{0,7}$/.test(trimmedName) ? trimmedName : undefined);

      const reportingIds = new Set<string>([input.instanceId]);
      for (const existingId of this.records.keys()) reportingIds.add(existingId);
      const singleExtension = reportingIds.size === 1;

      let adspowerUserId = previous?.adspowerUserId;
      let adspowerSerialNumber = previous?.adspowerSerialNumber;
      let adspowerName = previous?.adspowerName;
      let adspowerQueriedAt = previous?.adspowerQueriedAt;

      const profileChanged = (previous?.adspowerProfile ?? undefined) !== profileHint;
      const shouldQuery = !previous
        || profileChanged
        || adspowerQueriedAt === undefined
        || now - adspowerQueriedAt >= ADSPOWER_QUERY_INTERVAL_MS;

      if (profileHint) {
        if (profileChanged) {
          adspowerUserId = undefined;
          adspowerSerialNumber = undefined;
          adspowerName = undefined;
        }
        if (shouldQuery) {
          adspowerQueriedAt = now;
          const resolved = await this.fetchUserByHint(profileHint, now);
          if (resolved.ok && resolved.entry) {
            adspowerUserId = resolved.entry.userId;
            adspowerSerialNumber = resolved.entry.serialNumber;
            adspowerName = resolved.entry.name;
          }
        }
      } else if (trimmedName === '未命名浏览器环境' && singleExtension) {
        if (profileChanged) {
          adspowerUserId = undefined;
          adspowerSerialNumber = undefined;
          adspowerName = undefined;
        }
        if (shouldQuery) {
          adspowerQueriedAt = now;
          const activeData = await this.requestAdsPower('/api/v1/browser/local-active');
          if (activeData && Array.isArray(activeData.list)) {
            if (activeData.list.length === 1) {
              const active = activeData.list[0];
              const activeUserId = typeof active?.user_id === 'string' && active.user_id.trim() ? active.user_id.trim().slice(0, 120) : undefined;
              const rawSerial = active?.serial_number !== undefined && active?.serial_number !== null ? String(active.serial_number).trim() : '';
              const activeSerial = rawSerial ? rawSerial.slice(0, 120) : undefined;
              const activeName = typeof active?.name === 'string' && active.name.trim() ? active.name.trim().slice(0, 120) : undefined;
              if (activeName) {
                adspowerUserId = activeUserId;
                adspowerSerialNumber = activeSerial;
                adspowerName = activeName;
                this.storeCachedUser({ userId: activeUserId, serialNumber: activeSerial, name: activeName, fetchedAt: now });
              } else if (activeUserId || activeSerial) {
                const resolved = await this.fetchUserByHint(activeUserId ?? activeSerial!, now);
                if (resolved.ok && resolved.entry) {
                  adspowerUserId = resolved.entry.userId ?? activeUserId;
                  adspowerSerialNumber = resolved.entry.serialNumber ?? activeSerial;
                  adspowerName = resolved.entry.name;
                } else {
                  adspowerUserId = activeUserId;
                  adspowerSerialNumber = activeSerial;
                  adspowerName = undefined;
                }
              } else {
                adspowerUserId = undefined;
                adspowerSerialNumber = undefined;
                adspowerName = undefined;
              }
            } else {
              adspowerUserId = undefined;
              adspowerSerialNumber = undefined;
              adspowerName = undefined;
            }
          }
        }
      } else {
        adspowerUserId = undefined;
        adspowerSerialNumber = undefined;
        adspowerName = undefined;
        adspowerQueriedAt = undefined;
      }

      const display = computeDisplay({
        instanceName: input.instanceName,
        profileHint,
        adspowerName,
        adspowerSerialNumber,
        adspowerUserId,
      });

      const fiveHour = mergeWindow(previous?.fiveHour ?? null, input.fiveHour, now);
      const weekly = mergeWindow(previous?.weekly ?? null, input.weekly, now);
      const reason = input.status === 'failed' ? input.reason : undefined;
      const next: BrowserUsageRecord = {
        instanceId: input.instanceId,
        instanceName: input.instanceName,
        ...(profileHint ? { adspowerProfile: profileHint } : {}),
        ...(adspowerUserId ? { adspowerUserId } : {}),
        ...(adspowerSerialNumber ? { adspowerSerialNumber } : {}),
        ...(adspowerName ? { adspowerName } : {}),
        ...(adspowerQueriedAt !== undefined ? { adspowerQueriedAt } : {}),
        displayName: display.displayName,
        labelSource: display.labelSource,
        labelSourceText: display.labelSourceText,
        lastPostAt: now,
        status: input.status,
        ...(reason ? { reason } : {}),
        fiveHour,
        weekly,
      };
      const changed = !previous
        || previous.instanceName !== next.instanceName
        || previous.adspowerProfile !== next.adspowerProfile
        || previous.adspowerUserId !== next.adspowerUserId
        || previous.adspowerSerialNumber !== next.adspowerSerialNumber
        || previous.adspowerName !== next.adspowerName
        || previous.displayName !== next.displayName
        || previous.labelSource !== next.labelSource
        || previous.status !== next.status
        || previous.reason !== next.reason
        || JSON.stringify(previous.fiveHour) !== JSON.stringify(next.fiveHour)
        || JSON.stringify(previous.weekly) !== JSON.stringify(next.weekly);
      this.records.set(input.instanceId, next);
      this.clearAutoDetectedOnMultiInstance();
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
    const baseLabel = (item: BrowserUsageRecord) => item.displayName || item.instanceName;
    const counts = new Map<string, number>();
    for (const item of list) {
      const label = baseLabel(item);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return list.map(item => {
      const key = hashAccountKey(item.instanceId);
      const label = baseLabel(item);
      const duplicate = (counts.get(label) ?? 0) > 1;
      return {
        key,
        label: duplicate ? `${label} · ${key.slice(0, 4)}` : label,
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
  options: BrowserUsageStoreOptions = {},
): BrowserUsageStore {
  const store = new BrowserUsageStore(directory, nowFn, options);
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
