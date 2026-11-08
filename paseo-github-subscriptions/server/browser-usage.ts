import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { hashAccountKey, toneFromUsedPct, unavailable, windowFromUsedPct, type UsageAccount, type UsageDetail, type UsageReport } from '@getpaseo/plugin/server/usage';
import {
  BrowserUsageApiKeyInputSchema,
  BrowserUsagePostSchema,
  BrowserUsageWindowSchema,
  type BrowserUsageApiKeySource,
  type BrowserUsagePost,
  type BrowserUsageSettings,
  type BrowserUsageWindow,
} from '../shared/browser-usage.ts';
import type { BrowserBridge } from './browser-bridge.ts';

const MAX_AGE = 150_000;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 60 * 1000;
const WEEKLY_SYNC_DIFF_MS = 10 * 60 * 1000;
const ADSPOWER_QUERY_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ADSPOWER_URL = 'http://127.0.0.1:50325';
const DEFAULT_ADSPOWER_TIMEOUT_MS = 3000;
const DEFAULT_ADSPOWER_MIN_INTERVAL_MS = 1100;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserUsageInputSchema = z.strictObject({ instanceId: id });

export const BrowserUsageLabelSourceSchema = z.enum(['adspower_name', 'serial_number', 'user_id', 'instance_name']);
export type BrowserUsageLabelSource = z.infer<typeof BrowserUsageLabelSourceSchema>;

export const BrowserUsageAdsPowerErrorSchema = z.enum([
  '连接失败',
  '需要在额度设置填写 AdsPower API key',
  'API key 无效，请在额度设置重新填写',
  '需要 api key',
  '被限流',
  '未找到环境',
]);
export type BrowserUsageAdsPowerError = z.infer<typeof BrowserUsageAdsPowerErrorSchema>;

export const LABEL_SOURCE_TEXT: Record<BrowserUsageLabelSource, string> = {
  adspower_name: 'AdsPower 名称',
  serial_number: 'AdsPower 序号',
  user_id: 'AdsPower user_id',
  instance_name: '扩展上报名称',
};

const StoredRecordSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().trim().min(1).max(120),
  account: z.string().max(320).nullable().optional(),
  adspowerProfile: z.string().trim().min(1).max(120).optional(),
  adspowerUserId: z.string().trim().min(1).max(120).optional(),
  adspowerSerialNumber: z.string().trim().min(1).max(120).optional(),
  adspowerName: z.string().trim().min(1).max(120).optional(),
  adspowerQueriedAt: z.number().finite().optional(),
  adspowerError: BrowserUsageAdsPowerErrorSchema.optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  labelSource: BrowserUsageLabelSourceSchema.optional(),
  labelSourceText: z.string().trim().min(1).max(120).optional(),
  lastPostAt: z.number().finite(),
  status: z.enum(['pending', 'ok', 'signed_out', 'failed']),
  reason: z.enum(['no_window', 'parse', 'timeout', 'challenge', 'tab_closed']).optional(),
  fiveHour: BrowserUsageWindowSchema.nullable(),
  weekly: BrowserUsageWindowSchema.nullable(),
}).transform(({ account: _account, ...rest }) => rest);
export type BrowserUsageRecord = z.infer<typeof StoredRecordSchema>;

