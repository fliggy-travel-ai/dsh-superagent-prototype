import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeJsonFile } from "../../../core/provider-config.ts";
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
const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const AGY_MODELS_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const AGY_TOKEN_URL = "https://oauth2.googleapis.com/token";
const AGY_MODELS_UA = "antigravity/hub/2.25.0";
const AGY_FAMILIES = [
  {
    id: "gemini_3_8_flash",
    label: "Gemini 3.8 Flash",
    shortLabel: "Flash",
    pattern: /^gemini-3\.8-flash-(?:low|medium|high)$/u,
  },
  {
    id: "gemini_4_argon",
    label: "Gemini 4 Argon",
    shortLabel: "Argon",
    pattern: /^gemini-4-argon-(?:low|medium|high)$/u,
  },
];
const HOUR_MS = 3_600_000;
const AGY_5H_SKEW_MS = 30 * 60 * 1000;

const GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SUBSCRIPTION_URL =
  "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const ACP_HANDSHAKE =
  [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n";

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

function discoverAntigravityAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
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

function readAntigravityTokenFile(authPath: string) {
  if (!fs.existsSync(authPath)) return null;
  const raw = readJson<Record<string, any>>(authPath);
  if (!raw || typeof raw !== "object") return null;
  const token =
    raw.token !== null && typeof raw.token === "object" ? raw.token : raw;
  if (
    !token ||
    typeof token !== "object" ||
    typeof token.access_token !== "string" ||
    !token.access_token
  ) {
    return null;
  }
  return { raw, token };
}

function resolveAgyOAuthClient(stored: { raw: Record<string, any>; token: Record<string, any> }): {
  clientId: string;
  clientSecret: string;
} | null {
  const localCfg = readJson<{ clientId?: string; clientSecret?: string }>(
    path.join(PASEO_HOME, "github-subscriptions", "agy-oauth.json"),
  );
  const clientId =
    process.env.AGY_OAUTH_CLIENT_ID ||
    stored.token.client_id ||
    stored.raw.client_id ||
    localCfg?.clientId ||
    "";
  const clientSecret =
    process.env.AGY_OAUTH_CLIENT_SECRET ||
    stored.token.client_secret ||
    stored.raw.client_secret ||
    localCfg?.clientSecret ||
    "";
  if (typeof clientId === "string" && clientId && typeof clientSecret === "string" && clientSecret) {
    return { clientId, clientSecret };
  }
  return null;
}

async function refreshAntigravityAccessToken(
  authPath: string,
  stored: { raw: Record<string, any>; token: Record<string, any> },
  proxyUrl?: string,
): Promise<string | null> {
  const refreshToken =
    typeof stored.token.refresh_token === "string" ? stored.token.refresh_token : "";
  if (!refreshToken) return null;
  const oauthClient = resolveAgyOAuthClient(stored);
  if (!oauthClient) return null;

  const body = new URLSearchParams({
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }).toString();

  const res = await smartFetch(AGY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    proxyUrl,
    sensitive: true,
  });
  if (!res.ok) return null;
  const refreshed = await res.json();
  if (typeof refreshed?.access_token !== "string" || !refreshed.access_token) return null;

  const expiresIn = Number(refreshed.expires_in) || 3600;
  const next: Record<string, any> = {
    ...stored.raw,
    token: {
      ...stored.token,
      access_token: refreshed.access_token,
      token_type: refreshed.token_type ?? stored.token.token_type ?? "Bearer",
      refresh_token:
        typeof refreshed.refresh_token === "string" && refreshed.refresh_token
          ? refreshed.refresh_token
          : stored.token.refresh_token,
      expiry: new Date(Date.now() + expiresIn * 1000).toISOString(),
      expires_in: expiresIn,
    },
  };
  if (typeof refreshed.id_token === "string") next.id_token = refreshed.id_token;
  try {
    writeJsonFile(authPath, next);
  } catch {
    // 写不回时本次仍可用新令牌；下一轮会再刷新。
  }
  return refreshed.access_token;
}

