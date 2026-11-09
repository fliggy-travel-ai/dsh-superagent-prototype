import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as nodeModule from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CombinedUsageInput, ContinuityInput } from "../shared/continuity-input.ts";
import { routeKey } from "../server/modules/usage-claude-accounts/continuity.ts";

// Production uses Paseo's bundler. For Node's type stripping, resolve the copied upstream .js imports to .ts.
const pluginRoot = new URL("../", import.meta.url).href;
// Node 22.15+ supplies registerHooks; the plugin intentionally retains the host's Node 20 type definitions.
type ResolveContext = { parentURL?: string };
const { registerHooks } = nodeModule as unknown as { registerHooks(options: {
  resolve: (specifier: string, context: ResolveContext, next: (specifier: string, context: ResolveContext) => unknown) => unknown;
}): { deregister(): void } };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith(pluginRoot)) {
    const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
  }
  return nextResolve(specifier, context);
} });
const { ContinuousUsage } = await import("../server/modules/usage-claude-accounts/continuous-usage.ts");
hooks.deregister();

test("独立用户从缓存读取额度时仍统计本账号未关闭会话，关闭后归零且错误保持错误", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-cross-user-sessions-"));
  const oldHome = process.env.PASEO_HOME; process.env.PASEO_HOME = root;
  const configDir = join(root, "isolated-claude");
  const stateDir = join(root, "claude-quota-resume"); mkdirSync(stateDir);
  const agentsDir = join(root, "agents"); mkdirSync(agentsDir);
  const cachePath = join(stateDir, "cross-user-cache.json");
  const input: CombinedUsageInput = { route: { store: "cross-user", configDir }, accountKey: "isolated.account" };
  writeFileSync(join(root, "config.json"), JSON.stringify({ agents: { providers: {
    "claude-isolated": { extends: "claude", env: { CLAUDE_CONFIG_DIR: configDir } },
    "claude-other": { extends: "claude", env: { CLAUDE_CONFIG_DIR: join(root, "other") } },
  } } }));
  // No query program may run: this test uses only a persisted quota reply and local session files.
  writeFileSync(join(stateDir, "cross-user-providers.json"), JSON.stringify({
    [configDir]: { command: "/does-not-exist/no-account-request", args: [] },
  }));
  const reply = { version: 1, account: { key: input.accountKey, label: "isolated@example.invalid" }, plan: "Pro",
    windows: [{ id: "five_hour", label: "Session", shortLabel: "5h", summary: true, utilization: 12, resetsAt: null }] };
  const saveCache = (error?: string) => writeFileSync(cachePath, JSON.stringify({
    [configDir]: { until: Date.now() + 300_000, reply: { ...reply, ...(error ? { error, windows: [] } : {}) } },
  }));
  const session = { id: "open", provider: "claude-isolated/claude-opus", lastStatus: "idle" };
  for (const a of [session, { id: "closed", provider: "claude-isolated", lastStatus: "closed" },
    { id: "idle-child", provider: "claude-isolated", lastStatus: "idle", labels: { "paseo.parent-agent-id": "codex-parent" } },
    { id: "archived", provider: "claude-isolated", lastStatus: "idle", archivedAt: "2026-01-01" },
    { id: "other", provider: "claude-other", lastStatus: "running" }]) {
    writeFileSync(join(agentsDir, a.id + ".json"), JSON.stringify(a));
  }
  try {
    saveCache();
    const service = new ContinuousUsage();
    const report = await service.fetch(input);
    assert.equal(report.status, "available");
    if (report.status !== "available") assert.fail("cached quota must remain available");
    assert.deepEqual(report.details, [{ id: "active_sessions", label: "未关闭会话（不含空闲子会话）", value: "1" }]);
    assert.equal(report.windows[0].remainingPct, 88);
    assert.equal((await service.fetch({ ...input, accountKey: "different.account" })).status, "error");
    writeFileSync(join(agentsDir, "open.json"), JSON.stringify({ ...session, lastStatus: "closed", requiresAttention: true }));
    const closed = await new ContinuousUsage().fetch(input);
    assert.equal(closed.status, "available");
    if (closed.status === "available") assert.equal(closed.details?.[0].value, "0");
    saveCache("network");
    const failed = await new ContinuousUsage().fetch(input);
    assert.equal(failed.status, "error");
    assert.equal("details" in failed, false);
  } finally {
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("真实适配层：过期保留身份，错误不变成功，旧会话不能读取新账号额度", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-adapter-test-"));
  const config = join(root, "claude"); mkdirSync(config);
  const oldHome = process.env.PASEO_HOME; process.env.PASEO_HOME = root;
  const oldFetch = globalThis.fetch;
  let offline = false;
  const scope = { kind: "session" as const, provider: "claude", env: { HOME: root, USER: "quota-test", CLAUDE_CONFIG_DIR: config } };
  function login(account: string, expired = false) {
    writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `fake-${account}`, refreshToken: "fake-refresh", expiresAt: Date.now() + (expired ? -1 : 3600_000),
    } }), { mode: 0o600 });
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ oauthAccount: {
      accountUuid: `account-${account}`, organizationUuid: "org-test", emailAddress: `${account}@example.invalid`,
    } }));
  }
  globalThis.fetch = async (url, init) => {
    if (offline) throw new Error("fake network failure; must not escape into user-visible messages");
    const token = new Headers(init?.headers).get("Authorization") ?? "";
    const account = token.endsWith("fake-b") ? "b" : "a";
    if (String(url).endsWith("/profile")) return new Response(JSON.stringify({ account: { uuid: `account-${account}`, email: `${account}@example.invalid` }, organization: { uuid: "org-test" } }));
    assert.ok(String(url).endsWith("/usage"));
    return new Response(JSON.stringify({ five_hour: { utilization: account === "a" ? 10 : 80, resets_at: new Date(Date.now() + 3600_000).toISOString() } }));
  };
  try {
    const service = new ContinuousUsage(); login("a");
    const [first] = await service.discover(scope);
    assert.equal(first.key, "account-a.org-test");
    const input = first.input as ContinuityInput;
    assert.equal((await service.fetch(input)).status, "available");
    assert.equal((await service.fetch({ ...input, accountKey: routeKey(input) })).status, "error");
    const saved = readFileSync(join(root, "claude-quota-resume", "usage-history.json"), "utf8");
    assert.equal(saved.includes("@example.invalid"), false); assert.equal(saved.includes("fake-"), false);
    login("a", true);
    const [expired] = await service.discover(scope);
    assert.equal(expired.key, first.key); assert.equal(expired.label, first.label);
    const failure = await service.fetch(expired.input as ContinuityInput);
    assert.equal(failure.status, "unavailable");
    if (failure.status === "unavailable") assert.equal(failure.problem.kind, "expired");
    assert.equal(service.history.cached(first.key)?.report.windows[0].remainingPct, 90);
    const reloaded = new ContinuousUsage();
    const [restored] = await reloaded.discover(scope);
    const historical = await reloaded.fetch(restored.input as ContinuityInput);
    assert.equal(historical.status, "unavailable");
    if (historical.status === "unavailable" && historical.problem.kind === "no_quota") {
      assert.ok(historical.problem.detail.includes("剩余 90%"));
      assert.ok(historical.problem.detail.includes("历史记录不代表当前可用额度"));
    } else assert.fail("重载后需要显示历史百分比和更新时间");
    await reloaded.stop();
    login("b");
    assert.equal((await service.fetch(input)).status, "error");
    const [second] = await service.discover(scope);
    assert.equal(second.key, "account-b.org-test");
    assert.equal((await service.fetch(second.input as ContinuityInput)).status, "available");
    assert.equal((await service.fetch(input)).status, "error");
    offline = true;
    const network = await service.fetch(second.input as ContinuityInput);
    assert.equal(network.status, "error");
    if (network.status === "error") assert.ok(!network.error.includes("must not escape"));
    await service.stop();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
