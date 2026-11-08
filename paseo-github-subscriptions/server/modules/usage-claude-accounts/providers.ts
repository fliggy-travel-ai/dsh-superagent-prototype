import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageAccount, UsageScope } from "@getpaseo/plugin/server/usage";

type Env = Record<string, string>;
type ProviderConfig = { extends?: unknown; enabled?: unknown; env?: Record<string, unknown> };
type Discover = (scope: UsageScope) => Promise<UsageAccount[]>;

function stringEnv(env: Record<string, unknown> | undefined): Env {
  const result: Env = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function paseoHome(env: NodeJS.ProcessEnv): string {
  return env.PASEO_HOME || join(env.HOME || homedir(), ".paseo");
}

function readProviders(env: NodeJS.ProcessEnv): Record<string, ProviderConfig> {
  try {
    const config = JSON.parse(readFileSync(join(paseoHome(env), "config.json"), "utf8"));
    return config?.agents?.providers ?? {};
  } catch (error) {
    console.warn("无法读取 Paseo 配置：", String(error));
    return {};
  }
}

/** The standard claude provider, or a config.json provider that extends it. */
export function isClaudeProvider(id: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!id) return false;
  return id === "claude" || readProviders(env)[id]?.extends === "claude";
}

/**
 * Providers in config.json that extend claude and set CLAUDE_CONFIG_DIR, keyed by provider ID.
 * The bundled claude usage source reads only the default login, so these logins need this source.
 */
export function configDirProviders(env: NodeJS.ProcessEnv = process.env): Map<string, Env> {
  const result = new Map<string, Env>();
  for (const [id, provider] of Object.entries(readProviders(env))) {
    if (provider?.extends !== "claude" || provider.enabled === false) continue;
    const providerEnv = stringEnv(provider.env);
    if (!providerEnv.CLAUDE_CONFIG_DIR?.trim()) continue;
    result.set(id, providerEnv);
  }
  return result;
}

/**
 * Paseo's bundled claude-usage-source is always loaded while its directory exists in the app.
 * Renaming that directory is the only way to turn it off; this source then reports every login.
 */
export function bundledClaudeUsageInstalled(
  resourceDirs: (string | undefined)[] = [
    (process as { resourcesPath?: string }).resourcesPath,
    "/Applications/Paseo.app/Contents/Resources",
  ],
): boolean {
  return resourceDirs.some(
    (dir) => !!dir && existsSync(join(dir, "builtin-plugins", "claude-usage-source")),
  );
}

/**
 * Display names keyed by the email that Anthropic reports, e.g. an Apple relay address.
 * The file is the plugin's `labels.json`; its path comes from the module, not from a fixed location.
 */
export function accountLabels(labelsFile: string): Record<string, string> {
  try {
    return stringEnv(JSON.parse(readFileSync(labelsFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("无法读取账号显示名称：", String(error));
    return {};
  }
}

export interface DiscoverDeps {
  providers?: () => Map<string, Env>;
  /** Required in production: reads the plugin's labels.json. */
  labels?: () => Record<string, string>;
  env?: NodeJS.ProcessEnv;
  /** Also report the default login (and Pi/OMP Anthropic logins), as the bundled source does. */
  includeDefault?: boolean;
}

/**
 * Global scope lists every extra login once; session scope lists the login of that provider.
 * With includeDefault, the scope itself is also passed to the bundled discovery logic.
 */
export async function discoverAccounts(
  scope: UsageScope,
  discover: Discover,
  deps: DiscoverDeps = {},
): Promise<UsageAccount[]> {
  const providers = (deps.providers ?? configDirProviders)();
  const labels: Record<string, string> = (deps.labels ?? (() => ({})))();
  const baseEnv = scope.kind === "session" ? scope.env : stringEnv(deps.env ?? process.env);
  const selected =
    scope.kind === "global"
      ? [...providers.values()]
      : providers.has(scope.provider)
        ? [providers.get(scope.provider)!]
        : [];
  const scopes: UsageScope[] = deps.includeDefault ? [scope] : [];
  for (const providerEnv of selected) {
    scopes.push({
      kind: "session",
      provider: "claude",
      ...(scope.kind === "session" && scope.model ? { model: scope.model } : {}),
      env: { ...baseEnv, ...providerEnv },
    });
  }
  const accounts: UsageAccount[] = [];
  const seen = new Set<string>();
  // Independent accounts must not add up to a long timeout during a network outage.
  for (const discovered of await Promise.all(scopes.map(next => discover(next)))) {
    for (const account of discovered) {
      if (seen.has(account.key)) continue;
      seen.add(account.key);
      const label = account.label && labels[account.label];
      accounts.push(label ? { ...account, label } : account);
    }
  }
  return accounts;
}
