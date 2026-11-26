import { spawn, type ChildProcess } from "node:child_process";
import { execCommand } from "@getpaseo/plugin/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { smartFetch } from "./net.ts";
import { discoverTokenSwitchAccounts, fetchTokenHubUsage } from "./token-switch.ts";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

export function resolvePaseoHome(): { home: string; paseoHome: string } {
  const fallbackHome = (() => {
    try {
      return os.userInfo().homedir || os.homedir();
    } catch {
      return os.homedir();
    }
  })();
  const paseoHome = (process.env.PASEO_HOME ?? "~/.paseo").replace(
    /^~(?=$|\/)/u,
    fallbackHome,
  );
  const home =
    path.basename(paseoHome) === ".paseo" ? path.dirname(paseoHome) : fallbackHome;
  return { home, paseoHome };
}

const { home: REAL_HOME, paseoHome: PASEO_HOME } = resolvePaseoHome();
const PASEO_CONFIG_PATH = path.join(PASEO_HOME, "config.json");

const AGY_COMMAND = /(?:^|\/)agy(?:-paseo(?:-[^/]+)?)?$/u;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const AccountInputSchema = z.object({
  providerId: z.string(),
  label: z.string().optional(),
  email: z.string().optional(),
  authPath: z.string().optional(),
  command: z.array(z.string()).optional(),
  homeDir: z.string().optional(),
  configPath: z.string().optional(),
  proxyUrl: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

type AccountInput = z.infer<typeof AccountInputSchema>;

interface ProviderConfigEntry {
  enabled?: boolean;
  label?: string;
  extends?: string;
  command?: string[] | string;
  env?: Record<string, string>;
}

function commandArray(cmd: string[] | string | undefined): string[] {
  if (Array.isArray(cmd)) return cmd.filter((part): part is string => typeof part === "string");
  if (typeof cmd === "string" && cmd.trim()) return [cmd.trim()];
  return [];
}

function readJson<T = Record<string, any>>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readProvidersConfig(): Record<string, ProviderConfigEntry> {
  const config = readJson<{ agents?: { providers?: Record<string, ProviderConfigEntry> } }>(
    PASEO_CONFIG_PATH,
  );
  const configured = config?.agents?.providers ?? {};
  return {
    codex: {},
    grok: {},
    cursor: {},
    ...configured,
  };
}

function decodeJwtPayload(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function roundPct(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function makeWindow(input: {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  usedPct: number | null | undefined;
  resetsAt?: string | null;
}): UsageWindow {
  const pct = roundPct(input.usedPct);
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    shortLabel: input.shortLabel,
    summary: input.summary,
    utilizationPct: pct,
    resetsAt: input.resetsAt ?? null,
    tone: toneFromUsedPct(pct),
  });
}

function windowUsedPct(w: UsageWindow): number {
  if (typeof w.usedPct === "number" && Number.isFinite(w.usedPct)) {
    return w.usedPct;
  }
  if (typeof w.remainingPct === "number" && Number.isFinite(w.remainingPct)) {
    return 100 - w.remainingPct;
  }
  return -1;
}

function pinLowestRemainingWindow(windows: UsageWindow[]): UsageWindow[] {
  if (windows.length === 0) return windows;
  const indexed = windows.map((w, idx) => ({ w, idx }));
  const candidates = indexed.some((item) => item.w.summary)
    ? indexed.filter((item) => item.w.summary)
    : indexed;

  let bestIdx = candidates[0]!.idx;
  let bestUsed = windowUsedPct(candidates[0]!.w);

  for (const { w, idx } of candidates.slice(1)) {
    const used = windowUsedPct(w);
    // Higher usedPct means lower remainingPct.
    // On a tie (e.g. 5h and 7d both at 100% remaining), prefer the later window (7d / Argon).
    if (used >= bestUsed) {
      bestUsed = used;
      bestIdx = idx;
    }
  }

  return windows.map((w, idx) =>
    idx === bestIdx
      ? { ...w, id: "effective", summary: true }
      : { ...w, summary: false },
  );
}

function isoFromEpochSeconds(value: unknown): string | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Date(num * 1000).toISOString();
}

function isoFromEpochMs(value: unknown): string | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Date(num).toISOString();
}

