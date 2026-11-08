import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import {
  BUILTIN_USAGE_SOURCE_IDS,
  PROVIDER_QUOTA_SOURCE_IDS,
  providerQuotasConfigure,
  providerQuotasSnapshot,
  type BuiltinUsageSourceId,
  type ProviderQuotasConfigureInput,
  type ProviderQuotaSourceId,
  type ProviderQuotasSnapshot,
  type SkippedConflict,
} from '../../../shared/provider-quotas.ts';
import { isMainInstance, type Module, type Services } from '../types.ts';
import { normalizeHideBuiltinId } from './hide-builtin.ts';
import { privateUsageSource } from './server/usage-display.ts';
import { createUsageSources } from './server/usage.ts';

const SOURCE_ID_SET = new Set<string>(PROVIDER_QUOTA_SOURCE_IDS);

const SourceIdSchema = z.enum(PROVIDER_QUOTA_SOURCE_IDS);

const HideBuiltinItemSchema = z
  .string()
  .refine(val => normalizeHideBuiltinId(val) !== null, {
    message: `不支持的内置额度来源（可选值：${BUILTIN_USAGE_SOURCE_IDS.join('、')}）`,
  })
  .transform(val => normalizeHideBuiltinId(val)!);

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

const RawProviderQuotasObjectSchema = z
  .object({
    sources: z.array(SourceIdSchema).optional(),
    enabledSources: z.array(SourceIdSchema).optional(),
    hideBuiltin: z.array(HideBuiltinItemSchema).optional(),
  })
  .transform(val => {
    const enabledSources = dedupe(val.enabledSources ?? val.sources ?? []);
    const hideBuiltin = dedupe(val.hideBuiltin ?? []);
    return {
      sources: enabledSources,
      enabledSources,
      hideBuiltin,
    };
  });

export const ProviderQuotasConfigSchema = z.union([
  RawProviderQuotasObjectSchema,
  z.array(SourceIdSchema).transform(arr => {
    const enabledSources = dedupe(arr);
    return {
      sources: enabledSources,
      enabledSources,
      hideBuiltin: [] as BuiltinUsageSourceId[],
    };
  }),
]);

export type ProviderQuotasConfig = z.infer<typeof ProviderQuotasConfigSchema>;

const FALLBACK_CONFIG: ProviderQuotasConfig = {
  sources: [],
  enabledSources: [],
  hideBuiltin: [],
};

