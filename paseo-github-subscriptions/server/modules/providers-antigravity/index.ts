import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import { runningTurns, type AgentRow } from '../../../scripts/deploy-lib.ts';
import {
  antigravityAccountAdd,
  antigravityAccountToggle,
  antigravitySnapshot,
  type AntigravityAccountAddInput,
  type AntigravityAccountItem,
  type AntigravityAccountToggleInput,
  type AntigravitySnapshot,
} from '../../../shared/antigravity.ts';
import type { Module, Services } from '../types.ts';
import { createAntigravityProvider } from './provider.ts';

const RawAntigravityAccountSchema = z
  .object({
    id: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
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
  plugins?: Record<string, { enabled?: boolean; source?: string; path?: string }>;
  agents?: {
    providers?: Record<string, PaseoProviderConfigEntry>;
  };
  [key: string]: unknown;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
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
 * 检查 ~/.paseo/config.json 中对应的旧 Antigravity 插件是否仍处于启用状态。
 * 例如 providerId 为 antigravity-cy517 时，对应旧插件 ID 为 antigravity-cy517-provider。
 */
export function findLegacyAntigravityConflict(
  paseoHome: string,
  providerId: string,
): { legacyPluginId: string; reason: string } | null {
  const config = readJsonFile<PaseoConfigFile>(join(paseoHome, 'config.json'));
  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  const legacyPluginId = `${providerId}-provider`;
  const entry = plugins[legacyPluginId];
  if (entry && typeof entry === 'object' && entry.enabled !== false) {
    return {
      legacyPluginId,
      reason: `旧插件 ${legacyPluginId} 仍启用，已跳过注册 ${providerId}`,
    };
  }
  return null;
}

interface AntigravityRuntimeState {
  reloadRequired: boolean;
  lastError: string | null;
}

const runtimeStates = new WeakMap<Services, AntigravityRuntimeState>();
const registeredServices = new WeakSet<Services>();

function getRuntimeState(services: Services): AntigravityRuntimeState {
  let state = runtimeStates.get(services);
  if (!state) {
    state = { reloadRequired: false, lastError: null };
    runtimeStates.set(services, state);
  }
  return state;
}

async function countRunningAntigravitySessions(
  services: Services,
  rpcContext?: { paseo?: { agents?: { list?: () => Promise< unknown > } } },
): Promise<number> {
  try {
    const conn = await services.daemon.ready();
    const client = (conn as unknown as { client?: { fetchAgents?: (opts: unknown) => Promise<{ entries?: Array<{ agent: AgentRow }> }> } })?.client;
    if (client && typeof client.fetchAgents === 'function') {
      const page = await client.fetchAgents({
        filter: { includeArchived: false },
        page: { limit: 200 },
        timeout: 5_000,
      });
      const rows = (page?.entries ?? []).map(entry => entry.agent);
      return runningTurns(rows, ['antigravity', 'antigravity-*']).length;
    }
  } catch {
    // 守护进程未连接时回退
  }
  try {
    const listFn = rpcContext?.paseo?.agents?.list;
    if (typeof listFn === 'function') {
      const res = (await listFn()) as { agents?: AgentRow[]; entries?: Array<{ agent: AgentRow }> } | AgentRow[];
      const rows = Array.isArray(res)
        ? res
        : Array.isArray(res?.agents)
          ? res.agents
          : Array.isArray(res?.entries)
            ? res.entries.map(e => e.agent)
            : [];
      return runningTurns(rows, ['antigravity', 'antigravity-*']).length;
    }
  } catch {
    // 忽略回退查询错误
  }
  return 0;
}

function readCurrentAntigravitySnapshotData(
  machinePath: string,
  paseoHome: string,
): {
  enabled: boolean;
  accounts: AntigravityAccountItem[];
  conflicts: string[];
  configError: string | null;
} {
  const rawMachine = existsSync(machinePath) ? readJsonFile<Record<string, unknown>>(machinePath) : null;
  const modulesMap =
    rawMachine && typeof rawMachine.modules === 'object' && rawMachine.modules !== null && !Array.isArray(rawMachine.modules)
      ? (rawMachine.modules as Record<string, unknown>)
      : {};
  const enabled = modulesMap['providers.antigravity'] === true;

  let parsedConfig: AntigravityConfig = FALLBACK_CONFIG;
  let configError: string | null = null;
  if (rawMachine && rawMachine.antigravity !== undefined) {
    const parsed = AntigravityConfigSchema.safeParse(rawMachine.antigravity);
    if (parsed.success) {
      parsedConfig = parsed.data;
    } else {
      configError = `machine.json 的 antigravity 配置无效：${parsed.error.issues.map(i => i.message).join('；')}`;
    }
  }

  const paseoConfig = readJsonFile<PaseoConfigFile>(join(paseoHome, 'config.json'));
  const providersMap = paseoConfig?.agents?.providers ?? {};
  const conflicts: string[] = [];

  const accounts: AntigravityAccountItem[] = parsedConfig.accounts.map(account => {
    const providerEntry = providersMap[account.providerId];
    const homeDir = account.homeDir ?? providerEntry?.env?.HOME;
    const conflict = findLegacyAntigravityConflict(paseoHome, account.providerId);
    if (conflict) conflicts.push(conflict.reason);
    return {
      providerId: account.providerId,
      label: account.label,
      enabled: account.enabled,
      ...(homeDir ? { homeDir } : {}),
    };
  });

  return { enabled, accounts, conflicts, configError };
}

export function registerAntigravityRpcs(options: {
  server: PluginServerContext;
  machinePath: string;
  services: Services;
}): void {
  const { server, machinePath, services } = options;
  if (registeredServices.has(services)) return;
  registeredServices.add(services);

  const state = getRuntimeState(services);

  const buildSnapshot = async (
    rpcContext?: unknown,
    overrideError?: string | null,
  ): Promise<AntigravitySnapshot> => {
    const { enabled, accounts, conflicts, configError } = readCurrentAntigravitySnapshotData(
      machinePath,
      services.home,
    );
    const runningSessionsCount = await countRunningAntigravitySessions(
      services,
      rpcContext as { paseo?: { agents?: { list?: () => Promise<unknown> } } },
    );
    const error =
      overrideError !== undefined
        ? overrideError
        : configError ?? (conflicts.length > 0 ? conflicts.join('；') : state.lastError);
    return {
      enabled,
      accounts,
      runningSessionsCount,
      reloadRequired: state.reloadRequired,
      error,
    };
  };

  server.handle(antigravitySnapshot, async (_input, rpcContext) => buildSnapshot(rpcContext));

  server.handle(antigravityAccountToggle, async (input: AntigravityAccountToggleInput, rpcContext) => {
    const rawMachine: Record<string, unknown> =
      (existsSync(machinePath) ? readJsonFile<Record<string, unknown>>(machinePath) : null) ?? {
        version: 1,
      };
    if (rawMachine.version === undefined) rawMachine.version = 1;

    const antigravitySection: Record<string, unknown> =
      rawMachine.antigravity && typeof rawMachine.antigravity === 'object' && !Array.isArray(rawMachine.antigravity)
        ? { ...(rawMachine.antigravity as Record<string, unknown>) }
        : { accounts: [] };
    const rawAccounts = Array.isArray(antigravitySection.accounts)
      ? [...(antigravitySection.accounts as Array<Record<string, unknown>>)]
      : [];

    const idx = rawAccounts.findIndex(
      item => item && typeof item === 'object' && (item.providerId === input.providerId || item.id === input.providerId),
    );
    if (idx === -1) {
      return buildSnapshot(rpcContext, `未找到账号 ${input.providerId}`);
    }

    rawAccounts[idx] = {
      ...rawAccounts[idx],
      enabled: input.enabled,
    };
    antigravitySection.accounts = rawAccounts;
    rawMachine.antigravity = antigravitySection;
    writeJsonAtomic(machinePath, rawMachine);

    // 同步更新 ~/.paseo/config.json 中的 agents.providers[providerId].enabled
    const paseoConfigPath = join(services.home, 'config.json');
    const paseoConfig: PaseoConfigFile = readJsonFile<PaseoConfigFile>(paseoConfigPath) ?? {};
    const agents =
      paseoConfig.agents && typeof paseoConfig.agents === 'object' ? { ...paseoConfig.agents } : {};
    const providers =
      agents.providers && typeof agents.providers === 'object' ? { ...agents.providers } : {};
    if (providers[input.providerId]) {
      providers[input.providerId] = {
        ...providers[input.providerId],
        enabled: input.enabled,
      };
      agents.providers = providers;
      paseoConfig.agents = agents;
      writeJsonAtomic(paseoConfigPath, paseoConfig);
    }

    const patchFn = (rpcContext as { paseo?: { config?: { patch?: (p: unknown) => Promise<unknown> } } })?.paseo?.config?.patch;
    if (typeof patchFn === 'function' && providers[input.providerId]) {
      await patchFn({ agents: { providers } }).catch(() => undefined);
    }

    state.reloadRequired = true;
    state.lastError = null;
    return buildSnapshot(rpcContext);
  });

  server.handle(antigravityAccountAdd, async (input: AntigravityAccountAddInput, rpcContext) => {
    const rawMachine: Record<string, unknown> =
      (existsSync(machinePath) ? readJsonFile<Record<string, unknown>>(machinePath) : null) ?? {
        version: 1,
      };
    if (rawMachine.version === undefined) rawMachine.version = 1;

    const antigravitySection: Record<string, unknown> =
      rawMachine.antigravity && typeof rawMachine.antigravity === 'object' && !Array.isArray(rawMachine.antigravity)
        ? { ...(rawMachine.antigravity as Record<string, unknown>) }
        : { accounts: [] };
    const rawAccounts = Array.isArray(antigravitySection.accounts)
      ? [...(antigravitySection.accounts as Array<Record<string, unknown>>)]
      : [];

    const exists = rawAccounts.some(
      item => item && typeof item === 'object' && (item.providerId === input.providerId || item.id === input.providerId),
    );
    if (exists) {
      return buildSnapshot(rpcContext, `账号 ${input.providerId} 已存在`);
    }

    const newAccountEntry: Record<string, unknown> = {
      id: input.providerId,
      providerId: input.providerId,
      label: input.label,
      enabled: true,
      ...(input.command ? { command: input.command } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.proxy ? { proxy: input.proxy } : {}),
    };
    rawAccounts.push(newAccountEntry);
    antigravitySection.accounts = rawAccounts;
    rawMachine.antigravity = antigravitySection;
    writeJsonAtomic(machinePath, rawMachine);

    // 写入 ~/.paseo/config.json 的 agents.providers[providerId]
    const paseoConfigPath = join(services.home, 'config.json');
    const paseoConfig: PaseoConfigFile = readJsonFile<PaseoConfigFile>(paseoConfigPath) ?? {};
    const agents =
      paseoConfig.agents && typeof paseoConfig.agents === 'object' ? { ...paseoConfig.agents } : {};
    const providers =
      agents.providers && typeof agents.providers === 'object' ? { ...agents.providers } : {};
    const existingEntry = providers[input.providerId] ?? {};
    const nextEnv: Record<string, string> = { ...(existingEntry.env ?? {}) };
    if (input.homeDir) nextEnv.HOME = input.homeDir;
    if (input.proxy) {
      nextEnv.HTTPS_PROXY = input.proxy;
      nextEnv.HTTP_PROXY = input.proxy;
    }
    const existingCmd = normalizeCommand(existingEntry.command);
    providers[input.providerId] = {
      ...existingEntry,
      enabled: true,
      label: input.label,
      command: input.command ?? existingCmd ?? ['agy'],
      ...(Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    };
    agents.providers = providers;
    paseoConfig.agents = agents;
    writeJsonAtomic(paseoConfigPath, paseoConfig);

    const patchFn = (rpcContext as { paseo?: { config?: { patch?: (p: unknown) => Promise<unknown> } } })?.paseo?.config?.patch;
    if (typeof patchFn === 'function') {
      await patchFn({ agents: { providers } }).catch(() => undefined);
    }

    state.reloadRequired = true;
    state.lastError = null;
    return buildSnapshot(rpcContext);
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
  config: {
    section: 'antigravity',
    spec: {
      schema: AntigravityConfigSchema,
      fallback: FALLBACK_CONFIG,
    },
  },
  register(context) {
    const { server, config, machine, services } = context;
    registerAntigravityRpcs({ server, machinePath: machine.path, services });

    const paseoConfig = readJsonFile<PaseoConfigFile>(join(services.home, 'config.json'));
    const providersMap = paseoConfig?.agents?.providers ?? {};
    const conflicts: string[] = [];

    for (const account of config.accounts) {
      if (!account.enabled) continue;
      const conflict = findLegacyAntigravityConflict(services.home, account.providerId);
      if (conflict) {
        conflicts.push(conflict.reason);
        continue;
      }
      const configuredCmd =
        account.command ?? normalizeCommand(providersMap[account.providerId]?.command);
      server.registerProvider(
        createAntigravityProvider({
          providerId: account.providerId,
          label: account.label,
          command: configuredCmd,
          description: account.description,
        }),
      );
    }

    if (conflicts.length > 0) {
      const message = conflicts.join('；');
      getRuntimeState(services).lastError = message;
      context.fail(new Error(message));
    }
  },
};
