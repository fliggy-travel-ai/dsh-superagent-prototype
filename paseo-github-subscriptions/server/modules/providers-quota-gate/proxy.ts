import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { allocationHint, type AccountQuota } from './rules.ts';

const upstreamIds = new Set(['antigravity', 'codex', 'cursor', 'deepseek', 'grok', 'mimo-app', 'openai', 'workbuddy', 'zcode']);
const quotaResponse = z.object({ data: z.array(z.unknown()) });
const accountSchema = z.object({
  provider: z.string(),
  windows: z.array(z.unknown()).optional(),
  balance: z.string().nullish(),
});
const windowSchema = z.object({ name: z.string().optional(), used: z.union([z.number(), z.string()]).nullish(), remaining: z.union([z.number(), z.string()]).nullish() });

function localQuotaUrl(base: string | undefined): string | undefined {
  if (!base) return;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    const path = url.pathname.replace(/\/v1(?:\/.*)?$/, '').replace(/\/+$/, '');
    return `${url.origin}${path}/v1/magpie/quotas`;
  } catch {
    return undefined;
  }
}

function readJson(path: string) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function codexBaseUrl(directory: string): string | undefined {
  let text: string;
  try { text = readFileSync(join(directory, 'config.toml'), 'utf8'); } catch { return; }
  const [root, ...sections] = text.split(/^\s*(?=\[)/m);
  const value = (source: string, key: string) => source.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1];
  const provider = value(root ?? '', 'model_provider');
  const selected = provider && sections.find(section => section.split('\n', 1)[0]?.trim() === `[model_providers.${provider}]`);
  return (selected ? value(selected, 'base_url') : undefined) ?? value(root ?? '', 'openai_base_url');
}

export function proxyQuotaUrl(kind: string, env: NodeJS.ProcessEnv, home: string): string | undefined {
  const explicit = env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || env.MAGPIE_URL;
  if (explicit) return localQuotaUrl(explicit);
  const resolveHome = (path: string) => path.replace(/^~(?=\/|$)/, home);
  const userHome = resolveHome(env.HOME || home);
  if (kind === 'codex') return localQuotaUrl(codexBaseUrl(resolveHome(env.CODEX_HOME || join(userHome, '.codex'))));
  if (kind === 'claude') {
    const settings = readJson(join(resolveHome(env.CLAUDE_CONFIG_DIR || join(userHome, '.claude')), 'settings.json'));
    return localQuotaUrl(settings?.env?.ANTHROPIC_BASE_URL);
  }
  if (kind === 'pi') {
    const directory = resolveHome(env.PI_CODING_AGENT_DIR || join(userHome, '.pi', 'agent'));
    const settings = readJson(join(directory, 'settings.json'));
    const providers = z.record(z.string(), z.object({ baseUrl: z.string().optional() })).safeParse(readJson(join(directory, 'models.json'))?.providers);
    if (providers.success) {
      const selected = providers.data[settings?.defaultProvider] ?? Object.values(providers.data).find(provider => provider.baseUrl);
      return localQuotaUrl(selected?.baseUrl);
    }
  }
}

type ProxyReport = { data: unknown[] } | { error: string };

export async function readProxyQuotas(url: string, signal: AbortSignal, fetchImpl = fetch): Promise<ProxyReport | undefined> {
  try {
    const response = await fetchImpl(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const parsed = quotaResponse.safeParse(await response.json().catch(() => null));
    if (parsed.success) return parsed.data;
  } catch {
    return { error: '代理上游额度查询失败（upstream.error）' };
  }
}

function number(value: number | string | null | undefined): number | undefined {
  if (value == null || value === '') return;
  const result = typeof value === 'number' ? value : Number(value.trim().replace(/%$/, ''));
  if (Number.isFinite(result)) return result;
}

export function proxyAccount(report: ProxyReport, provider: string, kind: string): AccountQuota {
  if ('error' in report) return { upstream: { error: report.error } };
  const family = new Set([provider, kind].filter(id => upstreamIds.has(id)));
  const hints = report.data.flatMap(row => {
    const parsed = accountSchema.safeParse(row);
    if (!parsed.success || (family.size > 0 && !family.has(parsed.data.provider))) return [];
    const account = parsed.data;
    const windows = (account.windows ?? []).flatMap(rawWindow => {
      const window = windowSchema.safeParse(rawWindow);
      if (!window.success || window.data.name?.trim().toLowerCase() === 'total') return [];
      const used = number(window.data.used);
      const remaining = number(window.data.remaining) ?? (used === undefined ? undefined : 100 - used);
      return remaining === undefined ? [] : [{ id: 'upstream', remainingPct: remaining }];
    });
    const amount = account.balance?.trim().match(/^(-?\d+(?:\.\d+)?)\s+\S.*$/)?.[1]
      ?? account.balance?.trim().match(/^[^\d\s]{1,3}\s*(-?\d+(?:\.\d+)?)$/)?.[1];
    return [allocationHint(windows, account.provider === 'cursor', Number(amount) > 0)];
  });
  return { allocationHint: hints.includes('normal') ? 'normal' : hints.length > 0 && hints.every(hint => hint === 'avoid') ? 'avoid' : 'unknown' };
}
