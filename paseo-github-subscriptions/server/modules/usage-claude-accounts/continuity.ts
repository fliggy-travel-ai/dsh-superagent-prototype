import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { UsageAccount, UsageReport } from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../../vendor/paseo-0.15.0/claude-usage-source/shared/input.ts";

type Available = Extract<UsageReport, { status: "available" }>;
export type Identity = { key: string; label?: string };
export type CredentialState = { fingerprint: string; expires?: number; refreshable: boolean; identity?: Identity };
export const HISTORY_MS = 24 * 60 * 60_000;
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function routeKey(input: UsageInput): string { return digest(JSON.stringify(input.route)); }

/** Read identity metadata, never credential values. API identity takes precedence over this fallback. */
export function readIdentity(path: string): Identity | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")).oauthAccount;
    if (![value?.accountUuid, value?.organizationUuid].every(v => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v))) return;
    const key = `${value.accountUuid}.${value.organizationUuid}`;
    if (key.length > 128) return;
    return { key, ...(typeof value.emailAddress === "string" ? { label: value.emailAddress } : {}) };
  } catch { return; }
}

const windowSchema = z.object({
  id: z.string(), label: z.string(), usedPct: z.number().finite().nullable().optional(),
  remainingPct: z.number().finite().nullable().optional(), resetsAt: z.string().nullable().optional(),
});
const historySchema = z.object({ version: z.literal(1), entries: z.record(z.string(), z.object({
  at: z.number().finite(), windows: z.array(windowSchema),
})) });
type History = { at: number; windows: z.infer<typeof windowSchema>[] };

/** Persist only quota windows and account IDs; no email, credentials, or credential fingerprints. */
export class UsageContinuity {
  private history = new Map<string, History>();
  private liveSuccess = new Set<string>();
  private identities = new Map<string, { identity: Identity; fingerprint: string; verified: boolean }>();
  private path: string;
  private now: () => number;
  constructor(path: string, now = Date.now) {
    this.path = path; this.now = now;
    try {
      this.history = new Map(Object.entries(historySchema.parse(JSON.parse(readFileSync(path, "utf8"))).entries));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("额度历史文件无法读取，将重新查询");
    }
  }
  private save() {
    try {
      for (const [key, value] of this.history) if (this.now() - value.at > HISTORY_MS || value.at > this.now()) this.history.delete(key);
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.history) }), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch { console.warn("额度历史文件暂时无法保存"); }
  }
  observe(account: UsageAccount, before: CredentialState | null, after: CredentialState | null): UsageAccount {
    const id = routeKey(account.input as UsageInput);
    const previous = this.identities.get(id);
    if (!before || !after || before.fingerprint !== after.fingerprint || before.identity?.key !== after.identity?.key) {
      this.identities.delete(id);
      return { key: id, harness: account.harness, input: account.input };
    }
    const known = previous?.fingerprint === after.fingerprint ? previous : undefined;
    const identity: Identity | undefined = account.key !== id ? { key: account.key, label: account.label }
      : known?.verified ? known.identity : after.identity ?? known?.identity;
    if (!identity) return account;
    const verified = account.key !== id || (previous?.fingerprint === after.fingerprint && previous.identity.key === identity.key && previous.verified);
    this.identities.set(id, { identity, fingerprint: after.fingerprint, verified: !!verified });
    return { ...account, ...identity };
  }
  /** Token fingerprints are compared in memory to reject account changes during an in-flight query. */
  record(input: UsageInput, before: CredentialState | null, after: CredentialState | null, report: UsageReport): boolean {
    const observed = this.identities.get(routeKey(input));
    if (!before || !after || before.fingerprint !== after.fingerprint || before.identity?.key !== after.identity?.key) return false;
    if (!observed?.verified || observed.fingerprint !== before.fingerprint) return false;
    if (report.status === "available") {
      const windows = report.windows.map(w => windowSchema.parse(w));
      this.history.set(observed.identity.key, { at: this.now(), windows });
      this.liveSuccess.add(observed.identity.key);
      this.save();
    }
    return true;
  }
  matches(input: UsageInput, accountKey: string, credential: CredentialState | null): boolean {
    const observed = this.identities.get(routeKey(input));
    return !!credential && !!observed?.verified && observed.fingerprint === credential.fingerprint && observed.identity.key === accountKey;
  }
  cached(accountKey: string): { report: Available; at: number } | null {
    const value = this.history.get(accountKey);
    if (!value || this.now() < value.at || this.now() - value.at > HISTORY_MS) return null;
    return { at: value.at, report: { status: "available", windows: value.windows } };
  }
  /** After reload the host has no retained bars. Keep historical numbers visible as unavailable text. */
  restoreMessage(accountKey: string, report: UsageReport): UsageReport {
    if (report.status === "available" || this.liveSuccess.has(accountKey)) return report;
    const history = this.cached(accountKey);
    if (!history) return report;
    const values = history.report.windows.filter(w => ["five_hour", "weekly"].includes(w.id) && Date.parse(w.resetsAt ?? "") > this.now()).flatMap(w => {
      const left = w.remainingPct ?? (w.usedPct == null ? null : 100 - w.usedPct);
      return left == null ? [] : [`${w.id === "five_hour" ? "5 小时" : "每周"}剩余 ${Math.round(left)}%`];
    });
    if (!values.length) return report;
    const time = new Date(history.at).toLocaleString("zh-CN", { hour12: false, timeZoneName: "short" });
    const reason = report.status === "error" ? report.error : report.problem.kind === "expired"
      ? "登录凭据已过期，后台正在尝试续期；若持续失败，请在对应账号的 Claude Code 终端运行 claude 检查登录"
      : report.problem.kind === "rejected" ? `登录被额度服务拒绝（${report.problem.status}），请在对应账号的 Claude Code 终端运行 claude 检查登录`
      : report.problem.detail;
    return { status: "unavailable", problem: { kind: "no_quota", detail: `${reason}。历史记录：${values.join("，")}。上次成功查询：${time}。历史记录不代表当前可用额度。` } };
  }
}