export interface BrowserUsageStoreOptions {
  adspowerApiUrl?: string;
  adspowerApiKey?: string;
  adspowerTimeoutMs?: number;
  adspowerMinIntervalMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

interface AdsPowerUserEntry {
  userId?: string;
  serialNumber?: string;
  name?: string;
  fetchedAt: number;
}

type AdsPowerResponse =
  | { ok: true; data: any }
  | { ok: false; error: BrowserUsageAdsPowerError };

type AsyncQueryResult =
  | { ok: true; clearAutoDetect?: boolean; userId?: string; serialNumber?: string; name?: string }
  | { ok: false; error: BrowserUsageAdsPowerError; fallbackUserId?: string; fallbackSerial?: string };

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

function classifyAdsPowerFailure(status: number, msg: string, hasApiKey: boolean): BrowserUsageAdsPowerError {
  if (status === 401 || status === 403 || /api[_\s-]*key|unauthorized|auth|token|permission|forbidden|密钥|鉴权|认证/i.test(msg)) {
    return hasApiKey ? 'API key 无效，请在额度设置重新填写' : '需要在额度设置填写 AdsPower API key';
  }
  if (status === 429 || /too many request|rate\s*limit|频繁|限流|qps/i.test(msg)) {
    return '被限流';
  }
  if (/not\s*found|not\s*exist|不存在|未找到/i.test(msg)) {
    return '未找到环境';
  }
  return '连接失败';
}

export class BrowserUsageStore {
  private directory: string;
  private nowFn: () => number;
  private options: BrowserUsageStoreOptions;
  private configuredApiUrl?: string;
  private configuredApiKey?: string;
  private apiKeyVersion = 0;
  private stopped = false;
  private activeAbortControllers = new Set<AbortController>();
  private records = new Map<string, BrowserUsageRecord>();
  private userCache = new Map<string, AdsPowerUserEntry>();
  private serialToUserId = new Map<string, string>();
  private inflightQueries = new Map<string, { version: number; promise: Promise<void> }>();
  private allInflightPromises = new Set<Promise<void>>();
  private requestQueue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
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

