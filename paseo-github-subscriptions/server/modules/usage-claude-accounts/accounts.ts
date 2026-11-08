import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeAccountsSnapshot } from '../../../shared/claude-accounts.ts';
import type { Quota } from './labels.ts';

export const APPLE_SUFFIX = '（Apple 登录）';
const APPLE_RELAY = new RegExp('@private' + 'relay\\.appleid\\.[a-z]+$', 'i');
/** Apple 登录时 Anthropic 只知道 Apple 的隐藏邮箱。 */
export const isAppleRelay = (email: string) => APPLE_RELAY.test(email);

type Account = ClaudeAccountsSnapshot['accounts'][number];
type ProviderConfig = { extends?: unknown; enabled?: unknown; label?: unknown; env?: Record<string, unknown> };

export interface AccountsDeps {
  home: string;
  /** 用户目录，配置目录显示时缩写成 ~。 */
  homeDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
  labels(): Record<string, string>;
  quotas: ReadonlyMap<string, Quota | null>;
  needsLogin(env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Anthropic 报告的邮箱（Apple 登录是隐藏邮箱）。 */
  identityEmail(env: NodeJS.ProcessEnv): string | null;
}

const stringEnv = (env: Record<string, unknown> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** 本机启用的 Claude Provider：默认的 `claude`，加上继承它并设置了 CLAUDE_CONFIG_DIR 的 Provider。 */
export async function listAccounts(deps: AccountsDeps): Promise<Account[]> {
  let providers: Record<string, ProviderConfig> = {};
  try { providers = JSON.parse(readFileSync(join(deps.home, 'config.json'), 'utf8'))?.agents?.providers ?? {}; } catch { /* 读不到时只列默认账号 */ }
  const base = { ...deps.baseEnv }; delete base.CLAUDE_CONFIG_DIR;
  const labels = deps.labels();
  const entries: Array<[string, ProviderConfig, string | undefined]> = [['claude', providers.claude ?? {}, undefined]];
  for (const [id, provider] of Object.entries(providers)) {
    if (id === 'claude' || provider?.extends !== 'claude') continue;
    const dir = stringEnv(provider.env).CLAUDE_CONFIG_DIR?.trim();
    if (dir) entries.push([id, provider, dir]);
  }
  const accounts: Account[] = [];
  for (const [id, provider, dir] of entries) {
    if (provider.enabled === false) continue;
    const env = { ...base, ...stringEnv(provider.env) };
    const raw = deps.identityEmail(env);
    const named = raw ? labels[raw] : undefined;
    const apple = !!raw && (isAppleRelay(raw) || !!named?.endsWith(APPLE_SUFFIX));
    const shown = raw ? (named ? named.replace(APPLE_SUFFIX, '') : raw) : null;
    const display = dir ? (dir.startsWith(deps.homeDirectory + '/') ? `~${dir.slice(deps.homeDirectory.length)}` : dir) : '~/.claude';
    accounts.push({
      providerId: id, label: typeof provider.label === 'string' ? provider.label : id === 'claude' ? 'Claude' : id,
      email: shown, appleLogin: apple, configDir: display,
      needsRelogin: await deps.needsLogin(env).catch(() => false),
      remainingPct: deps.quotas.get(id)?.remainingPct ?? null,
    });
  }
  return accounts;
}