// ============================================================================
// 1. Antigravity Usage Source
// ============================================================================

// 官方额度来源已经覆盖这两个内置 Provider。多账号来源再报一次，用量列表会画出重复卡。
function coveredByOfficialUsage(providerId: string): boolean {
  return providerId === "codex" || providerId === "antigravity";
}

function discoverAntigravityAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false || coveredByOfficialUsage(providerId)) continue;
    const cmdParts = commandArray(cfg?.command);
    const isAgy =
      providerId === "antigravity" ||
      providerId.startsWith("antigravity-") ||
      cmdParts.some((part) => AGY_COMMAND.test(part));
    if (!isAgy) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const rawHome =
      (scope.kind === "session" ? scope.env?.HOME : undefined) ||
      cfg?.env?.HOME ||
      REAL_HOME;
    const homeDir = rawHome.trim().replace(/^~(?=$|\/)/u, REAL_HOME);
    const authPath = path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    if (!fs.existsSync(authPath)) continue;

    const labelEmail = cfg?.label?.match(/([\w.+-]+@[\w.-]+)/u)?.[1];
    const displayLabel = labelEmail
      ? `${labelEmail} (${providerId})`
      : cfg?.label || providerId;

    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "Antigravity",
      input: {
        providerId,
        label: displayLabel,
        email: labelEmail,
        authPath,
        homeDir,
        proxyUrl: cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY,
      } satisfies AccountInput as Record<string, any>,
    });
  }
  return accounts;
}

const agyUsageResponse = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.literal("usage"),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

function agyWindowLabel(name: string, window: string): string {
  if (window.trim().toLowerCase() === "5h") return "5h";
  return name.trim().replace(/(?:\s+Limit)?\s+Remaining$/i, "");
}

function agyShortWindow(window: string): string {
  const trimmed = window.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return trimmed;
}

function agyWindowDuration(window: string): number | undefined {
  switch (window.trim().toLowerCase()) {
    case "5h":
      return 5 * 3600;
    case "weekly":
      return 7 * 86400;
    default:
      return undefined;
  }
}

function agyGroupLabel(name: string): string {
  return name.trim().replace(/(?:^|\s+)models$/i, "").trim();
}

/** 裸 agy 会读登录钥匙串。额度查询固定走 agy-paseo，由包装脚本设置 SSH_CONNECTION。 */
function agyPaseoBinary(command: readonly string[] | undefined): string {
  const bin = command?.[0];
  if (bin && /(?:^|\/)agy-paseo(?:-[^/]+)?$/u.test(bin)) return bin;
  return path.join(REAL_HOME, ".local/bin/agy-paseo");
}

function agyUsageEnv(input: AccountInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (input.proxyUrl) {
    env.HTTPS_PROXY = input.proxyUrl;
    env.HTTP_PROXY = input.proxyUrl;
    env.https_proxy = input.proxyUrl;
    env.http_proxy = input.proxyUrl;
  }
  if (input.homeDir) env.HOME = input.homeDir;
  return env;
}