async function fetchAntigravityUsage(input: AccountInput): Promise<UsageReport> {
  if (!input.authPath) {
    return { status: "error", error: "Missing antigravity-oauth-token path" };
  }
  const stored = readAntigravityTokenFile(input.authPath);
  if (!stored) {
    return { status: "error", error: "Missing or invalid antigravity-oauth-token" };
  }

  const nowMs = Date.now();
  let accessToken = String(stored.token.access_token);
  const expiryMs = Date.parse(stored.token.expiry ?? "");
  if (!Number.isFinite(expiryMs) || expiryMs < nowMs + 60_000) {
    const refreshed = await refreshAntigravityAccessToken(
      input.authPath,
      stored,
      input.proxyUrl,
    ).catch(() => null);
    if (!refreshed) {
      return unavailable({
        kind: "expired",
        expiresAt: Number.isFinite(expiryMs)
          ? new Date(expiryMs).toISOString()
          : new Date(nowMs).toISOString(),
        refreshedBy: "agy login",
      });
    }
    accessToken = refreshed;
  }

  const platform = process.platform === "win32" ? "windows" : process.platform;
  const callModels = (token: string) =>
    smartFetch(AGY_MODELS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `${AGY_MODELS_UA} ${platform}/${process.arch}`,
      },
      body: "{}",
      proxyUrl: input.proxyUrl,
    });

  let res = await callModels(accessToken);
  if (res.status === 401 || res.status === 403) {
    const refreshed = await refreshAntigravityAccessToken(
      input.authPath,
      stored,
      input.proxyUrl,
    ).catch(() => null);
    if (!refreshed) {
      return unavailable({ kind: "rejected", status: res.status, refreshedBy: "agy login" });
    }
    res = await callModels(refreshed);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return unavailable({ kind: "rejected", status: res.status, refreshedBy: "agy login" });
    }
    return { status: "error", error: `Antigravity HTTP ${res.status}` };
  }

  const data = await res.json();
  const models = (data?.models ?? {}) as Record<string, any>;
  const windows: UsageWindow[] = [];

  for (const family of AGY_FAMILIES) {
    let selected: { fraction: number; resetTime: string } | null = null;
    for (const [id, model] of Object.entries(models)) {
      if (!family.pattern.test(id)) continue;
      const fraction = Number(model?.quotaInfo?.remainingFraction);
      const resetTime = model?.quotaInfo?.resetTime;
      if (!Number.isFinite(fraction) || typeof resetTime !== "string" || !resetTime) continue;
      if (selected === null || fraction < selected.fraction) {
        selected = { fraction, resetTime };
      }
    }
    if (!selected) continue;
    const end = Date.parse(selected.resetTime);
    const until = Number.isFinite(end) ? end - nowMs : 5 * HOUR_MS;
    const is5h = until <= 5 * HOUR_MS + AGY_5H_SKEW_MS;
    const periodLabel = is5h ? "5-hour" : "Weekly";
    const shortPeriod = is5h ? "5h" : "7d";
    const usedPct = (1 - Math.max(0, Math.min(1, selected.fraction))) * 100;

    windows.push(
      makeWindow({
        id: `${family.id}_${is5h ? "5_hours" : "7_days"}`,
        label: `${family.label} (${periodLabel})`,
        shortLabel: `${family.shortLabel} ${shortPeriod}`,
        summary: true,
        usedPct,
        resetsAt: selected.resetTime,
      }),
    );
  }

  const details: UsageDetail[] = [
    { id: "provider_id", label: "Provider ID", value: input.providerId },
  ];
  if (input.email) {
    details.push({ id: "email", label: "Account Email", value: input.email });
  }

  return {
    status: "available",
    planLabel: "Google AI Pro",
    windows: pinLowestRemainingWindow(windows),
    balances: [],
    details,
  };
}

// ============================================================================
// 2. Codex Multi-Account Usage Source
// ============================================================================

function discoverCodexAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
    const isCodex =
      providerId === "codex" ||
      providerId.startsWith("codex-") ||
      cfg?.extends === "codex";
    if (!isCodex) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const codexHome =
      (scope.kind === "session" ? scope.env?.CODEX_HOME : undefined) ||
      cfg?.env?.CODEX_HOME ||
      path.join(REAL_HOME, ".codex");
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
        proxyUrl: cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY,
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
  const creditBalance = Number(data?.credits?.balance);
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

// ============================================================================
// 3. Cursor CLI Usage Source
// ============================================================================

function discoverCursorAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
    const cmdParts = commandArray(cfg?.command);
    const isCursor =
      providerId === "cursor" ||
      providerId.startsWith("cursor-") ||
      cmdParts.some((part) => /(?:^|\/)cursor-agent/u.test(part));
    if (!isCursor) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const rawHome =
      (scope.kind === "session" ? scope.env?.HOME : undefined) ||
      cfg?.env?.HOME ||
      REAL_HOME;
    const homeDir = rawHome.trim().replace(/^~(?=$|\/)/u, REAL_HOME);
    const candidates = [
      path.join(homeDir, ".cursor", "auth.json"),
      path.join(homeDir, ".config", "cursor", "auth.json"),
    ];
    const authPath = candidates.find((p) => fs.existsSync(p));
    if (!authPath) continue;

    const labelEmail = cfg?.label?.match(/([\w.+-]+@[\w.-]+)/u)?.[1];
    const displayLabel = labelEmail
      ? `${labelEmail} (${providerId})`
      : cfg?.label || providerId;

    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "Cursor CLI",
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