  private enqueueAdsPowerRequest<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.requestQueue.then(async () => {
      if (this.stopped) return fn();
      const minIntervalMs = this.options.adspowerMinIntervalMs ?? DEFAULT_ADSPOWER_MIN_INTERVAL_MS;
      if (this.lastRequestAt > 0 && minIntervalMs > 0) {
        const elapsed = Date.now() - this.lastRequestAt;
        const waitMs = minIntervalMs - elapsed;
        if (waitMs > 0) {
          const sleep = this.options.sleepFn ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
          await sleep(waitMs);
        }
      }
      this.lastRequestAt = Date.now();
      try {
        return await fn();
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
    this.requestQueue = next.catch(() => {});
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

  private getApiKeyInfo(): { key: string; source: BrowserUsageApiKeySource } {
    const pluginKey = this.options.adspowerApiKey?.trim() || this.configuredApiKey?.trim() || '';
    if (pluginKey) {
      return { key: pluginKey, source: 'plugin' };
    }
    const envKey = process.env.PASEO_ADSPOWER_API_KEY?.trim() || process.env.ADSPOWER_API_KEY?.trim() || '';
    if (envKey) {
      return { key: envKey, source: 'env' };
    }
    return { key: '', source: 'none' };
  }

  private getApiKey(): string {
    return this.getApiKeyInfo().key;
  }

  private requestAdsPower(pathAndQuery: string): Promise<AdsPowerResponse> {
    return this.enqueueAdsPowerRequest(async () => {
      if (this.stopped) return { ok: false, error: '连接失败' };
      const fetchImpl = this.options.fetchFn ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') return { ok: false, error: '连接失败' };
      const timeoutMs = this.options.adspowerTimeoutMs ?? DEFAULT_ADSPOWER_TIMEOUT_MS;
      const apiKey = this.getApiKey();
      const hasApiKey = Boolean(apiKey);
      const headers: Record<string, string> = {};
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const controller = new AbortController();
      this.activeAbortControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${this.getApiBaseUrl()}${pathAndQuery}`, {
          method: 'GET',
          ...(Object.keys(headers).length ? { headers } : {}),
          signal: controller.signal,
        });
        if (!response) return { ok: false, error: '连接失败' };
        let body: any = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (body && typeof body === 'object') {
          if (response.ok && body.code === 0) {
            return { ok: true, data: body.data ?? null };
          }
          const msg = String(body.msg ?? body.message ?? '').trim();
          return { ok: false, error: classifyAdsPowerFailure(response.status ?? 0, msg, hasApiKey) };
        }
        return { ok: false, error: classifyAdsPowerFailure(response.status ?? 0, '', hasApiKey) };
      } catch {
        return { ok: false, error: '连接失败' };
      } finally {
        clearTimeout(timer);
        this.activeAbortControllers.delete(controller);
      }
    });
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

  private cacheRows(rows: unknown[], now: number): void {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const rowUserId = typeof record.user_id === 'string' && record.user_id.trim() ? record.user_id.trim().slice(0, 120) : undefined;
      const rawSerial = record.serial_number !== undefined && record.serial_number !== null ? String(record.serial_number).trim() : '';
      const rowSerial = rawSerial ? rawSerial.slice(0, 120) : undefined;
      const rowName = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 120) : undefined;
      if (rowUserId || rowSerial) {
        this.storeCachedUser({
          ...(rowUserId ? { userId: rowUserId } : {}),
          ...(rowSerial ? { serialNumber: rowSerial } : {}),
          ...(rowName ? { name: rowName } : {}),
          fetchedAt: now,
        });
      }
    }
  }

  private async fetchUserByHint(
    hint: string,
    now: number,
    queryVersion: number,
  ): Promise<{ ok: true; entry: AdsPowerUserEntry } | { ok: false; error: BrowserUsageAdsPowerError }> {
    const isSerial = /^\d+$/.test(hint);
    const cached = this.getCachedUser(isSerial ? { serialNumber: hint } : { userId: hint }, now);
    if (cached) return { ok: true, entry: cached };

    const matchRow = (row: any) =>
      isSerial
        ? String(row?.serial_number ?? '').trim() === hint
        : String(row?.user_id ?? '').trim() === hint;

    const batchRes = await this.requestAdsPower('/api/v1/user/list?page_size=100');
    if (!batchRes.ok) return batchRes;
    const batchData = batchRes.data;
    if (!batchData || !Array.isArray(batchData.list)) return { ok: false, error: '连接失败' };

    if (!this.stopped && queryVersion === this.apiKeyVersion) {
      this.cacheRows(batchData.list, now);
    }

    let item = batchData.list.find(matchRow);
    if (!item || typeof item !== 'object') {
      if (this.stopped || queryVersion !== this.apiKeyVersion) {
        return { ok: false, error: '未找到环境' };
      }
      const filterQuery = isSerial
        ? `/api/v1/user/list?serial_number=${encodeURIComponent(hint)}`
        : `/api/v1/user/list?user_id=${encodeURIComponent(hint)}`;
      const filteredRes = await this.requestAdsPower(filterQuery);
      if (!filteredRes.ok) return filteredRes;
      const filteredData = filteredRes.data;
      if (!filteredData || !Array.isArray(filteredData.list)) return { ok: false, error: '连接失败' };
      if (!this.stopped && queryVersion === this.apiKeyVersion) {
        this.cacheRows(filteredData.list, now);
      }
      item = filteredData.list.find(matchRow);
    }

    if (!item || typeof item !== 'object') {
      return { ok: false, error: '未找到环境' };
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
    if (!this.stopped && queryVersion === this.apiKeyVersion) {
      this.storeCachedUser(entry);
    }
    return { ok: true, entry };
  }

  private clearAutoDetectedOnMultiInstance(): boolean {
    if (this.records.size <= 1) return false;
    let cleared = false;
    for (const [key, item] of this.records) {
      if (!item.adspowerProfile && (item.adspowerUserId || item.adspowerSerialNumber || item.adspowerName || item.adspowerError)) {
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
        cleared = true;
      }
    }
    return cleared;
  }

  private triggerAsyncNameQuery(instanceId: string, profileHint: string | undefined, queryNow: number): void {
    if (this.stopped) return;
    const existing = this.inflightQueries.get(instanceId);
    if (existing && existing.version === this.apiKeyVersion) return;
    const queryVersion = this.apiKeyVersion;
    const promise = this.runAsyncNameQuery(instanceId, profileHint, queryNow, queryVersion)
      .catch(() => {})
      .finally(() => {
        this.allInflightPromises.delete(promise);
        const current = this.inflightQueries.get(instanceId);
        if (current?.promise === promise) {
          this.inflightQueries.delete(instanceId);
        }
      });
    this.inflightQueries.set(instanceId, { version: queryVersion, promise });
    this.allInflightPromises.add(promise);
  }

  private async runAsyncNameQuery(
    instanceId: string,
    profileHint: string | undefined,
    queryNow: number,
    queryVersion: number,
  ): Promise<void> {
    if (this.stopped || queryVersion !== this.apiKeyVersion) return;
    let result: AsyncQueryResult;
    if (profileHint) {
      const resolved = await this.fetchUserByHint(profileHint, queryNow, queryVersion);
      if (resolved.ok) {
        result = {
          ok: true,
          userId: resolved.entry.userId,
          serialNumber: resolved.entry.serialNumber,
          name: resolved.entry.name,
        };
      } else {
        result = { ok: false, error: resolved.error };
      }
    } else {
      const activeRes = await this.requestAdsPower('/api/v1/browser/local-active');
      if (!activeRes.ok) {
        result = { ok: false, error: activeRes.error };
      } else if (!activeRes.data || !Array.isArray(activeRes.data.list)) {
        result = { ok: false, error: '连接失败' };
      } else if (activeRes.data.list.length === 0) {
        result = { ok: false, error: '未找到环境' };
      } else if (activeRes.data.list.length > 1) {
        result = { ok: true, clearAutoDetect: true };
      } else {
        const active = activeRes.data.list[0];
        const activeUserId = typeof active?.user_id === 'string' && active.user_id.trim() ? active.user_id.trim().slice(0, 120) : undefined;
        const rawSerial = active?.serial_number !== undefined && active?.serial_number !== null ? String(active.serial_number).trim() : '';
        const activeSerial = rawSerial ? rawSerial.slice(0, 120) : undefined;
        const activeName = typeof active?.name === 'string' && active.name.trim() ? active.name.trim().slice(0, 120) : undefined;
        if (activeName) {
          if (!this.stopped && queryVersion === this.apiKeyVersion) {
            this.storeCachedUser({ userId: activeUserId, serialNumber: activeSerial, name: activeName, fetchedAt: queryNow });
          }
          result = { ok: true, userId: activeUserId, serialNumber: activeSerial, name: activeName };
        } else if (activeUserId || activeSerial) {
          const resolved = await this.fetchUserByHint(activeUserId ?? activeSerial!, queryNow, queryVersion);
          if (resolved.ok) {
            result = {
              ok: true,
              userId: resolved.entry.userId ?? activeUserId,
              serialNumber: resolved.entry.serialNumber ?? activeSerial,
              name: resolved.entry.name,
            };
          } else {
            result = {
              ok: false,
              error: resolved.error,
              fallbackUserId: activeUserId,
              fallbackSerial: activeSerial,
            };
          }
        } else {
          result = { ok: false, error: '未找到环境' };
        }
      }
    }

    if (this.stopped || queryVersion !== this.apiKeyVersion) return;

    await this.serial(async () => {
      if (this.stopped || queryVersion !== this.apiKeyVersion) return;
      const current = this.records.get(instanceId);
      if (!current) return;
      if ((current.adspowerProfile ?? undefined) !== profileHint) return;
      if (!profileHint && (this.records.size > 1 || current.instanceName.trim() !== '未命名浏览器环境')) {
        return;
      }

      let adspowerUserId = current.adspowerUserId;
      let adspowerSerialNumber = current.adspowerSerialNumber;
      let adspowerName = current.adspowerName;
      let adspowerError: BrowserUsageAdsPowerError | undefined;

      if (result.ok) {
        if (result.clearAutoDetect) {
          adspowerUserId = undefined;
          adspowerSerialNumber = undefined;
          adspowerName = undefined;
        } else {
          adspowerUserId = result.userId;
          adspowerSerialNumber = result.serialNumber;
          adspowerName = result.name;
        }
        adspowerError = undefined;
      } else {
        if (!adspowerUserId && result.fallbackUserId) adspowerUserId = result.fallbackUserId;
        if (!adspowerSerialNumber && result.fallbackSerial) adspowerSerialNumber = result.fallbackSerial;
        adspowerError = result.error;
      }

      const display = computeDisplay({
        instanceName: current.instanceName,
        profileHint: current.adspowerProfile,
        adspowerName,
        adspowerSerialNumber,
        adspowerUserId,
      });

      const updated: BrowserUsageRecord = {
        instanceId: current.instanceId,
        instanceName: current.instanceName,
        ...(current.adspowerProfile ? { adspowerProfile: current.adspowerProfile } : {}),
        ...(adspowerUserId ? { adspowerUserId } : {}),
        ...(adspowerSerialNumber ? { adspowerSerialNumber } : {}),
        ...(adspowerName ? { adspowerName } : {}),
        adspowerQueriedAt: Math.max(current.adspowerQueriedAt ?? 0, queryNow),
        ...(adspowerError ? { adspowerError } : {}),
        displayName: display.displayName,
        labelSource: display.labelSource,
        labelSourceText: display.labelSourceText,
        lastPostAt: current.lastPostAt,
        status: current.status,
        ...(current.reason ? { reason: current.reason } : {}),
        fiveHour: current.fiveHour,
        weekly: current.weekly,
      };

      this.records.set(instanceId, updated);
      this.clearAutoDetectedOnMultiInstance();
      await this.save(this.nowFn());
    });
  }

  private async save(now: number): Promise<void> {
    if (this.stopped) return;
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
      if (this.loaded || this.stopped) return;
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

  private currentSettings(): BrowserUsageSettings {
    const info = this.getApiKeyInfo();
    return {
      adspowerApiKeyConfigured: Boolean(info.key),
      adspowerApiKeySource: info.source,
    };
  }

  private refreshQueriesOnKeyChange(now: number): void {
    this.apiKeyVersion += 1;
    this.userCache.clear();
    this.serialToUserId.clear();
    this.inflightQueries.clear();
    const singleExtension = this.records.size === 1;
    for (const [instanceId, item] of this.records) {
      const trimmedName = item.instanceName.trim();
      const needsAdsPower = Boolean(item.adspowerProfile) || (trimmedName === '未命名浏览器环境' && singleExtension);
      if (needsAdsPower) {
        const nextItem: BrowserUsageRecord = { ...item };
        delete nextItem.adspowerQueriedAt;
        delete nextItem.adspowerError;
        this.records.set(instanceId, nextItem);
        this.triggerAsyncNameQuery(instanceId, item.adspowerProfile, now);
      }
    }
  }

  async settings(now = this.nowFn()): Promise<BrowserUsageSettings> {
    await this.load(now);
    await this.tail;
    return this.currentSettings();
  }

  async saveApiKey(rawKey: string, now = this.nowFn()): Promise<BrowserUsageSettings> {
    const { apiKey } = BrowserUsageApiKeyInputSchema.parse({ apiKey: rawKey });
    await this.load(now);
    return this.serial(async () => {
      if (this.stopped) return this.currentSettings();
      this.configuredApiKey = apiKey;
      this.refreshQueriesOnKeyChange(now);
      await this.save(now);
      return this.currentSettings();
    });
  }

  async removeApiKey(now = this.nowFn()): Promise<BrowserUsageSettings> {
    await this.load(now);
    return this.serial(async () => {
      if (this.stopped) return this.currentSettings();
      this.configuredApiKey = undefined;
      this.refreshQueriesOnKeyChange(now);
      await this.save(now);
      return this.currentSettings();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.apiKeyVersion += 1;
    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
    this.inflightQueries.clear();
    await this.flushQueries();
  }

  record = async (body: unknown, now = this.nowFn()): Promise<void> => {
    const input = BrowserUsagePostSchema.parse(body);
    return this.serial(async () => {
      if (this.stopped) return;
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
      let adspowerError = previous?.adspowerError;

      const profileChanged = (previous?.adspowerProfile ?? undefined) !== profileHint;
      if (profileChanged) {
        adspowerUserId = undefined;
        adspowerSerialNumber = undefined;
        adspowerName = undefined;
        adspowerQueriedAt = undefined;
        adspowerError = undefined;
      }

      let hitCache = false;
      if (profileHint) {
        const isSerial = /^\d+$/.test(profileHint);
        const cached = this.getCachedUser(isSerial ? { serialNumber: profileHint } : { userId: profileHint }, now);
        if (cached) {
          adspowerUserId = cached.userId;
          adspowerSerialNumber = cached.serialNumber;
          adspowerName = cached.name;
          adspowerQueriedAt = cached.fetchedAt;
          adspowerError = undefined;
          hitCache = true;
        }
      } else if (!(trimmedName === '未命名浏览器环境' && singleExtension)) {
        adspowerUserId = undefined;
        adspowerSerialNumber = undefined;
        adspowerName = undefined;
        adspowerQueriedAt = undefined;
        adspowerError = undefined;
      }

      const needsAdsPower = Boolean(profileHint) || (trimmedName === '未命名浏览器环境' && singleExtension);
      const shouldQuery = needsAdsPower && !hitCache && (
        !previous
        || profileChanged
        || adspowerQueriedAt === undefined
        || now - adspowerQueriedAt >= ADSPOWER_QUERY_INTERVAL_MS
      );

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
        ...(adspowerError ? { adspowerError } : {}),
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
        || previous.adspowerError !== next.adspowerError
        || previous.displayName !== next.displayName
        || previous.labelSource !== next.labelSource
        || previous.status !== next.status
        || previous.reason !== next.reason
        || JSON.stringify(previous.fiveHour) !== JSON.stringify(next.fiveHour)
        || JSON.stringify(previous.weekly) !== JSON.stringify(next.weekly);
      this.records.set(input.instanceId, next);
      const clearedOther = this.clearAutoDetectedOnMultiInstance();
      if (changed || clearedOther || now - this.lastSavedAt >= SAVE_INTERVAL_MS) {
        await this.save(now);
      }
      if (shouldQuery) {
        this.triggerAsyncNameQuery(input.instanceId, profileHint, now);
      }
    });
  };

  async flushQueries(): Promise<void> {
    while (this.allInflightPromises.size > 0) {
      await Promise.allSettled([...this.allInflightPromises]);
    }
    await this.tail;
  }

  async get(instanceId: string, now = this.nowFn()): Promise<BrowserUsageRecord | null> {
    if (this.allInflightPromises.size > 0) {
      await Promise.race([
        this.flushQueries(),
        new Promise<void>(resolve => setTimeout(resolve, 100)),
      ]);
    }
    await this.tail;
    this.prune(now);
    const found = this.records.get(instanceId);
    return found ? structuredClone(found) : null;
  }

  async discover(now = this.nowFn()): Promise<UsageAccount[]> {
    if (this.allInflightPromises.size > 0) {
      await Promise.race([
        this.flushQueries(),
        new Promise<void>(resolve => setTimeout(resolve, 100)),
      ]);
    }
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
  if (record.adspowerError) {
    details.push({
      id: 'adspower-error',
      label: '环境名称',
      value: `AdsPower 查询失败（${record.adspowerError}）`,
      tone: 'warning',
    });
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
