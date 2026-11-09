import { join } from 'node:path';
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
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { backupFile, readJsonStrict, writeJsonFile } from '../../core/provider-config.ts';
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

/**
 * 检查要启用的额度来源是否与仍启用的旧插件冲突（来源 ID 重复会让整个实例停止）。
 * - provider-quotas-usage-source 仍启用时，全部来源均冲突；
 * - glm-usage-source 仍启用时（如 Mac Mini），glm 来源冲突；
 * - 读不到或无法解析 Paseo 的 config.json 时按“仍启用”处理，全部来源跳过并说明原因。
 */
export function detectUsageSourceConflicts(
  paseoHome: string,
  enabledSources: readonly string[],
): {
  allowedSources: ProviderQuotaSourceId[];
  skippedConflicts: SkippedConflict[];
} {
  const quotas = legacyPluginStatus(paseoHome, 'provider-quotas-usage-source');
  const glm = legacyPluginStatus(paseoHome, 'glm-usage-source');
  const allowedSources: ProviderQuotaSourceId[] = [];
  const skippedConflicts: SkippedConflict[] = [];
  const seenSources = new Set<string>();

  for (const rawId of enabledSources) {
    if (!SOURCE_ID_SET.has(rawId) || seenSources.has(rawId)) continue;
    seenSources.add(rawId);
    const sourceId = rawId as ProviderQuotaSourceId;

    if (sourceId === 'glm' && glm.enabled) {
      skippedConflicts.push({ sourceId, legacyPluginId: 'glm-usage-source', reason: `${glm.problem ?? '旧插件 glm-usage-source 仍启用'}，已跳过额度来源 glm` });
      continue;
    }
    if (quotas.enabled) {
      skippedConflicts.push({ sourceId, legacyPluginId: 'provider-quotas-usage-source', reason: `${quotas.problem ?? '旧插件 provider-quotas-usage-source 仍启用'}，已跳过额度来源 ${sourceId}` });
      continue;
    }
    allowedSources.push(sourceId);
  }

  return { allowedSources, skippedConflicts };
}

/**
 * “需要重载”由实际注册情况推出：模块启动时记下注册了哪些来源，之后配置里允许的来源集合变了就需要重载；
 * 重载（重新注册）后自动清除。RPC 单独使用（没有模块注册）时用 touched 作退路。
 */
const registeredSources = new WeakMap<Services, Set<string>>();
const touched = new WeakSet<Services>();
const lastErrors = new WeakMap<Services, string>();

const sameSet = (left: ReadonlySet<string>, right: readonly string[]) => left.size === right.length && right.every(id => left.has(id));

function readSnapshotFromDisk(machinePath: string, services: Services, overrideError?: string | null): ProviderQuotasSnapshot {
  let rawMachine: Record<string, any> | null = null;
  let configError: string | null = null;
  try { rawMachine = readJsonStrict(machinePath); } catch (error) { configError = (error as Error).message.replace('，没有写入', ''); }
  const modulesMap = rawMachine && typeof rawMachine.modules === 'object' && rawMachine.modules && !Array.isArray(rawMachine.modules) ? rawMachine.modules : {};
  const enabled = modulesMap['usage.providerQuotas'] === true;

  let parsedConfig: ProviderQuotasConfig = FALLBACK_CONFIG;
  if (rawMachine && rawMachine.providerQuotas !== undefined) {
    const parsed = ProviderQuotasConfigSchema.safeParse(rawMachine.providerQuotas);
    if (parsed.success) parsedConfig = parsed.data;
    else configError ??= `machine.json 的 providerQuotas 配置无效：${parsed.error.issues.map(issue => issue.message).join('；')}`;
  }

  const { allowedSources, skippedConflicts } = detectUsageSourceConflicts(services.home, parsedConfig.enabledSources);
  const conflictError = skippedConflicts.length > 0 ? skippedConflicts.map(conflict => conflict.reason).join('；') : null;
  const registered = registeredSources.get(services);
  return {
    enabled,
    enabledSources: [...parsedConfig.enabledSources],
    hideBuiltin: [...parsedConfig.hideBuiltin],
    hideBuiltinApplied: false,
    skippedConflicts,
    reloadRequired: registered ? !sameSet(registered, allowedSources) : touched.has(services),
    error: overrideError !== undefined ? overrideError : configError ?? conflictError ?? lastErrors.get(services) ?? null,
  };
}

export function registerProviderQuotasRpcs(options: {
  server: PluginServerContext;
  machinePath: string;
  services: Services;
}): void {
  const { server, machinePath, services } = options;

  server.handle(providerQuotasSnapshot, async () => readSnapshotFromDisk(machinePath, services));

  server.handle(providerQuotasConfigure, async (input: ProviderQuotasConfigureInput) => {
    const current = readSnapshotFromDisk(machinePath, services);
    const validated = ProviderQuotasConfigSchema.safeParse({
      enabledSources: input.enabledSources ?? current.enabledSources,
      hideBuiltin: input.hideBuiltin ?? current.hideBuiltin,
    });
    if (!validated.success) {
      return readSnapshotFromDisk(machinePath, services, `配置参数无效：${validated.error.issues.map(issue => issue.message).join('；')}`);
    }

    // 损坏的 machine.json 不能补成空对象写回；写前先备份。
    let rawMachine: Record<string, any>;
    try {
      rawMachine = readJsonStrict(machinePath) ?? { version: 1 };
    } catch (error) {
      const message = (error as Error).message;
      lastErrors.set(services, message);
      return readSnapshotFromDisk(machinePath, services, message);
    }
    if (rawMachine.version === undefined) rawMachine.version = 1;
    if (input.enabled !== undefined) {
      const modulesMap = rawMachine.modules && typeof rawMachine.modules === 'object' && !Array.isArray(rawMachine.modules) ? { ...rawMachine.modules } : {};
      modulesMap['usage.providerQuotas'] = input.enabled;
      rawMachine.modules = modulesMap;
    }
    rawMachine.providerQuotas = { sources: validated.data.enabledSources, hideBuiltin: validated.data.hideBuiltin };
    try {
      try { backupFile(machinePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      writeJsonFile(machinePath, rawMachine);
    } catch (error) {
      const message = `无法保存 machine.json：${(error as Error).message}`;
      lastErrors.set(services, message);
      return readSnapshotFromDisk(machinePath, services, message);
    }
    touched.add(services);
    lastErrors.delete(services);
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

    registeredSources.set(services, new Set(registeredIds));
    touched.delete(services);
    lastErrors.delete(services);
    if (skippedConflicts.length > 0) {
      const message = skippedConflicts.map(c => c.reason).join('；');
      lastErrors.set(services, message);
      context.fail(new Error(message));
    }
  },
};