async function fetchCursorUsage(input: AccountInput): Promise<UsageReport> {
  if (!input.authPath || !fs.existsSync(input.authPath)) {
    return { status: "error", error: "Missing Cursor auth.json" };
  }
  const auth = readJson<Record<string, any>>(input.authPath);
  if (!auth?.accessToken) {
    return { status: "error", error: "Missing Cursor accessToken" };
  }

  let accessToken = String(auth.accessToken);
  const claims = decodeJwtPayload(accessToken);
  if (claims?.exp && claims.exp * 1000 <= Date.now() + 300_000 && auth.refreshToken) {
    const refreshRes = await smartFetch("https://api2.cursor.sh/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CURSOR_CLIENT_ID,
        refresh_token: auth.refreshToken,
      }),
      proxyUrl: input.proxyUrl,
      sensitive: true,
    });
    if (refreshRes.ok) {
      const refreshed = await refreshRes.json();
      if (refreshed?.access_token) {
        accessToken = String(refreshed.access_token);
        try {
          // 刷新响应带新的刷新令牌时必须一起保存，否则旧令牌下次失效。
          const refreshToken = typeof refreshed.refresh_token === "string" && refreshed.refresh_token ? refreshed.refresh_token : auth.refreshToken;
          writeJsonFile(input.authPath, { ...auth, accessToken, refreshToken });
        } catch {
          // 写不回时本次仍可用新令牌。
        }
      }
    }
  }

  const callService = (method: string) =>
    smartFetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      proxyUrl: input.proxyUrl,
    });

  const [usageRes, planRes] = await Promise.all([
    callService("GetCurrentPeriodUsage"),
    callService("GetPlanInfo"),
  ]);

  if (!usageRes.ok) {
    if (usageRes.status === 401 || usageRes.status === 403) {
      return unavailable({
        kind: "rejected",
        status: usageRes.status,
        refreshedBy: "cursor-agent login",
      });
    }
    return { status: "error", error: `Cursor HTTP ${usageRes.status}` };
  }

  const usage = await usageRes.json();
  const plan = planRes.ok ? await planRes.json().catch(() => null) : null;
  const planUsage = usage?.planUsage ?? {};
  const resetsAt = isoFromEpochMs(usage?.billingCycleEnd);

  const windows: UsageWindow[] = [];
  if (typeof planUsage.autoPercentUsed === "number") {
    windows.push(
      makeWindow({
        id: "auto_composer",
        label: "Auto + Composer",
        shortLabel: "Auto",
        summary: true,
        usedPct: planUsage.autoPercentUsed,
        resetsAt,
      }),
    );
  }
  if (typeof planUsage.apiPercentUsed === "number") {
    windows.push(
      makeWindow({
        id: "api",
        label: "API",
        shortLabel: "API",
        summary: true,
        usedPct: planUsage.apiPercentUsed,
        resetsAt,
      }),
    );
  }
  if (typeof planUsage.totalPercentUsed === "number") {
    windows.push(
      makeWindow({
        id: "included",
        label: "Included total",
        shortLabel: "Total",
        summary: false,
        usedPct: planUsage.totalPercentUsed,
        resetsAt,
      }),
    );
  }

  return {
    status: "available",
    planLabel: plan?.planInfo?.planName || undefined,
    windows: pinLowestRemainingWindow(windows),
    balances: [],
    details: [
      { id: "provider_id", label: "Provider ID", value: input.providerId },
      ...(input.email ? [{ id: "email", label: "Account Email", value: input.email }] : []),
    ],
  };
}

// ============================================================================
// 4. Grok Multi-Account Usage Source
// ============================================================================

function extractGrokToken(auth: unknown): string | null {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, any>;
  if (typeof record.access_token === "string" && record.access_token) {
    return record.access_token;
  }
  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  for (const [, value] of preferred.length > 0 ? preferred : entries) {
    if (value && typeof value === "object" && typeof value.key === "string" && value.key) {
      return value.key;
    }
  }
  return null;
}

function discoverGrokAccounts(scope: UsageScope): UsageAccount[] {
  const providers = readProvidersConfig();
  const accounts: UsageAccount[] = [];

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (cfg?.enabled === false) continue;
    const cmdParts = commandArray(cfg?.command);
    const isGrok =
      providerId === "grok" ||
      providerId.startsWith("grok-") ||
      cfg?.extends === "grok" ||
      cmdParts[0] === "grok";
    if (!isGrok) continue;
    if (scope.kind === "session" && scope.provider !== providerId) continue;

    const grokHome =
      (scope.kind === "session" ? scope.env?.GROK_HOME : undefined) ||
      cfg?.env?.GROK_HOME ||
      path.join(REAL_HOME, ".grok");
    const authPath = path.join(grokHome, "auth.json");
    if (!fs.existsSync(authPath)) continue;

    const auth = readJson<Record<string, any>>(authPath);
    const email =
      auth?.user_email || cfg?.label?.match(/([\w.+-]+@[\w.-]+)/u)?.[1];
    const displayLabel = email ? `${email} (${providerId})` : cfg?.label || providerId;

    accounts.push({
      key: providerId,
      label: displayLabel,
      harness: "Grok",
      input: {
        providerId,
        label: displayLabel,
        email,
        authPath,
        command: cmdParts.length > 0 ? cmdParts : ["grok", "agent", "stdio"],
        env: cfg?.env,
        proxyUrl: cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY,
      } satisfies AccountInput as Record<string, any>,
    });
  }
  return accounts;
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

