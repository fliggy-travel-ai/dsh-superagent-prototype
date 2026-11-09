import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { UsageAccount, UsageReport, UsageScope } from "@getpaseo/plugin/server/usage";
import { readTokenHubCredits } from "./token-hub-browser.ts";

const quotaReasonText: Record<string, string> = {
  identity_missing: "缺少账户身份，无法核对 TokenHub 登录",
  browser_disabled: "TokenHub 后台查询尚未取得可用登录态",
  browser_config_invalid: "浏览器额度读取配置无效",
  browser_login_required: "Token Hub 页面或登录已失效",
  browser_account_mismatch: "浏览器与 Token Switch 账户不一致",
  browser_unavailable: "浏览器额度读取不可用",
  browser_control_lost: "浏览器任务已交给用户，无法读取额度",
  browser_cleanup_unconfirmed: "浏览器查询结束状态未确认，请检查临时任务",
  quota_request_failed: "Token Hub 额度请求失败",
  quota_response_invalid: "Token Hub 额度响应无效",
  rate_limited: "Token Hub 查询受限，请等待后重试",
};

interface ProviderConfig {
  enabled?: boolean;
  extends?: string;
  label?: string;
  command?: string[] | string;
  env?: Record<string, string>;
}

export interface TokenSwitchInput {
  providerId: string;
  label?: string;
  homeDir: string;
  configPath: string;
}

export interface TokenSwitchModel {
  id: string;
  name: string;
  modeCode: string;
}

interface CatalogRow {
  id: string;
  name: string;
  meta: string;
}

interface OpenCodeConfig {
  provider?: Record<string, { options?: { baseURL?: string }; models?: Record<string, { name?: string }> }>;
  enabled_providers?: string[];
  disabled_providers?: string[];
}

interface StoredSession {
  version?: number;
  algorithm?: string;
  nonce?: string;
  ciphertext?: string;
}

/** Discover configured OpenCode accounts without copying tokens into Paseo account locators. */
export function discoverTokenSwitchAccounts(
  scope: UsageScope, providers: Record<string, ProviderConfig>, home: string,
): UsageAccount[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    if (entry.enabled === false || (scope.kind === "session" && scope.provider !== providerId)) return [];
    const seen = new Set<string>();
    const chain: ProviderConfig[] = [];
    let current: string | undefined = providerId;
    let matches = false;
    while (current && !seen.has(current)) {
      seen.add(current);
      const config: ProviderConfig = providers[current] ?? {};
      chain.unshift(config);
      const command = Array.isArray(config.command) ? config.command.join(" ") : config.command ?? "";
      matches ||= current === "opencode" || /(?:^|[\/\s])opencode(?:\s|$)/u.test(command);
      current = config.extends;
    }
    if (!matches) return [];
    const env = Object.assign({}, ...chain.map(config => config.env), scope.kind === "session" ? scope.env : {});
    const homeDir = (env.HOME || home).replace(/^~(?=$|\/)/u, home);
    if (!existsSync(path.join(homeDir, ".token-switch", "token-switch.db"))) return [];
    const configPath = (env.OPENCODE_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "opencode", "opencode.json"))
      .replace(/^~(?=$|\/)/u, homeDir);
    const label = entry.label ? `${entry.label} (${providerId})` : providerId;
    return [{ key: providerId, label, harness: "OpenCode", input: { providerId, label, homeDir, configPath } }];
  });
}

/** Only models enabled in OpenCode and routed through the matching Token Switch relay qualify. */
export function tokenSwitchModels(config: OpenCodeConfig, rows: CatalogRow[]): TokenSwitchModel[] {
  const models: TokenSwitchModel[] = [];
  for (const row of rows) {
    const entry = config.provider?.[row.id];
    if (!entry || config.disabled_providers?.includes(row.id)
      || (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes(row.id))) continue;
    const managed = JSON.parse(row.meta || "{}").managedCatalog;
    if (typeof managed?.serverModelId !== "string") continue;
    const baseURL = entry.options?.baseURL;
    if (!baseURL || !(URL as unknown as { canParse(url: string): boolean }).canParse(baseURL)) continue;
    const url = new URL(baseURL);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.pathname.replace(/\/$/u, "") !== `/opencode/${managed.serverModelId}/v1`) continue;
    for (const [modelId, model] of Object.entries(entry.models ?? {})) {
      const name = model.name || row.name;
      models.push({ id: `${row.id}/${modelId}`, name, modeCode: managed.serverModelId });
    }
  }
  return models;
}

