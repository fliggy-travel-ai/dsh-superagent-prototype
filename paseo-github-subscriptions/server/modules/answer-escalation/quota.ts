import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 「Mac mini 额度报警 webhook」回调：负载均衡 bot 的专用入口，与 Grok askuser webhook 分开。
// 凭据按任务约定解析：环境变量优先，其次负载均衡以 0600 写入的 ~/.config/dsh/quota-webhook.json。
export interface QuotaWebhookCredentials {
  url: string;
  auth: string;
}

type Env = Record<string, string | undefined>;

export function quotaWebhookConfigPath(env: Env = process.env): string {
  return join(
    (env.XDG_CONFIG_HOME || join(homedir(), ".config")) + "",
    "dsh",
    "quota-webhook.json",
  );
}

/** 安全文件通道：0600、单行的 url/key 文件。目录来自环境变量或机器配置，代码里不写死本机路径。 */
export function quotaWebhookFileDir(env: Env = process.env, configured?: string): string | undefined {
  return env.QUOTA_WEBHOOK_FILE_DIR || configured || undefined;
}

function authHeader(key: string): string {
  // 密钥是裸 token；沿用现有 webhook 的 “头名: 值” 约定时直接透传。
  return key.includes(":") ? key : `Authorization: Bearer ${key}`;
}