function refreshGrokWithCli(command: string[], env: Record<string, string> = {}): Promise<void> {
  const [file, ...args] = command;
  if (!file) return Promise.resolve();
  return new Promise((resolve) => {
    const child = trackChild(spawn(file, args, {
      cwd: "/tmp",
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 30_000,
    }));
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.stdin.end(ACP_HANDSHAKE);
  });
}

async function fetchGrokUsage(input: AccountInput): Promise<UsageReport> {
  if (!input.authPath || !fs.existsSync(input.authPath)) {
    return { status: "error", error: "Missing Grok auth.json" };
  }
  let auth = readJson<Record<string, any>>(input.authPath);
  let token = extractGrokToken(auth);
  if (!token) {
    return { status: "error", error: "Missing Grok token in auth.json" };
  }

  const callBilling = (bearer: string) =>
    smartFetch(GROK_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "application/json",
      },
      proxyUrl: input.proxyUrl,
    });

  let res = await callBilling(token);
  if ((res.status === 401 || res.status === 403) && input.command?.length) {
    await refreshGrokWithCli(input.command, input.env);
    auth = readJson<Record<string, any>>(input.authPath);
    token = extractGrokToken(auth);
    if (token) {
      res = await callBilling(token);
    }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return unavailable({ kind: "rejected", status: res.status, refreshedBy: "grok login" });
    }
    return { status: "error", error: `Grok HTTP ${res.status}` };
  }

  const billing = await res.json();
  const subRes = await smartFetch(GROK_SUBSCRIPTION_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
    proxyUrl: input.proxyUrl,
  }).catch(() => null);
  const subData = subRes?.ok ? await subRes.json().catch(() => null) : null;

  const config = billing?.config ?? {};
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];

  const usedPct =
    typeof config.creditUsagePercent === "number"
      ? config.creditUsagePercent
      : config.currentPeriod
        ? 0
        : null;
  const resetsAt =
    typeof config.currentPeriod?.end === "string"
      ? new Date(Date.parse(config.currentPeriod.end)).toISOString()
      : null;

  if (usedPct !== null) {
    const isWeekly = String(config.currentPeriod?.type ?? "")
      .toUpperCase()
      .includes("WEEKLY");
    windows.push(
      makeWindow({
        id: isWeekly ? "weekly" : "monthly",
        label: isWeekly ? "Weekly credits" : "Monthly credits",
        shortLabel: isWeekly ? "7d" : "30d",
        summary: true,
        usedPct,
        resetsAt,
      }),
    );
  }

  const limit = config.monthlyLimit?.val;
  const used = config.used?.val;
  if (typeof limit === "number" && typeof used === "number") {
    const remaining = Math.max(0, limit - used);
    balances.push({
      id: "monthly_credits",
      label: "Monthly credits",
      used,
      remaining,
      limit,
      unit: "credits",
      resetsAt,
      tone: balanceToneFromRemaining(remaining),
    });
  }

  const tier =
    typeof subData?.subscriptionTier === "string" && subData.subscriptionTier
      ? subData.subscriptionTier
      : "Free";

  return {
    status: "available",
    planLabel: tier,
    windows: pinLowestRemainingWindow(windows),
    balances,
    details: [
      { id: "provider_id", label: "Provider ID", value: input.providerId },
      ...(input.email ? [{ id: "email", label: "Account Email", value: input.email }] : []),
    ],
  };
}

// ============================================================================
// 5. GLM Coding Plan Usage Source
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
// 6. Qoder Usage Source (via qodercli --sdk daemon protocol v2)
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
      id: "antigravity",
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
    {
      id: "cursor-cli",
      label: "Cursor",
      icon: "icons/cursor.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverCursorAccounts(scope),
      fetch: async (raw) => fetchCursorUsage(AccountInputSchema.parse(raw)),
    },
    {
      id: "grok-multi",
      label: "Grok",
      icon: "icons/grok.svg",
      input: AccountInputSchema,
      discover: async (scope) => discoverGrokAccounts(scope),
      fetch: async (raw) => fetchGrokUsage(AccountInputSchema.parse(raw)),
    },
  ];
}