/** Decode the verified v1 local envelope in memory; do not refresh or rewrite Token Switch login state. */
export function decryptTokenSwitchSession(installationId: string, stored: StoredSession): string {
  if (!installationId || stored?.version !== 1 || stored.algorithm !== "sha256-stream-xor"
    || typeof stored.nonce !== "string" || typeof stored.ciphertext !== "string") {
    throw new Error("Token Switch 登录存储格式不受支持");
  }
  const nonce = Buffer.from(stored.nonce, "base64");
  const ciphertext = Buffer.from(stored.ciphertext, "base64");
  const key = createHash("sha256").update("token-switch-auth-session-v1").update(installationId).update(nonce).digest();
  const plaintext = Buffer.alloc(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += 32) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64LE(BigInt(offset / 32));
    const stream = createHash("sha256").update(key).update(nonce).update(counter).digest();
    for (let index = 0; index < Math.min(32, ciphertext.length - offset); index++) {
      plaintext[offset + index] = ciphertext[offset + index]! ^ stream[index]!;
    }
  }
  try {
    const session = JSON.parse(plaintext.toString("utf8"));
    if (typeof session.accessToken !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(session.accessToken)) {
      throw new Error();
    }
    return session.accessToken;
  } catch {
    throw new Error("Token Switch 登录存储无法读取，请在 Token Switch 中检查登录");
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

/** Read shared Credits for the account identified by the Token Switch session.
 * @param input - OpenCode provider and local account paths.
 * @param paseoHome - Paseo configuration and cache directory.
 * @param nowMs - Observation time in milliseconds.
 * @param readCredits - Same-account TokenHub reader.
 * @returns Shared Credits or an unavailable report without a guessed balance.
 */
export async function fetchTokenHubUsage(
  input: TokenSwitchInput, paseoHome: string, nowMs = Date.now(),
  readCredits: typeof readTokenHubCredits = readTokenHubCredits,
): Promise<UsageReport> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(input.homeDir, ".token-switch", "token-switch.db"), { readOnly: true });
    let settings: Record<string, string>;
    let rows: CatalogRow[];
    try {
      settings = Object.fromEntries(database.prepare("SELECT key, value FROM settings WHERE key IN ('token_switch_auth_install_id', 'token_switch_auth_session_secret_v1')").all()
        .map(row => [String(row.key), String(row.value)]));
      rows = database.prepare("SELECT id, name, meta FROM providers WHERE app_type = 'opencode'").all().map(row => {
        if (typeof row.id !== "string" || typeof row.name !== "string" || (row.meta !== null && typeof row.meta !== "string")) {
          throw new Error("Token Switch 模型目录格式不受支持");
        }
        return { id: row.id, name: row.name, meta: row.meta ?? "" };
      });
    } finally {
      database.close();
    }
    const models = tokenSwitchModels(JSON.parse(readFileSync(input.configPath, "utf8")), rows);
    if (models.length === 0) return { status: "unavailable", problem: { kind: "no_quota", detail: "OpenCode 没有启用通过 Token Switch 转发的托管模型" } };
    if (!settings.token_switch_auth_session_secret_v1) {
      return { status: "unavailable", problem: { kind: "no_quota", detail: "请先登录 Token Switch" } };
    }
    const token = decryptTokenSwitchSession(settings.token_switch_auth_install_id!, JSON.parse(settings.token_switch_auth_session_secret_v1));
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    const details: NonNullable<Extract<UsageReport, { status: "available" }>["details"]> = [
      { id: "provider_id", label: "Provider ID", value: input.providerId },
      { id: "quota_scope", label: "账户整体额度", value: "账户共享额度；总额、已用、剩余量及重置时间未知" },
    ];
    const employeeNo = typeof claims.employee_no === "string" || typeof claims.employee_no === "number" ? String(claims.employee_no) : "";
    const shared = await readCredits(employeeNo, input.homeDir, paseoHome, nowMs);
    if (!shared.quota) {
      details.push({ id: "quota_reason", label: "整体额度查询", value: quotaReasonText[shared.reason] ?? "整体额度查询失败" });
      return { status: "available", planLabel: "TokenHub · 账户整体额度未知", windows: [], balances: [], details };
    }
    const quota = shared.quota;
    const remainingPct = Math.max(0, Math.min(100, quota.remainingPct));
    details[1] = { id: "quota_scope", label: "账户整体额度", value: "与千问办公共享；不含 DogFooding 专属积分" };
    details.push(
      { id: "quota_source", label: "额度来源", value: "token_hub_browser" },
      { id: "quota_period_start", label: "周期开始", value: quota.periodStart },
      { id: "quota_observed_at", label: "额度查询时间", value: shared.observedAt },
      { id: "quota_reset", label: "重置时间（上海）", value: quota.resetsAt },
    );
    return {
      status: "available", planLabel: "TokenHub · 账户共享积分",
      windows: [{ id: "shared_credits", label: "共享月额度", shortLabel: "月", summary: true, remainingPct, resetsAt: quota.resetsAt }],
      balances: [{ id: "shared_credits", label: "共享积分", remaining: quota.remaining, used: quota.used, limit: quota.total, unit: "credits", resetsAt: quota.resetsAt }],
      details,
    };
  } catch {
    return { status: "error", error: "TokenHub 额度读取失败，请检查账户登录、配置和网络" };
  }
}
