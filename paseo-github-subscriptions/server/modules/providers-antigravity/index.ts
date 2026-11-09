import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import { runningTurns, type AgentRow } from '../../../scripts/deploy-lib.ts';
import {
  ANTIGRAVITY_ID_MESSAGE,
  ANTIGRAVITY_ID_PATTERN,
  antigravityAccountAdd,
  antigravityAccountToggle,
  antigravitySnapshot,
  type AntigravityAccountAddInput,
  type AntigravityAccountItem,
  type AntigravityAccountToggleInput,
  type AntigravitySnapshot,
} from '../../../shared/antigravity.ts';
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { backupConfigFile, backupFile, readJsonStrict, restoreFromBackup, verifyProviderEntry, writeJsonFile, writeProviderEntry } from '../../core/provider-config.ts';
import type { Module, Services } from '../types.ts';
import { createAntigravityProvider } from './provider.ts';

const ProviderIdSchema = z.string().regex(ANTIGRAVITY_ID_PATTERN, ANTIGRAVITY_ID_MESSAGE);

const RawAntigravityAccountSchema = z
  .object({
    id: ProviderIdSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    label: z.string().min(1),
    enabled: z.boolean().optional(),
    command: z.array(z.string().min(1)).nonempty().optional(),
    homeDir: z.string().min(1).optional(),
    proxy: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .refine(value => Boolean(value.id || value.providerId), {
    message: '账号必须提供 id 或 providerId',
  })
  .transform(value => {
    const providerId = (value.providerId ?? value.id)!;
    return {
      id: providerId,
      providerId,
      label: value.label,
      enabled: value.enabled ?? true,
      ...(value.command ? { command: value.command } : {}),
      ...(value.homeDir ? { homeDir: value.homeDir } : {}),
      ...(value.proxy ? { proxy: value.proxy } : {}),
      ...(value.description ? { description: value.description } : {}),
    };
  });

export type AntigravityAccountConfig = z.infer<typeof RawAntigravityAccountSchema>;

export const AntigravityConfigSchema = z
  .object({
    accounts: z.array(RawAntigravityAccountSchema).default([]),
  })
  .refine(
    value => {
      const seen = new Set<string>();
      for (const account of value.accounts) {
        if (seen.has(account.providerId)) return false;
        seen.add(account.providerId);
      }
      return true;
    },
    { message: 'accounts 中存在重复的 Provider ID' },
  );

export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;

const FALLBACK_CONFIG: AntigravityConfig = { accounts: [] };

interface PaseoProviderConfigEntry {
  enabled?: boolean;
  label?: string;
  command?: string[] | string;
  env?: Record<string, string>;
}

interface PaseoConfigFile {
  agents?: { providers?: Record<string, PaseoProviderConfigEntry> };
  [key: string]: unknown;
}

function normalizeCommand(cmd: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(cmd)) {
    const filtered = cmd.filter((part): part is string => typeof part === 'string' && part.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof cmd === 'string' && cmd.trim()) return [cmd.trim()];
  return undefined;
}

/**
 * 对应的旧 Antigravity 插件（`<providerId>-provider`）是否仍启用。读不到或无法解析 Paseo 配置时按“仍启用”处理，
 * 否则会重复注册 Provider ID，停掉整个 Provider 实例（含云端会话）。
 */
export function findLegacyAntigravityConflict(
  paseoHome: string,
  providerId: string,
): { legacyPluginId: string; reason: string } | null {
  const legacyPluginId = `${providerId}-provider`;
  const status = legacyPluginStatus(paseoHome, legacyPluginId);
  if (!status.enabled) return null;
  return { legacyPluginId, reason: `${status.problem ?? `旧插件 ${legacyPluginId} 仍启用`}，已跳过注册 ${providerId}` };
}

/**
 * “需要重载”不存内存标志，而由实际注册情况推出：模块启动时记下注册了哪些账号，
 * 之后配置里启用的账号集合变了就需要重载；Provider 实例重载（重新注册）后自动清除。
 */
const registeredAccounts = new WeakMap<Services, Set<string>>();
/** RPC 单独使用（没有模块注册）时的退路。 */
const touched = new WeakSet<Services>();
const lastErrors = new WeakMap<Services, string>();

async function countRunningAntigravitySessions(services: Services): Promise<number> {
  // 守护进程没连上时不等（连接最多等 60 秒）：后台触发连接，这次按 0 返回。
  const connection = services.daemon.current();
  if (!connection) { void services.daemon.ready().catch(() => {}); return 0; }
  try {
    const client = (connection as unknown as { client?: { fetchAgents?: (opts: unknown) => Promise<{ entries?: Array<{ agent: AgentRow }> }> } }).client;
    const page = await client?.fetchAgents?.({ filter: { includeArchived: false }, page: { limit: 200 }, timeout: 3_000 });
    return runningTurns((page?.entries ?? []).map(entry => entry.agent), ['antigravity', 'antigravity-*']).length;
  } catch { return 0; }
}

interface SnapshotData { enabled: boolean; accounts: AntigravityAccountItem[]; enabledIds: string[]; conflicts: string[]; configError: string | null }

function readSnapshotData(machinePath: string, paseoHome: string): SnapshotData {
  let rawMachine: Record<string, any> | null = null;
  let paseoConfig: PaseoConfigFile | null = null;
  let configError: string | null = null;
  try { rawMachine = readJsonStrict(machinePath); } catch (error) { configError = (error as Error).message.replace('，没有写入', ''); }
  try { paseoConfig = readJsonStrict(join(paseoHome, 'config.json')); } catch (error) { configError ??= (error as Error).message.replace('，没有写入', ''); }
  const modulesMap = rawMachine && typeof rawMachine.modules === 'object' && rawMachine.modules && !Array.isArray(rawMachine.modules) ? rawMachine.modules : {};
  let parsed: AntigravityConfig = FALLBACK_CONFIG;
  if (rawMachine && rawMachine.antigravity !== undefined) {
    const result = AntigravityConfigSchema.safeParse(rawMachine.antigravity);
    if (result.success) parsed = result.data;
    else configError ??= `machine.json 的 antigravity 配置无效：${result.error.issues.map(issue => issue.message).join('；')}`;
  }
  const providers = paseoConfig?.agents?.providers ?? {};
  const conflicts: string[] = [];
  const accounts = parsed.accounts.map(account => {
    const conflict = findLegacyAntigravityConflict(paseoHome, account.providerId);
    if (conflict) conflicts.push(conflict.reason);
    // 实际启动用的是 Paseo 配置里的 env.HOME；machine.json 的 homeDir 只在添加账号时写入 Paseo 配置，之后不影响启动。
    const homeDir = providers[account.providerId]?.env?.HOME ?? account.homeDir;
    return { providerId: account.providerId, label: account.label, enabled: account.enabled, ...(homeDir ? { homeDir } : {}) };
  });
  return { enabled: modulesMap['providers.antigravity'] === true, accounts, enabledIds: accounts.filter(account => account.enabled).map(account => account.providerId), conflicts, configError };
}

export interface AntigravityRpcOptions {
  server: PluginServerContext;
  machinePath: string;
  services: Services;
  /** 测试用：替换写文件。 */
  writeJson?: (path: string, data: unknown) => void;
}

const sameSet = (left: ReadonlySet<string>, right: readonly string[]) => left.size === right.length && right.every(id => left.has(id));

export function registerAntigravityRpcs(options: AntigravityRpcOptions): void {
  const { server, machinePath, services } = options;
  const writeJson = options.writeJson ?? writeJsonFile;
  const paseoConfigPath = join(services.home, 'config.json');

  const buildSnapshot = async (overrideError?: string | null): Promise<AntigravitySnapshot> => {
    const data = readSnapshotData(machinePath, services.home);
    const registered = registeredAccounts.get(services);
    return {
      enabled: data.enabled,
      accounts: data.accounts,
      runningSessionsCount: await countRunningAntigravitySessions(services),
      reloadRequired: registered ? !sameSet(registered, data.enabledIds) : touched.has(services),
      error: overrideError !== undefined ? overrideError : data.configError ?? (data.conflicts.length > 0 ? data.conflicts.join('；') : lastErrors.get(services) ?? null),
    };
  };
  const fail = (message: string) => { lastErrors.set(services, message); return buildSnapshot(message); };
  const ok = () => { lastErrors.delete(services); return buildSnapshot(null); };

  server.handle(antigravitySnapshot, async () => buildSnapshot());

  /** 启停：只发 { providers: { [id]: { enabled } } } 并检查返回；机器配置先备份，失败就恢复。 */
  server.handle(antigravityAccountToggle, async (input: AntigravityAccountToggleInput) => {
    let rawMachine: Record<string, any> | null;
    try { rawMachine = readJsonStrict(machinePath); } catch (error) { return fail((error as Error).message); }
    const accounts: Array<Record<string, unknown>> = Array.isArray(rawMachine?.antigravity?.accounts) ? [...rawMachine!.antigravity.accounts] : [];
    const index = accounts.findIndex(item => item && (item.providerId === input.providerId || item.id === input.providerId));
    if (!rawMachine || index === -1) return fail(`未找到账号 ${input.providerId}`);
    const original = JSON.stringify(rawMachine);
    let backup: string;
    try {
      backup = backupFile(machinePath);
      accounts[index] = { ...accounts[index], enabled: input.enabled };
      writeJson(machinePath, { ...rawMachine, antigravity: { ...rawMachine.antigravity, accounts } });
    } catch (error) { return fail(`无法保存 machine.json：${(error as Error).message}`); }
    try {
      const { client } = await services.daemon.ready();
      const result = await (client as unknown as { patchDaemonConfig(patch: unknown): Promise<{ config?: { providers?: Record<string, { enabled?: boolean }> } }> })
        .patchDaemonConfig({ providers: { [input.providerId]: { enabled: input.enabled } } });
      if (result?.config?.providers?.[input.providerId]?.enabled !== input.enabled) throw new Error('守护进程返回的启用状态与请求不一致');
    } catch (error) {
      try { restoreFromBackup(backup, machinePath); } catch { /* 恢复失败时备份仍在 */ }
      return fail(`启停没有生效：${(error as Error).message}。machine.json 已恢复（备份 ${backup}）`);
    }
    touched.add(services);
    return ok();
  });

  /**
   * 新增账号：Provider 的 command、env、label 不在 config.patch 支持范围内，直接写 Paseo 的 config.json。
   * 顺序：备份两处 → 写 config.json → 写 machine.json；第二处失败就用备份恢复第一处。生效需要重载。
   */
  server.handle(antigravityAccountAdd, async (input: AntigravityAccountAddInput) => {
    let rawMachine: Record<string, any> | null;
    let paseoConfig: PaseoConfigFile | null;
    try {
      rawMachine = readJsonStrict(machinePath) ?? { version: 1 };
      paseoConfig = readJsonStrict(paseoConfigPath);
    } catch (error) { return fail((error as Error).message); }
    if (!paseoConfig) return fail('Paseo 的 config.json 不存在，没有写入');
    const accounts: Array<Record<string, unknown>> = Array.isArray(rawMachine?.antigravity?.accounts) ? [...rawMachine!.antigravity.accounts] : [];
    if (accounts.some(item => item && (item.providerId === input.providerId || item.id === input.providerId))) return fail(`账号 ${input.providerId} 已存在`);

    const existing = paseoConfig.agents?.providers?.[input.providerId] ?? {};
    const env: Record<string, string> = { ...(existing.env ?? {}) };
    if (input.homeDir) env.HOME = input.homeDir;
    if (input.proxy) { env.HTTPS_PROXY = input.proxy; env.HTTP_PROXY = input.proxy; }
    const entry = { ...existing, enabled: true, label: input.label, command: input.command ?? normalizeCommand(existing.command) ?? ['agy'], ...(Object.keys(env).length > 0 ? { env } : {}) };
    const configBackup = backupConfigFile(services.home);
    try {
      if (readJsonStrict(machinePath)) backupFile(machinePath);
      writeProviderEntry(services.home, input.providerId, entry);
      verifyProviderEntry(services.home, input.providerId, entry, configBackup);
    } catch (error) {
      try { restoreFromBackup(configBackup, paseoConfigPath); } catch { /* 备份仍在 */ }
      return fail(`无法写入 Paseo 配置：${(error as Error).message}`);
    }
    try {
      accounts.push({ id: input.providerId, providerId: input.providerId, label: input.label, enabled: true, ...(input.command ? { command: input.command } : {}), ...(input.homeDir ? { homeDir: input.homeDir } : {}), ...(input.proxy ? { proxy: input.proxy } : {}) });
      writeJson(machinePath, { ...rawMachine, antigravity: { ...(rawMachine!.antigravity ?? {}), accounts } });
    } catch (error) {
      try { restoreFromBackup(configBackup, paseoConfigPath); } catch { /* 备份仍在 */ }
      return fail(`无法保存 machine.json：${(error as Error).message}。Paseo 的 config.json 已恢复（备份 ${configBackup}）`);
    }
    touched.add(services);
    return ok();
  });
}

/**
 * Antigravity 多账号 Provider 模块（在 Provider 实例或兼容模式运行）。
 * 按 machine.json 的 antigravity.accounts 列表注册 Provider，保持 antigravity-cy517、antigravity-beibeimao 等 ID 不变。
 */
export const antigravityModule: Module<AntigravityConfig> = {
  id: 'providers.antigravity',
  label: 'Antigravity 多账号',
  defaultEnabled: false,
  appliesTo: instance => instance.hostsProviders,
  config: { section: 'antigravity', spec: { schema: AntigravityConfigSchema, fallback: FALLBACK_CONFIG } },
  register(context) {
    const { server, config, machine, services } = context;
    registerAntigravityRpcs({ server, machinePath: machine.path, services });

    let providersMap: Record<string, PaseoProviderConfigEntry> = {};
    try { providersMap = (readJsonStrict(join(services.home, 'config.json')) as PaseoConfigFile | null)?.agents?.providers ?? {}; } catch { /* 下面的冲突检查会报告 */ }
    const conflicts: string[] = [];
    const registered = new Set<string>();

    for (const account of config.accounts) {
      if (!account.enabled) continue;
      const conflict = findLegacyAntigravityConflict(services.home, account.providerId);
      if (conflict) { conflicts.push(conflict.reason); continue; }
      const configuredCmd = account.command ?? normalizeCommand(providersMap[account.providerId]?.command);
      server.registerProvider(createAntigravityProvider({ providerId: account.providerId, label: account.label, command: configuredCmd, description: account.description }));
      registered.add(account.providerId);
    }
    registeredAccounts.set(services, registered);
    touched.delete(services);
    lastErrors.delete(services);

    if (conflicts.length > 0) {
      const message = conflicts.join('；');
      lastErrors.set(services, message);
      context.fail(new Error(message));
    }
  },
};