async function fetchAntigravityUsage(input: AccountInput): Promise<UsageReport> {
  const command = agyPaseoBinary(input.command);
  let stdout: string;
  try {
    const result = await execCommand(command, ["-p", "/usage", "--output-format", "json"], {
      env: agyUsageEnv(input),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch {
    return {
      status: "error",
      error: "Antigravity usage command failed or timed out. Check that agy is signed in.",
    };
  }
  let parsed: z.infer<typeof agyUsageResponse>;
  try {
    parsed = agyUsageResponse.parse(JSON.parse(stdout));
  } catch {
    return { status: "error", error: "agy did not return usage data" };
  }
  if (parsed.status !== "SUCCESS") {
    return {
      status: "error",
      error: parsed.error || parsed.response || `agy usage returned ${parsed.status}`,
    };
  }
  if (!parsed.command) return { status: "error", error: "agy did not return usage data" };
  const groups = parsed.command.data.groups;
  const includeGroup = groups.length > 1;
  const windows = groups.flatMap((group) => {
    const groupLabel = agyGroupLabel(group.name);
    return group.buckets.flatMap((bucket) => {
      if (!bucket.disabled && bucket.remaining_fraction == null) return [];
      const used = bucket.disabled ? null : (1 - bucket.remaining_fraction!) * 100;
      return [
        windowFromUsedPct({
          id: bucket.id,
          label: [groupLabel, agyWindowLabel(bucket.name, bucket.window), bucket.disabled ? "Disabled" : null]
            .filter(Boolean)
            .join(" · "),
          shortLabel:
            includeGroup && groupLabel
              ? `${groupLabel} ${agyShortWindow(bucket.window)}`
              : agyShortWindow(bucket.window),
          summary: !bucket.disabled && bucket.window === "weekly",
          utilizationPct: used,
          durationSeconds: agyWindowDuration(bucket.window),
          resetsAt: bucket.disabled ? null : (bucket.reset_time ?? null),
          tone: used === null ? "default" : toneFromUsedPct(used),
        }),
      ];
    });
  });
  if (windows.length === 0) return unavailable({ kind: "no_quota", detail: "No usage quota reported by agy" });
  return { status: "available", windows };
}

// ============================================================================
// 2. Codex Multi-Account Usage Source
// ============================================================================

function discoverCodexAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];
  const codexProviders = Object.entries(providers).filter(([providerId, cfg]) =>
    providerId === "codex" || providerId.startsWith("codex-") || cfg?.extends === "codex",
  );
  let selected = codexProviders.filter(([, cfg]) => cfg?.enabled !== false);
  if (scope.kind === "session") {
    if (scope.env.OPENAI_BASE_URL) return [];
    const sessionHome = scope.env.CODEX_HOME || path.join(scope.env.HOME || REAL_HOME, ".codex");
    const matches = scope.provider === "codex"
      ? codexProviders.filter(([, cfg]) => path.resolve(cfg?.env?.CODEX_HOME || path.join(cfg?.env?.HOME || REAL_HOME, ".codex")) === path.resolve(sessionHome))
      : codexProviders.filter(([providerId]) => providerId === scope.provider);
    const provider = matches.find(([, cfg]) => cfg?.enabled !== false) ?? matches[0];
    selected = provider ? [provider] : scope.provider === "codex" ? [["codex", {}]] : [];
  }

  for (const [providerId, cfg] of selected) {
    if (coveredByOfficialUsage(providerId)) continue;
    const configuredHome = cfg?.env?.CODEX_HOME || path.join(cfg?.env?.HOME || REAL_HOME, ".codex");
    const codexHome = scope.kind === "session"
      ? scope.env.CODEX_HOME || (scope.env.HOME ? path.join(scope.env.HOME, ".codex") : configuredHome)
      : configuredHome;
    const authPath = path.join(codexHome, "auth.json");
    if (!fs.existsSync(authPath)) continue;

    const auth = readJson<Record<string, any>>(authPath);
    const idClaims = decodeJwtPayload(auth?.tokens?.id_token);
    const authClaims = decodeJwtPayload(auth?.tokens?.access_token);
    const email =
      idClaims?.email ||
      authClaims?.["https://api.openai.com/profile"]?.email ||
      cfg?.label?.match(/([\w.+-]+@[\w.-]+)/u)?.[1];

    const displayLabel = email ? `${email} (${providerId})` : cfg?.label || providerId;
    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "Codex",
      input: {
        providerId,
        label: displayLabel,
        email,
        authPath,
        proxyUrl: scope.kind === "session"
          ? scope.env.HTTPS_PROXY || scope.env.HTTP_PROXY || cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY
          : cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY,
      } satisfies AccountInput as Record<string, any>,
    });
  }
  return accounts;
}