async function readCredentialFiles(
  dir: string | undefined,
): Promise<QuotaWebhookCredentials | null> {
  if (!dir) return null;
  try {
    const url = (await readFile(join(dir, "url"), "utf8")).trim();
    if (!/^https:\/\//.test(url)) return null;
    const key = (await readFile(join(dir, "key"), "utf8")).trim();
    if (!key) return null;
    return { url, auth: authHeader(key) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function quotaWebhookCredentials(
  env: Env = process.env,
  path = quotaWebhookConfigPath(),
  fileDir: string | undefined = quotaWebhookFileDir(env),
): Promise<QuotaWebhookCredentials | null> {
  const url = env.QUOTA_WEBHOOK_URL?.trim();
  const key = env.QUOTA_WEBHOOK_KEY?.trim();
  if (url) {
    if (!key) throw Error("已设置 QUOTA_WEBHOOK_URL 但缺少 QUOTA_WEBHOOK_KEY");
    return { url, auth: authHeader(key) };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      url?: unknown;
      key?: unknown;
      auth?: unknown;
    };
    if (typeof raw.url === "string" && raw.url) {
      if (typeof raw.auth === "string" && raw.auth) return { url: raw.url, auth: raw.auth };
      if (typeof raw.key === "string" && raw.key) return { url: raw.url, auth: authHeader(raw.key) };
      return null;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return readCredentialFiles(fileDir);
}

// 主会话限额报错的文本特征。只匹配额度/限额语义，避免把瞬时网络错误当成额度耗尽。
export function isQuotaError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /usage\s*limit|plan\s*limit|rate\s*limit.*(exceeded|reached)|(?:exceeded|reached).*(?:rate|quota)|quota|insufficient\s*balance|out\s*of\s*credits|额度不足|余额不足|配额|限额|达到.{0,12}上限|429/i.test(
    message,
  );
}

interface UsageWindowLike {
  id: string;
  label?: string;
  remainingPct?: number | null;
  resetsAt?: string | null;
}
interface UsageBalanceLike {
  id: string;
  label?: string;
  remaining?: number | null;
  unit?: string;
  resetsAt?: string | null;
}
export interface UsageReportLike {
  id: string;
  sourceId?: string;
  sourceLabel?: string;
  account?: { label?: string } | null;
  report?: {
    status: string;
    windows?: UsageWindowLike[];
    balances?: UsageBalanceLike[];
  } | null;
}

export interface QuotaFinding {
  accountId: string;
  accountLabel: string | null;
  sourceId: string | null;
  tier: string;
  kind: "window" | "balance";
  label: string;
  remainingPct: number | null;
  resetsAt: string | null;
}

// 只把 remainingPct===0 且重置时间尚未过去的窗口当成 0% 档，避免缓存陈旧时误报。
export function zeroedFindings(
  entry: UsageReportLike,
  now = Date.now(),
): QuotaFinding[] {
  const report = entry.report;
  if (!report || report.status !== "available") return [];
  const findings: QuotaFinding[] = [];
  const base = {
    accountId: entry.id,
    accountLabel: entry.account?.label || null,
    sourceId: entry.sourceId || null,
  };
  for (const window of report.windows || []) {
    if (window.remainingPct !== 0) continue;
    if (window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
    findings.push({
      ...base,
      tier: `window:${window.id}`,
      kind: "window",
      label: window.label || window.id,
      remainingPct: 0,
      resetsAt: window.resetsAt || null,
    });
  }
  for (const balance of report.balances || []) {
    if (balance.remaining == null || balance.remaining > 0) continue;
    if (balance.resetsAt && Date.parse(balance.resetsAt) <= now) continue;
    findings.push({
      ...base,
      tier: `balance:${balance.id}`,
      kind: "balance",
      label: balance.label || balance.id,
      remainingPct: null,
      resetsAt: balance.resetsAt || null,
    });
  }
  return findings;
}

export interface AffectedMain {
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  provider: string | null;
}

export interface QuotaAlertPayload {
  schemaVersion: 1;
  source: "paseo-event-notifications";
  kind: "quota_alert";
  event: "quota_zero" | "quota_error";
  id: string;
  correlationKey: string;
  machine: string;
  hostId: string;
  account: { id: string; label: string | null };
  provider: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  window: { id: string; label: string; kind: "window" | "balance" } | null;
  affectedMainAgentIds: string[];
  affectedMainAgents: AffectedMain[];
  detectedAt: string;
  error?: { message: string };
}

interface AlertRecord {
  id: string;
  sentAt: number;
  event: string;
  accountLabel: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  expiresAt: number | null;
}

interface QuotaAlertState {
  active: Record<string, AlertRecord>;
  waiting: Record<string, number>;
  lastCheckAt: number | null;
}

export interface QuotaAlertsDeps {
  listReports: () => Promise<{ reports: UsageReportLike[] }>;
  listAgentReports: (agentId: string) => Promise<{ reports: UsageReportLike[] }>;
  credentials: () => Promise<QuotaWebhookCredentials | null>;
  post: (
    payload: QuotaAlertPayload,
    credentials: QuotaWebhookCredentials,
  ) => Promise<void>;
  audit: (entry: Record<string, unknown>) => Promise<void>;
  mains: () => AffectedMain[];
  machine: string;
  hostId: string;
  statePath: string;
  pollMs?: number;
  enabled?: () => boolean;
  /** 为 true 时只写审计，不发送。可以是函数，以便运行中切换影子和实际发送。 */
  dryRun?: boolean | (() => boolean);
  now?: () => number;
}

const POLL_MS_DEFAULT = 300_000;
const FIRST_DELAY_MS = 20_000;
// 会话报错但报告仍未到 0% 时按“报错档”去重，窗口重置或超时后重新武装。
const SESSION_ERROR_TTL_MS = 6 * 3600_000;

export class QuotaAlerts {
  private deps: QuotaAlertsDeps;
  private state: QuotaAlertState = { active: {}, waiting: {}, lastCheckAt: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(deps: QuotaAlertsDeps) {
    this.deps = deps;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async start() {
    await this.load();
    this.schedule(FIRST_DELAY_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.serial(() => this.scan())
        .catch(() => console.error("额度巡检失败，下个周期重试"))
        .finally(() => this.schedule(this.deps.pollMs || POLL_MS_DEFAULT));
    }, delay);
  }

  private async load() {
    try {
      const raw = JSON.parse(await readFile(this.deps.statePath, "utf8")) as QuotaAlertState;
      if (raw && typeof raw.active === "object")
        this.state = { active: raw.active, waiting: raw.waiting || {}, lastCheckAt: raw.lastCheckAt ?? null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  private async persist() {
    await mkdir(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
    await writeFile(`${this.deps.statePath}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    await rename(`${this.deps.statePath}.tmp`, this.deps.statePath);
  }

  // 主会话 turn 因限额失败：立即按账号检查并回调，不等下个巡检周期。
  onSessionQuotaError(agentId: string, message: string) {
    return this.serial(() => this.scan([agentId], message));
  }

  private async affectedByAccount(): Promise<Map<string, AffectedMain[]>> {
    const mapping = new Map<string, AffectedMain[]>();
    const mains = this.deps.mains();
    for (const main of mains) {
      let reports: UsageReportLike[] = [];
      try {
        reports = (await this.deps.listAgentReports(main.agentId)).reports;
      } catch {
        // 单个会话的账号查询失败不阻断其他映射；本次巡检按未知处理。
        continue;
      }
      for (const report of reports)
        mapping.set(report.id, [...(mapping.get(report.id) || []), main]);
    }
    return mapping;
  }

  private async scan(triggeredBy?: string[], errorMessage?: string) {
    if (this.deps.enabled && !this.deps.enabled()) return;
    const now = this.now();
    this.state.lastCheckAt = now;
    const credentials = await this.deps.credentials().catch((e) => {
      void this.deps.audit({ phase: "quota-credentials-error", error: String(e), at: now });
      return null;
    });
    const global = await this.deps.listReports().catch((e) => {
      void this.deps.audit({ phase: "quota-scan-error", error: String(e), at: now });
      return { reports: [] as UsageReportLike[] };
    });
    let findings: QuotaFinding[] = global.reports.flatMap((r) => zeroedFindings(r, now));
    const triggeredFindings: QuotaFinding[] = [];
    if (triggeredBy?.length) {
      for (const agentId of triggeredBy) {
        try {
          for (const report of (await this.deps.listAgentReports(agentId)).reports) {
            const zeroed = zeroedFindings(report, now);
            if (zeroed.length) triggeredFindings.push(...zeroed);
            else if (report.report?.status === "available") {
              // 报错但没有 0% 窗口：仍按账号报错档回调，让负载均衡自行判断。
              const windows = (report.report.windows || []).filter((w) => w.remainingPct != null);
              const worst = windows.reduce<typeof windows[number] | null>(
                (min, w) => (!min || (w.remainingPct ?? 0) < (min.remainingPct ?? 0)) ? w : min,
                null,
              );
              if (worst)
                triggeredFindings.push({
                  accountId: report.id,
                  accountLabel: report.account?.label || null,
                  sourceId: report.sourceId || null,
                  tier: "session-error",
                  kind: "window",
                  label: errorMessage ? "会话限额报错" : "session error",
                  remainingPct: worst.remainingPct ?? null,
                  resetsAt: worst.resetsAt || null,
                });
            }
          }
        } catch {
          // 查询失败时仅靠全局扫描结果。
        }
      }
    }
    findings = [...findings, ...triggeredFindings.filter((f) => !findings.some((x) => x.accountId === f.accountId && x.tier === f.tier))];
    const byKey = new Map(findings.map((f) => [`${f.accountId}|${f.tier}`, f]));
    const mapping = await this.affectedByAccount();
    // 恢复（或报错档过期）：删除去重记录，之后同一账号同一档可再次告警。
    for (const key of Object.keys(this.state.active)) {
      const record = this.state.active[key];
      if (record.expiresAt && record.expiresAt <= now) delete this.state.active[key];
      else if (!byKey.has(key)) {
        delete this.state.active[key];
        await this.deps.audit({ phase: "quota-recovered", key, record, at: now });
      }
    }
    for (const key of Object.keys(this.state.waiting))
      if (!byKey.has(key)) delete this.state.waiting[key];
    let dirty = true;
    for (const [key, finding] of byKey) {
      if (this.state.active[key]) continue;
      const affected = mapping.get(finding.accountId) || [];
      const isSessionError = finding.tier === "session-error";
      const payload: QuotaAlertPayload = {
        schemaVersion: 1,
        source: "paseo-event-notifications",
        kind: "quota_alert",
        event: isSessionError ? "quota_error" : "quota_zero",
        id: randomUUID(),
        correlationKey: key,
        machine: this.deps.machine,
        hostId: this.deps.hostId,
        account: { id: finding.accountId, label: finding.accountLabel },
        provider: finding.sourceId,
        remainingPct: finding.remainingPct,
        resetsAt: finding.resetsAt,
        window: { id: finding.tier, label: finding.label, kind: finding.kind },
        affectedMainAgentIds: affected.map((a) => a.agentId),
        affectedMainAgents: affected,
        detectedAt: new Date(now).toISOString(),
        ...(isSessionError && errorMessage ? { error: { message: errorMessage.slice(0, 600) } } : {}),
      };
      if (!credentials) {
        // 凭据未就位：不占用去重档，每小时补记一条审计，待负载均衡写入后下个周期推送。
        const lastWait = this.state.waiting[key];
        if (!lastWait || now - lastWait > 3600_000) {
          this.state.waiting[key] = now;
          await this.deps.audit({ phase: "quota-alert-waiting-credentials", payload, at: now });
        }
        continue;
      }
      if (this.deps.enabled && !this.deps.enabled()) break;
      delete this.state.waiting[key];
      const dryRun = typeof this.deps.dryRun === "function" ? this.deps.dryRun() : !!this.deps.dryRun;
      await this.deps.audit({ phase: "quota-alert", mode: dryRun ? "dry-run" : "live", payload, at: now });
      if (dryRun) {
        this.state.active[key] = this.record(now, payload);
        continue;
      }
      try {
        if (this.deps.enabled && !this.deps.enabled()) break;
        await this.deps.post(payload, credentials);
        this.state.active[key] = this.record(now, payload);
      } catch (e) {
        await this.deps.audit({ phase: "quota-alert-failed", key, error: String(e), at: now });
      }
    }
    if (dirty) await this.persist();
  }

  private record(now: number, payload: QuotaAlertPayload): AlertRecord {
    return {
      id: payload.id,
      sentAt: now,
      event: payload.event,
      accountLabel: payload.account.label,
      remainingPct: payload.remainingPct,
      resetsAt: payload.resetsAt,
      expiresAt:
        payload.event === "quota_error" || payload.window?.id === "session-error"
          ? now + SESSION_ERROR_TTL_MS
          : payload.resetsAt
            ? Date.parse(payload.resetsAt) + SESSION_ERROR_TTL_MS
            : null,
    };
  }
}

export async function postQuotaAlert(
  payload: QuotaAlertPayload,
  credentials: QuotaWebhookCredentials,
  signal?: AbortSignal,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": payload.id,
  };
  if (credentials.auth) {
    const split = credentials.auth.indexOf(":");
    if (split < 1) throw Error("额度报警鉴权头格式无效");
    headers[credentials.auth.slice(0, split)] = credentials.auth.slice(split + 1).trim();
  }
  const result = await fetch(credentials.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!result.ok)
    throw Object.assign(new Error(`额度报警 Webhook HTTP ${result.status}`), {
      httpStatus: result.status,
    });
}
