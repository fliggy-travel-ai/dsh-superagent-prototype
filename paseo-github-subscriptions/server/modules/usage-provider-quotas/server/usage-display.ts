/** Public usage text is sanitized separately from numeric windows and private timing evidence. */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UsageReport, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";

const company = /alibaba|aliyun|alipay|阿里/iu;
const identity = /account[_ -]?(?:email|name|label)|organization|employee|user[_ -]?name|(?:^|[\s_-])(?:user|account|email)(?:$|[\s_-])|工号|组织|邮箱|账号名称|账户名称/iu;
const isoTime = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu;

function relativeTime(value: string, nowMs: number): string {
  const difference = Date.parse(value) - nowMs;
  if (!Number.isFinite(difference)) return "时间未知";
  const minutes = Math.round(Math.abs(difference) / 60_000);
  if (minutes === 0) return "刚刚";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  const duration = days ? `${days}天${hours ? `${hours}小时` : ""}`
    : hours ? `${hours}小时${rest ? `${rest}分钟` : ""}` : `${rest}分钟`;
  return `${duration}${difference > 0 ? "后" : "前"}`;
}

function cleanText(value: string, nowMs: number): string {
  return value
    .replace(/[\w.+%-]+@(?:[\w-]+\.)*(?:alibaba(?:-inc|cloud)?|aliyun|alipay)\.[\w.-]+/giu, "[邮箱已隐藏]")
    .replace(/\b(?:[\w-]+\.)*(?:alibaba(?:-inc|cloud)?|aliyun|alipay)\.[\w.-]+/giu, "[域名已隐藏]")
    .replace(/\([^)]*(?:alibaba|aliyun|alipay|阿里)[^)]*\)|（[^）]*(?:alibaba|aliyun|alipay|阿里)[^）]*）/giu, "")
    .replace(/alibaba(?:\s+group)?|aliyun|alipay|阿里(?:巴巴|集团|云)?/giu, "")
    .replace(isoTime, value => relativeTime(value, nowMs))
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]/gu, "")
    .replace(/[（(](?:上海|北京)[）)]|北京时间|上海时间|中国标准时间/gu, "")
    .replace(/\b(?:Asia|America|Europe|Australia|Pacific|Etc)\/[\w/-]+|\b(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?\b/giu, "")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, "")
    .replace(/\s{2,}/gu, " ").trim();
}

/** Clean visible report text while preserving IDs, numbers, and machine reset timestamps.
 * @param report - Provider response before presentation filtering.
 * @param nowMs - Reference time for text details.
 * @returns A new report; the original response remains unchanged.
 */
export function sanitizeUsageReport(report: UsageReport, nowMs = Date.now()): UsageReport {
  if (report.status === "error") return { ...report, error: cleanText(report.error, nowMs) || "额度查询失败" };
  if (report.status === "unavailable") {
    const problem = report.problem;
    return { ...report, problem: problem.kind === "no_quota"
      ? { ...problem, detail: cleanText(problem.detail, nowMs) || "额度不可用" }
      : { ...problem, ...(problem.refreshedBy ? { refreshedBy: cleanText(problem.refreshedBy, nowMs) } : {}) } };
  }
  const affiliated = company.test(report.planLabel ?? "") || report.details?.some(detail => company.test(`${detail.label} ${detail.value}`));
  return {
    ...report,
    ...(report.planLabel === undefined ? {} : { planLabel: cleanText(report.planLabel, nowMs) }),
    windows: report.windows.map(window => ({ ...window, label: cleanText(window.label, nowMs) || "额度",
      ...(window.shortLabel === undefined ? {} : { shortLabel: cleanText(window.shortLabel, nowMs) }) })),
    ...(report.balances ? { balances: report.balances.map(balance => ({ ...balance, label: cleanText(balance.label, nowMs) || "余额" })) } : {}),
    ...(report.details ? { details: report.details
      .filter(detail => !(affiliated && identity.test(`${detail.id} ${detail.label}`)))
      .map(detail => ({ ...detail, label: cleanText(detail.label, nowMs), value: /^(?:provider|model)_id$/u.test(detail.id)
        ? detail.value : cleanText(detail.value, nowMs) }))
      .filter(detail => detail.value !== "") } : {}),
  };
}

/** Filter a usage source at registration, including account labels and thrown failures.
 * @param source - Original source registration.
 * @param paseoHome - Same-host cache root used by the quota script.
 * @param clock - Reference clock; tests can supply a fixed observation time.
 * @returns A source with public text filtering and report-bound private TokenHub timing.
 */
export function privateUsageSource(source: UsageSourceRegistration, paseoHome: string, clock = Date.now): UsageSourceRegistration {
  return {
    ...source,
    label: cleanText(source.label, clock()),
    discover: async scope => {
      try {
        return (await source.discover(scope)).map(account => ({ ...account,
          ...(account.label === undefined ? {} : { label: source.id === "qoder" || company.test(account.label)
            ? account.key : cleanText(account.label, clock()) }),
        }));
      } catch {
        throw new Error("额度账户发现失败，请检查本机插件配置");
      }
    },
    fetch: async input => {
      try {
        const raw = await source.fetch(input);
        const display = sanitizeUsageReport(raw, clock());
        if (source.id === "opencode-token-switch" && raw.status === "available") {
          const provider = raw.details?.find(detail => detail.id === "provider_id")?.value;
          const timing = raw.details?.filter(detail => detail.id === "quota_period_start" || detail.id === "quota_observed_at") ?? [];
          if (provider && timing.length === 2) {
            const directory = path.join(paseoHome, "cache", "provider-quotas-usage-source");
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const filename = path.join(directory, `usage-timing-${encodeURIComponent(provider)}.json`);
            const temporary = `${filename}.${randomUUID()}.tmp`;
            try {
              writeFileSync(temporary, JSON.stringify({ version: 1, provider, display, timing }), { mode: 0o600, flag: "wx" });
              renameSync(temporary, filename);
            } finally {
              rmSync(temporary, { force: true });
            }
          }
        }
        return display;
      } catch {
        return { status: "error", error: "额度查询失败，请检查本机插件和登录状态" };
      }
    },
  };
}