async function fetchCodexUsage(input: AccountInput): Promise<UsageReport> {
  if (!input.authPath || !fs.existsSync(input.authPath)) {
    return { status: "error", error: "Missing Codex auth.json" };
  }
  const auth = readJson<Record<string, any>>(input.authPath);
  if (!auth?.tokens?.access_token) {
    return { status: "error", error: "Missing Codex access_token" };
  }

  // 不刷新 Codex 令牌：刷新令牌被插件用掉后，Codex CLI 持有的旧令牌失效，会被登出。只提示，让 Codex CLI 自己刷新。
  const claims = decodeJwtPayload(auth.tokens.access_token);
  if (claims?.exp && claims.exp * 1000 <= Date.now()) {
    return { status: "error", error: "Codex 令牌已过期，插件不会刷新（刷新会让 Codex CLI 登出）。请运行一次 codex 或 codex login" };
  }

  const callUsage = (token: string, accountId?: string) =>
    smartFetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "codex-cli",
        ...(accountId ? { "ChatGPT-Account-Id": String(accountId) } : {}),
      },
      proxyUrl: input.proxyUrl,
    });

  const res = await callUsage(auth.tokens.access_token, auth.tokens.account_id);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return unavailable({ kind: "rejected", status: res.status, refreshedBy: "codex login" });
    }
    return { status: "error", error: `Codex HTTP ${res.status}` };
  }

  const data = await res.json();
  const windows: UsageWindow[] = [];
  const pushCodexWindow = (win: any, fallbackKind: "5h" | "7d") => {
    if (!win || typeof win.used_percent !== "number") return;
    const sec = typeof win.limit_window_seconds === "number" ? win.limit_window_seconds : null;
    const isWeekly =
      sec !== null ? sec >= 5 * 86400 : fallbackKind === "7d";
    const hours = sec !== null && !isWeekly ? Math.round(sec / 3600) : 5;
    windows.push(
      makeWindow({
        id: isWeekly ? "weekly" : `hours_${hours}`,
        label: isWeekly ? "Weekly limit" : `${hours}-hour limit`,
        shortLabel: isWeekly ? "7d" : `${hours}h`,
        summary: true,
        usedPct: win.used_percent,
        resetsAt: isoFromEpochSeconds(win.reset_at),
      }),
    );
  };

  pushCodexWindow(data?.rate_limit?.primary_window, "5h");
  pushCodexWindow(data?.rate_limit?.secondary_window, "7d");

  const balances: UsageBalance[] = [];
  const creditBalance = data?.credits?.has_credits === false ? 0 : Number(data?.credits?.balance);
  if (Number.isFinite(creditBalance) && creditBalance > 0) {
    const remaining = Math.round(creditBalance * 100) / 100;
    balances.push({
      id: "credits",
      label: "Credits",
      remaining,
      unit: "usd",
      tone: balanceToneFromRemaining(remaining),
    });
  }

  const planRaw = typeof data?.plan_type === "string" ? data.plan_type : undefined;
  const planLabel = planRaw ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1) : undefined;

  const details: UsageDetail[] = [
    { id: "provider_id", label: "Provider ID", value: input.providerId },
  ];
  if (data?.credits?.unlimited === true) details.push({ id: "payable_credit", label: "Credits", value: "unlimited" });
  if (input.email) {
    details.push({ id: "email", label: "Account Email", value: input.email });
  }

  return {
    status: "available",
    planLabel,
    windows: pinLowestRemainingWindow(windows),
    balances,
    details,
  };
}

/** 进行中的子进程：模块停止时统一结束。stdin 写入已关闭的管道会触发 error，必须有监听，否则整个进程崩溃。 */
const usageChildren = new Set<ChildProcess>();

function trackChild<T extends ChildProcess>(child: T): T {
  usageChildren.add(child);
  const forget = () => { usageChildren.delete(child); };
  child.on("close", forget);
  child.on("error", forget);
  child.stdin?.on("error", () => {});
  return child;
}

export const runningUsageChildren = (): number => usageChildren.size;

export function stopUsageChildren(): void {
  for (const child of usageChildren) child.kill("SIGTERM");
}

