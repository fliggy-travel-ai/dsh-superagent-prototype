import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_SESSION_PROVIDER_ID } from '../shared/cloud-session.ts';
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

export interface CloudProviderRef {
  id: string;
  label: string;
}

/** 启用的云端 Provider。模块关闭、配置里关掉、或配置读不到时都不算。没有单独配置时，模块仍会注册内置的 `cloud-session`。 */
export function enabledCloudProviders(home: string, moduleEnabled = true): CloudProviderRef[] {
  if (!moduleEnabled) return [];
  let providers: Record<string, { extends?: string; enabled?: boolean; label?: string } | undefined> = {};
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    providers = config.agents?.providers ?? {};
  } catch {
    return [];
  }
  const cloudLabel = (id: string, provider: { label?: string } | undefined) => {
    const label = typeof provider?.label === 'string' ? provider.label.trim() : '';
    return label || (id === CLOUD_SESSION_PROVIDER_ID ? '云端会话' : id);
  };
  const listed = Object.entries(providers).flatMap(([id, provider]) => {
    if (!provider || provider.enabled === false) return [];
    if (id !== CLOUD_SESSION_PROVIDER_ID && provider.extends !== CLOUD_SESSION_PROVIDER_ID) return [];
    return [{ id, label: cloudLabel(id, provider) }];
  });
  const mentioned = Object.entries(providers).some(([id, provider]) => id === CLOUD_SESSION_PROVIDER_ID || provider?.extends === CLOUD_SESSION_PROVIDER_ID);
  if (!mentioned) listed.unshift({ id: CLOUD_SESSION_PROVIDER_ID, label: '云端会话' });
  return listed;
}

interface CloudUsageRecord {
  instanceId: string;
  instanceName: string;
  adspowerName?: string;
  displayName?: string;
}

function singleEmail(value: string | undefined): string | undefined {
  const found = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return found.length === 1 ? found[0]!.toLowerCase() : undefined;
}

/** 一张额度卡对应一个云端 Provider。邮箱或名称对上才占用一条浏览器记录；只剩一个 Provider 和一个记录时配成一对。同一条记录不配给两个 Provider。 */
export function assignCloudUsageRecords<T extends CloudUsageRecord>(providers: readonly CloudProviderRef[], records: readonly T[]): Map<string, T> {
  const assigned = new Map<string, T>();
  const used = new Set<string>();
  const take = (providerId: string, record: T | undefined) => {
    if (!record || used.has(record.instanceId)) return;
    used.add(record.instanceId);
    assigned.set(providerId, record);
  };
  for (const provider of providers) {
    const wanted = singleEmail(provider.label);
    if (!wanted) continue;
    take(provider.id, records.find(record => !used.has(record.instanceId) && [record.adspowerName, record.displayName, record.instanceName].some(value => singleEmail(value) === wanted)));
  }
  for (const provider of providers) {
    if (assigned.has(provider.id)) continue;
    take(provider.id, records.find(record => !used.has(record.instanceId) && (record.displayName === provider.label || record.instanceName === provider.label)));
  }
  const openProviders = providers.filter(provider => !assigned.has(provider.id));
  const openRecords = records.filter(record => !used.has(record.instanceId));
  if (openProviders.length === 1 && openRecords.length === 1) take(openProviders[0]!.id, openRecords[0]);
  return assigned;
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
