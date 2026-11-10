/** Read shared Credits through a temporary same-account Ego browser session. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTokenHubCredits } from "./token-hub-quota.ts";

type Credits = ReturnType<typeof parseTokenHubCredits>;
/** Whitelisted credits with their observation time, or a machine-readable failure reason. */
export type TokenHubResult = { quota: Credits; observedAt: string; reason?: never } | { quota?: never; reason: string };
const cache = new Map<string, { until: number; result: Promise<TokenHubResult> }>();
const marker = "PASEO_TOKEN_HUB_QUOTA=";

function browserScript(employeeNo: string, spaceName: string): string {
  return `
let task;
let result;
try {
task = await taskSpace(${JSON.stringify(spaceName)});
const page = task.page("p1");
await page.goto("https://token-hub.alibaba-inc.com/bridge/usage/credits", { timeout: 4500, waitUntil: "domcontentloaded" });
result = await page.evaluate(async (expected) => {
  const fail = (reason) => ({ reason });
  if (location.origin !== "https://token-hub.alibaba-inc.com") return fail("browser_login_required");
  const account = window.__TOKEN_PORTAL_BRIDGE_USER_BOOTSTRAP__?.loginWorkNo;
  if (account == null || String(account) !== expected) return fail("browser_account_mismatch");
  async function request(route, options = {}) {
    const response = await fetch(route, { ...options, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(4000) });
    if (response.status === 429) throw new Error("rate_limited");
    if ([401, 403].includes(response.status)) throw new Error("browser_login_required");
    if (!response.ok) throw new Error("quota_request_failed");
    return response.json();
  }
  try {
    const meta = await request("/bridge/api/user/usage/analysis/meta?period=cycle&language=zh&groupPacks=true");
    const cycle = meta?.data?.cycle;
    if (meta?.errorCode !== 0 || !/^\\d{4}-\\d{2}-\\d{2}$/.test(cycle?.nextStartDate)) return fail("quota_response_invalid");
    const end = new Date(cycle.nextStartDate + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() - 1);
    const quota = await request("/bridge/api/user/usage/credits/quota", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateFrom: cycle.startDate, dateTo: end.toISOString().slice(0, 10) }),
    });
    if (!Array.isArray(quota?.data)) return fail("quota_response_invalid");
    return {
      meta: { errorCode: meta.errorCode, data: { zoneId: meta.data.zoneId, cycle: { startDate: cycle.startDate, nextStartDate: cycle.nextStartDate } } },
      credits: { errorCode: quota.errorCode, data: quota.data.map(row => ({
        quotaPolicyCount: row?.quotaPolicyCount, credits: row?.credits,
        quotaPolicy: { type: row?.quotaPolicy?.type, creditsQuota: row?.quotaPolicy?.creditsQuota },
      })) },
    };
  } catch (error) {
    return fail(["rate_limited", "browser_login_required"].includes(error?.message) ? error.message : "quota_request_failed");
  }
}, ${JSON.stringify(employeeNo)});
} catch (error) {
  result = { reason: "browser_unavailable" };
}
if (task) {
  try {
    const current = (await listTaskSpaces()).find(space => space.id === task.spaceId);
    if (!current || current.ownership !== "agent") result = { reason: "browser_control_lost" };
    else await task.finish({ keep: [] });
  } catch {
    result = { reason: "browser_cleanup_unconfirmed" };
  }
}
console.log(${JSON.stringify(marker)} + JSON.stringify(result));
`;
}

function runBrowser(cli: string, script: string, homeDir: string): Promise<unknown> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/key|secret|token|password/i.test(key)));
  env.HOME = homeDir;
  return new Promise((resolve) => {
    const child = execFile(cli, ["nodejs"], { env, timeout: 17_500, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ reason: error.killed ? "browser_cleanup_unconfirmed" : "browser_unavailable" });
      const records = `${stdout}\n${stderr}`.split("\n").filter(line => line.startsWith(marker));
      if (records.length !== 1) return resolve({ reason: "browser_unavailable" });
      try { resolve(JSON.parse(records[0]!.slice(marker.length))); }
      catch { resolve({ reason: "quota_response_invalid" }); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
  });
}

/**
 * Read shared Credits in a temporary task space. Cookies stay in the browser.
 * @param employeeNo - Identity from the Token Switch session, compared inside the page before requests.
 * @param homeDir - Token Switch owner's home, used to isolate identity and caches; the browser uses the daemon user's home.
 * @param paseoHome - Host config and persisted rate-limit directory.
 * @param nowMs - Current time for the five-minute cache and fifteen-minute HTTP 429 wait.
 * @returns Verified shared credits, or a reason without old quota values or authentication material.
 */
export async function readTokenHubCredits(employeeNo: string, homeDir: string, paseoHome: string, nowMs = Date.now()): Promise<TokenHubResult> {
  if (!employeeNo) return { reason: "identity_missing" };
  const configPath = path.join(paseoHome, "token-hub-browser.json");
  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    if (config.enabled === false) return { reason: "browser_disabled" };
    if (config.enabled !== undefined && config.enabled !== true) return { reason: "browser_config_invalid" };
    if (config.cliPath !== undefined && (typeof config.cliPath !== "string" || !path.isAbsolute(config.cliPath))) return { reason: "browser_config_invalid" };
    const browserHome = os.homedir();
    const defaultCli = path.join(browserHome, ".local", "bin", "ego-browser");
    const cli = config.cliPath ?? (existsSync(defaultCli) ? defaultCli : "ego-browser");
    const key = createHash("sha256").update(`${paseoHome}\0${homeDir}\0${employeeNo}\0${cli}`).digest("hex");
    const previous = cache.get(key);
    if (previous && previous.until > nowMs) {
      const result = await previous.result;
      if (!result.quota || Date.parse(result.quota.resetsAt) > nowMs) return result;
    }
    const pending = (async (): Promise<TokenHubResult> => {
      const cacheDir = path.join(paseoHome, "cache", "provider-quotas-usage-source");
      const cooldownPath = path.join(cacheDir, `token-hub-${createHash("sha256").update(`${homeDir}\0${employeeNo}`).digest("hex")}.json`);
      if (existsSync(cooldownPath)) {
        const until = JSON.parse(readFileSync(cooldownPath, "utf8")).retryAt;
        if (typeof until === "number" && until > nowMs) return { reason: "rate_limited" };
      }
      const startedAt = performance.now();
      const result = await runBrowser(cli, browserScript(employeeNo, `tokenhub-quota-${key}`), browserHome);
      if (!result || typeof result !== "object") return { reason: "quota_response_invalid" };
      if ("reason" in result) {
        const reason = typeof result.reason === "string" ? result.reason : "quota_response_invalid";
        if (reason === "rate_limited") {
          mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
          writeFileSync(cooldownPath, JSON.stringify({ retryAt: nowMs + Math.ceil(performance.now() - startedAt) + 15 * 60_000 }), { mode: 0o600 });
        }
        return { reason };
      }
      if (!("meta" in result) || !("credits" in result)) return { reason: "quota_response_invalid" };
      try { return { quota: parseTokenHubCredits(result.meta, result.credits, nowMs), observedAt: new Date(nowMs).toISOString() }; }
      catch { return { reason: "quota_response_invalid" }; }
    })().catch((): TokenHubResult => ({ reason: "browser_unavailable" }));
    cache.set(key, { until: nowMs + 5 * 60_000, result: pending });
    return pending;
  } catch {
    return { reason: "browser_config_invalid" };
  }
}