// ============================================================================
// 3. GLM Coding Plan Usage Source
// ============================================================================

function discoverGlmAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
    const cmdParts = commandArray(cfg?.command);
    const isGlm =
      providerId === "glm-acp-agent" ||
      providerId.startsWith("glm") ||
      cmdParts.some((part) => /^glm-acp-agent(@|$)/u.test(part));
    if (!isGlm) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const configHome =
      (scope.kind === "session" ? scope.env?.XDG_CONFIG_HOME : undefined) ||
      cfg?.env?.XDG_CONFIG_HOME ||
      process.env.XDG_CONFIG_HOME ||
      path.join(REAL_HOME, ".config");
    const authPath = path.join(configHome, "glm-acp-agent", "credentials.json");
    if (!fs.existsSync(authPath)) continue;

    const displayLabel = `Z.ai Coding Plan (${providerId})`;
    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "GLM Agent",
      input: {
        providerId,
        label: displayLabel,
        authPath,
        proxyUrl: cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY,
      } satisfies AccountInput as Record<string, any>,
    });
  }
  return accounts;
}

async function fetchGlmUsage(input: AccountInput): Promise<UsageReport> {
  if (!input.authPath || !fs.existsSync(input.authPath)) {
    return { status: "error", error: "Missing GLM credentials.json" };
  }
  const creds = readJson<Record<string, any>>(input.authPath);
  const apiKey = creds?.z_ai_api_key;
  if (!apiKey) {
    return { status: "error", error: "Missing z_ai_api_key in credentials.json" };
  }

  const res = await smartFetch("https://api.z.ai/api/monitor/usage/quota/limit", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    proxyUrl: input.proxyUrl,
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return unavailable({ kind: "rejected", status: res.status });
    }
    return { status: "error", error: `GLM HTTP ${res.status}` };
  }

  const payload = await res.json();
  if (payload?.success === false) {
    return { status: "error", error: payload?.msg || "GLM quota query failed" };
  }

  const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];

  for (const item of limits) {
    const resetsAt = isoFromEpochMs(item.nextResetTime);
    if (item.type === "TOKENS_LIMIT" && Number(item.unit) === 3) {
      windows.push(
        makeWindow({
          id: `tokens_${item.number}h`,
          label: `${item.number}-hour limit`,
          shortLabel: `${item.number}h`,
          summary: true,
          usedPct: Number(item.percentage ?? 0),
          resetsAt,
        }),
      );
    } else if (item.type === "TOKENS_LIMIT" && Number(item.unit) === 6) {
      windows.push(
        makeWindow({
          id: "weekly",
          label: "Weekly limit",
          shortLabel: "7d",
          summary: true,
          usedPct: Number(item.percentage ?? 0),
          resetsAt,
        }),
      );
    } else if (item.type === "TIME_LIMIT") {
      windows.push(
        makeWindow({
          id: "mcp_monthly",
          label: "MCP monthly limit",
          shortLabel: "MCP",
          summary: false,
          usedPct: Number(item.percentage ?? 0),
          resetsAt,
        }),
      );
      if (typeof item.usage === "number") {
        const used = Number(item.currentValue ?? 0);
        const limit = Number(item.usage);
        const remaining =
          typeof item.remaining === "number" ? Number(item.remaining) : Math.max(0, limit - used);
        balances.push({
          id: "mcp_calls",
          label: "MCP monthly quota",
          used,
          remaining,
          limit,
          unit: "requests",
          resetsAt,
          tone: toneFromUsedPct(Number(item.percentage ?? 0)),
        });
      }
    }
  }

  const level = payload?.data?.level;
  return {
    status: "available",
    planLabel: level ? `Coding Plan (${String(level).toUpperCase()})` : "Coding Plan",
    windows: pinLowestRemainingWindow(windows),
    balances,
    details: [{ id: "provider_id", label: "Provider ID", value: input.providerId }],
  };
}

// ============================================================================
// 4. Qoder Usage Source (via qodercli --sdk daemon protocol v2)
// ============================================================================

function discoverQoderAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
    const cmdParts = commandArray(cfg?.command);
    const isQoder =
      providerId === "qoder" ||
      providerId.startsWith("qoder-") ||
      cmdParts.some((part) => /(?:^|\/)(?:@qoder-ai\/qodercli|qodercli)(?:@[^/]*)?$/u.test(part));
    if (!isQoder) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const binPath = cmdParts[0] || path.join(REAL_HOME, ".local", "bin", "qodercli");
    if (!fs.existsSync(binPath)) continue;

    const cleanCfgLabel = cfg?.label ? String(cfg.label).replace(/^Qoder\s*[·:-]\s*/iu, "").trim() : "";
    const displayLabel = cleanCfgLabel ? `${cleanCfgLabel} (${providerId})` : providerId;
    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "Qoder",
      input: {
        providerId,
        label: displayLabel,
        command: [binPath],
        homeDir: cfg?.env?.HOME || REAL_HOME,
      } satisfies AccountInput,
    });
  }
  return accounts;
}

async function fetchQoderUsage(input: AccountInput): Promise<UsageReport> {
  const binPath = input.command?.[0] || path.join(REAL_HOME, ".local", "bin", "qodercli");
  if (!fs.existsSync(binPath)) {
    return { status: "error", error: `Missing qodercli binary at ${binPath}` };
  }

  return await new Promise<UsageReport>((resolve) => {
    const child = trackChild(spawn(binPath, ["--sdk"], {
      env: {
        ...process.env,
        HOME: input.homeDir || REAL_HOME,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }));

    let settled = false;
    let stdoutBuf = "";
    let accountInfo: Record<string, any> | null = null;
    let usageInfo: Record<string, any> | null = null;

    const finish = (report: UsageReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.write(
          `${JSON.stringify({
            type: "control_request",
            request_id: "4",
            request: { subtype: "daemon.shutdown" },
          })}\n`,
        );
      } catch {
        // Ignore write error on shutdown.
      }
      setTimeout(() => {
        if (!child.killed) child.kill();
      }, 200).unref();
      resolve(report);
    };

    const timer = setTimeout(() => {
      finish({ status: "error", error: "qodercli --sdk timeout" });
    }, 15_000);

    child.on("error", (err) => {
      finish({ status: "error", error: err.message });
    });

    child.on("close", (code) => {
      if (!settled) {
        finish({ status: "error", error: `qodercli exited (code ${code ?? "null"})` });
      }
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const resp = msg?.response;
        if (!resp) continue;

        if (resp.request_id === "1") {
          if (resp.subtype === "error") {
            finish({ status: "error", error: resp.error || "Qoder initialize failed" });
            return;
          }
          child.stdin.write(
            `${JSON.stringify({
              type: "control_request",
              request_id: "2",
              request: { subtype: "daemon.account_info" },
            })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              type: "control_request",
              request_id: "3",
              request: { subtype: "daemon.get_usage_info" },
            })}\n`,
          );
        } else if (resp.request_id === "2") {
          if (resp.subtype === "success") {
            accountInfo = resp.response?.account ?? null;
          }
        } else if (resp.request_id === "3") {
          if (resp.subtype === "error") {
            finish({ status: "error", error: resp.error || "Qoder get_usage_info failed" });
            return;
          }
          usageInfo = resp.response?.usage ?? null;

          const windows: UsageWindow[] = [];
          const balances: UsageBalance[] = [];
          const resetsAt = isoFromEpochMs(usageInfo?.expiresAt);

          const orgPkg = usageInfo?.orgResourcePackage;
          if (orgPkg && Number(orgPkg.cap) > 0) {
            const used = Number(orgPkg.used ?? 0);
            const limit = Number(orgPkg.cap ?? 0);
            const remaining =
              typeof orgPkg.remaining === "number"
                ? Number(orgPkg.remaining)
                : Math.max(0, limit - used);
            const usedPct =
              typeof orgPkg.percentage === "number"
                ? Number(orgPkg.percentage)
                : (used / limit) * 100;

            windows.push(
              makeWindow({
                id: "org_credits",
                label: "Organization credits",
                shortLabel: "Org",
                summary: true,
                usedPct,
                resetsAt,
              }),
            );
            balances.push({
              id: "org_credits_balance",
              label: "Organization credits",
              used,
              remaining,
              limit,
              unit: "credits",
              resetsAt,
              tone: toneFromUsedPct(usedPct),
            });
          }

          const userQuota = usageInfo?.userQuota;
          if (userQuota && Number(userQuota.total) > 0) {
            const used = Number(userQuota.used ?? 0);
            const limit = Number(userQuota.total ?? 0);
            const remaining =
              typeof userQuota.remaining === "number"
                ? Number(userQuota.remaining)
                : Math.max(0, limit - used);
            const usedPct =
              typeof userQuota.percentage === "number"
                ? Number(userQuota.percentage)
                : (used / limit) * 100;

            windows.push(
              makeWindow({
                id: "user_credits",
                label: "Personal credits",
                shortLabel: "Personal",
                summary: true,
                usedPct,
                resetsAt,
              }),
            );
            balances.push({
              id: "user_credits_balance",
              label: "Personal credits",
              used,
              remaining,
              limit,
              unit: "credits",
              resetsAt,
              tone: toneFromUsedPct(usedPct),
            });
          }

          const details: UsageDetail[] = [
            { id: "provider_id", label: "Provider ID", value: input.providerId },
          ];
          if (accountInfo?.email) {
            details.push({ id: "email", label: "Account Email", value: String(accountInfo.email) });
          }
          if (accountInfo?.organizationName) {
            details.push({
              id: "organization",
              label: "Organization",
              value: String(accountInfo.organizationName),
            });
          }

          const userType = usageInfo?.userType
            ? String(usageInfo.userType).charAt(0).toUpperCase() + String(usageInfo.userType).slice(1)
            : "Qoder";
          const planLabel = accountInfo?.organizationName
            ? `${userType} (${accountInfo.organizationName})`
            : userType;

          finish({
            status: "available",
            planLabel,
            windows: pinLowestRemainingWindow(windows),
            balances,
            details,
          });
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: "1",
        request: {
          subtype: "daemon.initialize",
          daemon_protocol_version: 2,
          sdk_version: "1.1.81",
          capabilities: ["multi_session_v2"],
          auth: { type: "qodercli" },
        },
      })}\n`,
    );
  });
}

// ============================================================================
// Registration Export
// ============================================================================

export function createUsageSources(): UsageSourceRegistration[] {
  return [
    {
      id: "opencode-token-switch",
      label: "OpenCode · TokenHub",
      input: AccountInputSchema.extend({ homeDir: z.string(), configPath: z.string() }),
      discover: async (scope) => discoverTokenSwitchAccounts(scope, readProvidersConfig(), REAL_HOME),
      fetch: async (raw) => fetchTokenHubUsage(
        AccountInputSchema.extend({ homeDir: z.string(), configPath: z.string() }).parse(raw), PASEO_HOME,
      ),
    },
    {
      id: "antigravity-multi",
      label: "Antigravity",
      icon: "icons/antigravity.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverAntigravityAccounts(scope),
      fetch: async (raw) => fetchAntigravityUsage(AccountInputSchema.parse(raw)),
    },
    {
      id: "codex-multi",
      label: "Codex",
      icon: "icons/codex.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverCodexAccounts(scope),
      fetch: async (raw) => fetchCodexUsage(AccountInputSchema.parse(raw)),
    },
    {
      id: "qoder",
      label: "Qoder",
      icon: "icons/qoder.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverQoderAccounts(scope),
      fetch: async (raw) => fetchQoderUsage(AccountInputSchema.parse(raw)),
    },
    {
      id: "glm",
      label: "GLM Coding Plan",
      icon: "icons/zai.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverGlmAccounts(scope),
      fetch: async (raw) => fetchGlmUsage(AccountInputSchema.parse(raw)),
    },
  ];
}