interface PaseoConfigFile {
  plugins?: Record<string, { enabled?: boolean; source?: string; path?: string }>;
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

function isLegacyPluginEnabled(
  plugins: Record<string, { enabled?: boolean }> | undefined,
  pluginId: string,
): boolean {
  if (!plugins || typeof plugins !== 'object') return false;
  const entry = plugins[pluginId];
  return Boolean(entry && typeof entry === 'object' && entry.enabled !== false);
}

/**
 * 同步读取 ~/.paseo/config.json 的 plugins，检查要启用的额度来源是否与仍处于启用状态的旧插件冲突。
 * - provider-quotas-usage-source 仍启用时，全部 7 个来源均冲突；
 * - glm-usage-source 仍启用时（如 Mac Mini），glm 来源冲突。
 */
export function detectUsageSourceConflicts(
  paseoHome: string,
  enabledSources: readonly string[],
): {
  allowedSources: ProviderQuotaSourceId[];
  skippedConflicts: SkippedConflict[];
} {
  const config = readJsonFile<PaseoConfigFile>(join(paseoHome, 'config.json'));
  const plugins = config?.plugins;
  const quotasLegacyActive = isLegacyPluginEnabled(plugins, 'provider-quotas-usage-source');
  const glmLegacyActive = isLegacyPluginEnabled(plugins, 'glm-usage-source');

  const allowedSources: ProviderQuotaSourceId[] = [];
  const skippedConflicts: SkippedConflict[] = [];
  const seenSources = new Set<string>();

  for (const rawId of enabledSources) {
    if (!SOURCE_ID_SET.has(rawId) || seenSources.has(rawId)) continue;
    seenSources.add(rawId);
    const sourceId = rawId as ProviderQuotaSourceId;

    if (sourceId === 'glm' && glmLegacyActive) {
      skippedConflicts.push({
        sourceId,
        legacyPluginId: 'glm-usage-source',
        reason: '旧插件 glm-usage-source 仍启用，已跳过额度来源 glm',
      });
      continue;
    }
    if (quotasLegacyActive) {
      skippedConflicts.push({
        sourceId,
        legacyPluginId: 'provider-quotas-usage-source',
        reason: `旧插件 provider-quotas-usage-source 仍启用，已跳过额度来源 ${sourceId}`,
      });
      continue;
    }
    allowedSources.push(sourceId);
  }

  return { allowedSources, skippedConflicts };
}

interface QuotasRuntimeState {
  reloadRequired: boolean;
  lastError: string | null;
}

const runtimeStates = new WeakMap<Services, QuotasRuntimeState>();
const registeredServices = new WeakSet<Services>();

function getRuntimeState(services: Services): QuotasRuntimeState {
  let state = runtimeStates.get(services);
  if (!state) {
    state = { reloadRequired: false, lastError: null };
    runtimeStates.set(services, state);
  }
  return state;
}

function readSnapshotFromDisk(
  machinePath: string,
  services: Services,
  overrideError?: string | null,
): ProviderQuotasSnapshot {
  const state = getRuntimeState(services);
  const rawMachine = existsSync(machinePath) ? readJsonFile<Record<string, unknown>>(machinePath) : null;
  const modulesMap =
    rawMachine && typeof rawMachine.modules === 'object' && rawMachine.modules !== null && !Array.isArray(rawMachine.modules)
      ? (rawMachine.modules as Record<string, unknown>)
      : {};
  const enabled = modulesMap['usage.providerQuotas'] === true;

  let parsedConfig: ProviderQuotasConfig = FALLBACK_CONFIG;
  let configError: string | null = null;
  if (rawMachine && rawMachine.providerQuotas !== undefined) {
    const parsed = ProviderQuotasConfigSchema.safeParse(rawMachine.providerQuotas);
    if (parsed.success) {
      parsedConfig = parsed.data;
    } else {
      configError = `machine.json 的 providerQuotas 配置无效：${parsed.error.issues.map(i => i.message).join('；')}`;
    }
  }

  const { skippedConflicts } = detectUsageSourceConflicts(services.home, parsedConfig.enabledSources);
  const conflictError =
    skippedConflicts.length > 0 ? skippedConflicts.map(c => c.reason).join('；') : null;
  const error =
    overrideError !== undefined
      ? overrideError
      : configError ?? conflictError ?? state.lastError;

  return {
    enabled,
    enabledSources: [...parsedConfig.enabledSources],
    hideBuiltin: [...parsedConfig.hideBuiltin],
    skippedConflicts,
    reloadRequired: state.reloadRequired,
    error,
  };
}

export function registerProviderQuotasRpcs(options: {
  server: PluginServerContext;
  machinePath: string;
  services: Services;
}): void {
  const { server, machinePath, services } = options;
  if (registeredServices.has(services)) return;
  registeredServices.add(services);

  const state = getRuntimeState(services);

  server.handle(providerQuotasSnapshot, async () => readSnapshotFromDisk(machinePath, services));

  server.handle(providerQuotasConfigure, async (input: ProviderQuotasConfigureInput) => {
    const current = readSnapshotFromDisk(machinePath, services);
    const rawNextSources = input.enabledSources ?? current.enabledSources;
    const rawNextHideBuiltin = input.hideBuiltin ?? current.hideBuiltin;

    const validated = ProviderQuotasConfigSchema.safeParse({
      enabledSources: rawNextSources,
      hideBuiltin: rawNextHideBuiltin,
    });
    if (!validated.success) {
      return readSnapshotFromDisk(
        machinePath,
        services,
        `配置参数无效：${validated.error.issues.map(i => i.message).join('；')}`,
      );
    }

    const rawMachine: Record<string, unknown> =
      (existsSync(machinePath) ? readJsonFile<Record<string, unknown>>(machinePath) : null) ?? {
        version: 1,
      };
    if (rawMachine.version === undefined) rawMachine.version = 1;

    if (input.enabled !== undefined) {
      const modulesMap =
        rawMachine.modules && typeof rawMachine.modules === 'object' && !Array.isArray(rawMachine.modules)
          ? { ...(rawMachine.modules as Record<string, unknown>) }
          : {};
      modulesMap['usage.providerQuotas'] = input.enabled;
      rawMachine.modules = modulesMap;
    }

    rawMachine.providerQuotas = {
      sources: validated.data.enabledSources,
      hideBuiltin: validated.data.hideBuiltin,
    };
    writeJsonAtomic(machinePath, rawMachine);

    state.reloadRequired = true;
    state.lastError = null;
    return readSnapshotFromDisk(machinePath, services);
  });
}

/**
 * 其他 Provider 额度模块（在主实例运行）。
 * 迁自 provider-quotas-usage-source，支持按 machine.json 开关逐个启用额度来源，
 * 并在对应旧插件仍启用时自动跳过冲突来源并报错。
 */
export const providerQuotasModule: Module<ProviderQuotasConfig> = {
  id: 'usage.providerQuotas',
  label: '其他 Provider 额度',
  defaultEnabled: false,
  appliesTo: isMainInstance,
  config: {
    section: 'providerQuotas',
    spec: {
      schema: ProviderQuotasConfigSchema,
      fallback: FALLBACK_CONFIG,
    },
  },
  register(context) {
    const { server, config, machine, services } = context;
    registerProviderQuotasRpcs({ server, machinePath: machine.path, services });

    const { allowedSources, skippedConflicts } = detectUsageSourceConflicts(
      services.home,
      config.enabledSources,
    );
    const allowedSet = new Set<string>(allowedSources);
    const registeredIds = new Set<string>();

    for (const source of createUsageSources()) {
      if (!allowedSet.has(source.id) || registeredIds.has(source.id)) continue;
      registeredIds.add(source.id);
      server.registerUsageSource(privateUsageSource(source, services.home));
    }

    if (skippedConflicts.length > 0) {
      const message = skippedConflicts.map(c => c.reason).join('；');
      getRuntimeState(services).lastError = message;
      context.fail(new Error(message));
    }
  },
};
