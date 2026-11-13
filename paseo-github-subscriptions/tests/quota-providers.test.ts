import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountLabels, bundledClaudeUsageInstalled, configDirProviders, discoverAccounts, isClaudeProvider } from "../server/modules/usage-claude-accounts/providers.ts";

const RELAY = "relay@" + "private" + "relay.appleid.example";

const home = mkdtempSync(join(tmpdir(), "claude-providers-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { providers: {
  claude: { label: "Claude" },
  "claude-2": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/u/.claude-2" } },
  "claude-off": { extends: "claude", enabled: false, env: { CLAUDE_CONFIG_DIR: "/u/.claude-3" } },
  zai: { extends: "claude", env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
  glm: { extends: "acp", env: { CLAUDE_CONFIG_DIR: "/u/.x" } },
} } }));

test("标准 claude 和继承 claude 的 Provider 都识别为 Claude", () => {
  const env = { PASEO_HOME: home };
  assert.equal(isClaudeProvider("claude", env), true);
  assert.equal(isClaudeProvider("claude-2", env), true);
  assert.equal(isClaudeProvider("zai", env), true);
  assert.equal(isClaudeProvider("glm", env), false);
  assert.equal(isClaudeProvider("codex", env), false);
  assert.equal(isClaudeProvider(undefined, env), false);
});

test("只选择继承 claude、设置了配置目录且未停用的 Provider", () => {
  assert.deepEqual([...configDirProviders({ PASEO_HOME: home }).keys()], ["claude-2"]);
});

test("配置文件不存在时返回空列表", () => {
  assert.equal(configDirProviders({ PASEO_HOME: "/nonexistent-paseo-home" }).size, 0);
  assert.equal(isClaudeProvider("claude", { PASEO_HOME: "/nonexistent-paseo-home" }), true);
});

const providers = () => new Map([
  ["claude-2", { CLAUDE_CONFIG_DIR: "/u/.claude-2" }],
  ["claude-3", { CLAUDE_CONFIG_DIR: "/u/.claude-3" }],
]);

test("全局范围列出每个配置目录的账号，并去掉重复账号", async () => {
  const dirs: string[] = [];
  const accounts = await discoverAccounts({ kind: "global" }, async (scope) => {
    assert.equal(scope.kind, "session");
    if (scope.kind === "session") dirs.push(scope.env.CLAUDE_CONFIG_DIR);
    return [{ key: "same", label: "a@example.com", input: { route: { store: "keychain" } } }];
  }, { providers, labels: () => ({}), env: { HOME: "/u", USER: "u" } });
  assert.deepEqual(dirs, ["/u/.claude-2", "/u/.claude-3"]);
  assert.equal(accounts.length, 1);
});

test("会话范围只读取该 Provider 的配置目录", async () => {
  const dirs: string[] = [];
  const discover = async (scope: Parameters<typeof discoverAccounts>[0]) => {
    if (scope.kind === "session") dirs.push(scope.env.CLAUDE_CONFIG_DIR);
    return [];
  };
  await discoverAccounts({ kind: "session", provider: "claude-3", env: { HOME: "/u" } }, discover, { providers, labels: () => ({}) });
  assert.deepEqual(dirs, ["/u/.claude-3"]);
});

test("基础 Claude Provider 按会话环境读取独立用户账号，并应用邮箱显示名称", async () => {
  const scopes: unknown[] = [];
  const env = { HOME: "/u", CLAUDE_CONFIG_DIR: "/Users/independent/.claude" };
  const accounts = await discoverAccounts({ kind: "session", provider: "claude", env }, async scope => {
    scopes.push(scope);
    return [{ key: "independent-account", label: RELAY, input: {} }];
  }, { providers, labels: () => ({ [RELAY]: "user@example.com（Apple 登录）" }) });
  assert.deepEqual(scopes, [{ kind: "session", provider: "claude", env }]);
  assert.equal(accounts[0]?.label, "user@example.com（Apple 登录）");
});

test("会话环境优先于已变更的 Provider 配置，且只发现一次", async () => {
  const scopes: unknown[] = [];
  const env = { HOME: "/u", CLAUDE_CONFIG_DIR: "/u/session-login" };
  await discoverAccounts({ kind: "session", provider: "claude-3", env }, async scope => {
    scopes.push(scope);
    return [];
  }, { providers, includeDefault: true });
  assert.deepEqual(scopes, [{ kind: "session", provider: "claude", env }]);
});

test("其他 Provider 不会读取 Claude 账号", async () => {
  let calls = 0;
  const accounts = await discoverAccounts({ kind: "session", provider: "codex", env: {} }, async () => {
    calls++;
    return [];
  }, { providers });
  assert.equal(calls, 0);
  assert.deepEqual(accounts, []);
});

test("没有自带额度插件时，同时报告默认账号，并使用显示名称", async () => {
  const seen: string[] = [];
  const accounts = await discoverAccounts({ kind: "global" }, async (scope) => {
    if (scope.kind === "global") { seen.push("default"); return [{ key: "a", label: RELAY, input: {} }]; }
    seen.push(scope.env.CLAUDE_CONFIG_DIR);
    return [{ key: "b", label: "b@example.com", input: {} }];
  }, {
    providers: () => new Map([["claude-2", { CLAUDE_CONFIG_DIR: "/u/.claude-2" }]]),
    labels: () => ({ [RELAY]: "real@example.com" }),
    includeDefault: true,
  });
  assert.deepEqual(seen, ["default", "/u/.claude-2"]);
  assert.deepEqual(accounts.map(a => a.label), ["real@example.com", "b@example.com"]);
});

test("没有自带额度插件时，会话范围先按会话环境读取", async () => {
  const scopes: string[] = [];
  await discoverAccounts({ kind: "session", provider: "claude", env: { HOME: "/u", CLAUDE_CONFIG_DIR: "/u/.claude-2" } }, async (scope) => {
    if (scope.kind === "session") scopes.push(`${scope.provider}:${scope.env.CLAUDE_CONFIG_DIR}`);
    return [];
  }, { providers, labels: () => ({}), includeDefault: true });
  assert.deepEqual(scopes, ["claude:/u/.claude-2"]);
});

test("账号显示名称文件不存在时返回空对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-labels-"));
  const file = join(dir, "labels.json");
  assert.deepEqual(accountLabels(file), {});
  writeFileSync(file, JSON.stringify({ "x@relay.example": "x@gmail.example", bad: 1 }));
  assert.deepEqual(accountLabels(file), { "x@relay.example": "x@gmail.example" });
});

test("按资源目录判断自带额度插件是否存在", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-resources-"));
  assert.equal(bundledClaudeUsageInstalled([undefined, dir]), false);
  mkdirSync(join(dir, "builtin-plugins", "claude-usage-source"), { recursive: true });
  assert.equal(bundledClaudeUsageInstalled([undefined, dir]), true);
});
