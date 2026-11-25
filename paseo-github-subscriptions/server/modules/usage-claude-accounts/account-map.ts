import { configDirProviders, defaultClaudeEnabled } from './providers.ts';
import type { UsageAccount, UsageScope } from '@getpaseo/plugin/server/usage';

export function providerEnvs(home: string): Map<string, Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && key !== 'CLAUDE_CONFIG_DIR') base[key] = value;
  const configEnv = { ...process.env, PASEO_HOME: home };
  const envs = new Map<string, Record<string, string>>();
  if (defaultClaudeEnabled(configEnv)) envs.set('claude', base);
  for (const [id, env] of configDirProviders(configEnv)) envs.set(id, { ...base, ...env });
  return envs;
}
export async function accountMap(home: string, discover: (scope: UsageScope) => Promise<UsageAccount[]>) {
  const result = new Map<string, string>();
  for (const [provider, env] of providerEnvs(home)) {
    try { const [account] = await discover({ kind: 'session', provider: 'claude', env }); if (account) result.set(provider, account.key); }
    catch { /* 无法识别的账号不参与决策。 */ }
  }
  return result;
}
