import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readIdentity } from './modules/usage-claude-accounts/continuity.ts';
import { readLabels } from './modules/usage-claude-accounts/labels-file.ts';
import { isAppleRelay } from './modules/usage-claude-accounts/accounts.ts';
import { hasAuthOverride } from './modules/usage-claude-accounts/renewal.ts';

export type BrowserLoginMethod = 'apple' | 'direct' | 'unknown';

export function browserAccountKey(email: string | undefined, method: BrowserLoginMethod | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || !method || method === 'unknown') return;
  return `${method}:${normalized}`;
}

export function adsPowerLoginMethod(record: Record<string, unknown>): BrowserLoginMethod {
  const methods = new Set<BrowserLoginMethod>();
  for (const tag of Array.isArray(record.fbcc_user_tag) ? record.fbcc_user_tag : []) {
    const name = typeof tag?.name === 'string' ? tag.name.replace(/\s/g, '') : '';
    if (/^Apple(?:登陆|登录)$/i.test(name)) methods.add('apple');
    if (/^(?:Google|邮箱)(?:登陆|登录)$/i.test(name)) methods.add('direct');
  }
  return methods.size === 1 ? [...methods][0]! : 'unknown';
}

function accountLabelKey(label: string, method?: BrowserLoginMethod): string | undefined {
  const emails = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (emails.length !== 1) return;
  return browserAccountKey(emails[0], method ?? (/Apple\s*登录/i.test(label) ? 'apple' : 'direct'));
}

export function registeredClaudeAccounts(home: string, labelsFile: string): ReadonlySet<string> {
  const accounts = new Set<string>();
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    const providers = { claude: {}, ...config.agents?.providers };
    const labels = readLabels(labelsFile);
    for (const [providerId, raw] of Object.entries(providers)) {
      const provider = raw as { extends?: string; enabled?: boolean; label?: string; env?: Record<string, string> };
      if (!provider || provider.enabled === false || (providerId !== 'claude' && provider.extends !== 'claude')) continue;
      if (hasAuthOverride(provider.env ?? {})) continue;
      const label = typeof provider.label === 'string' ? provider.label : '';
      const configDir = provider.env?.CLAUDE_CONFIG_DIR;
      if (providerId !== 'claude' && !configDir?.trim()) continue;
      const identity = readIdentity(configDir ? join(configDir, '.claude.json') : join(provider.env?.HOME || homedir(), '.claude.json'));
      let key: string | undefined;
      if (identity?.label) {
        const apple = isAppleRelay(identity.label) || /Apple\s*登录/i.test(label);
        key = apple
          ? accountLabelKey(labels[identity.label] ?? label, 'apple')
          : browserAccountKey(identity.label, 'direct');
      } else {
        key = accountLabelKey(label);
      }
      if (key) accounts.add(key);
    }
  } catch {}
  return accounts;
}
