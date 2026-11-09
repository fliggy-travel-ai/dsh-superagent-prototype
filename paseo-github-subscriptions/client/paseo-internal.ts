import { normalizeHideBuiltinId, normalizeUsagePins } from '../shared/provider-quotas.ts';

/**
 * Paseo 客户端内部接口单一适配层（`client/paseo-internal.ts`）。
 *
 * 所有对 Paseo 前端内部模块（Metro 模块表、额度视图计算、侧栏固定额度项计算）的访问集中在此。
 * 约束：
 * 1. 只在显示计算层过滤（`settleReports` / `upsertReport` / `resolveUsageView` / `effectiveUsagePins`），
 *    绝不改写持久化的 `localStorage['@paseo:app-settings']` 或调用 `persistAppSettings`，
 *    确保清空 `hideBuiltin` 后用户原本固定的内置额度项可立即恢复。
 * 2. 通过 `metroRequire.getModules()` 遍历已初始化模块并按导出函数特征匹配，不依赖硬编码模块编号；
 *    特征校验失败时立即安全降级并返回 `{ applied: false }`。
 * 3. 不注入自定义图标，不修改 `providerSnapshotIcons` 等无关状态。
 */

let activeHideBuiltin: string[] = [];
let activeSuppressedSet = new Set<string>();
const patchedViewModules = new WeakSet<object>();
const patchedPinModules = new WeakSet<object>();

export function buildSuppressedSet(hideBuiltin: readonly string[]): Set<string> {
  const suppressed = new Set<string>();
  for (const item of hideBuiltin) {
    const normalized = normalizeHideBuiltinId(item);
    if (normalized) suppressed.add(normalized);
  }
  return suppressed;
}

/**
 * 按 hideBuiltin 过滤 Paseo 额度报告列表，隐藏指定的内置额度来源。
 */
export function filterUsageReports<T extends { sourceId?: string }>(
  reports: readonly T[] | null | undefined,
  hideBuiltin: readonly string[] = activeHideBuiltin,
): T[] {
  if (!Array.isArray(reports)) return [];
  const suppressed = hideBuiltin === activeHideBuiltin ? activeSuppressedSet : buildSuppressedSet(hideBuiltin);
  if (suppressed.size === 0) return [...reports];
  return reports.filter(report => !report?.sourceId || !suppressed.has(report.sourceId));
}

function isUsageViewModule(mod: unknown): mod is {
  settleReports: (current: any, incoming: any) => any;
  upsertReport?: (current: any, item: any) => any;
  resolveUsageView: (input: any, t?: any) => any;
} {
  return Boolean(
    mod &&
      typeof mod === 'object' &&
      typeof (mod as Record<string, unknown>).settleReports === 'function' &&
      typeof (mod as Record<string, unknown>).resolveUsageView === 'function',
  );
}

function isUsagePinsModule(mod: unknown): mod is {
  effectiveUsagePins: (preferences: any, reports: any) => any;
} {
  return Boolean(
    mod &&
      typeof mod === 'object' &&
      typeof (mod as Record<string, unknown>).effectiveUsagePins === 'function',
  );
}

function collectCandidateExports(metroRequire: ((id: number) => any) & { getModules?: () => unknown }): object[] {
  const exportsList: object[] = [];
  const seen = new Set<object>();
  const add = (mod: unknown) => {
    if (mod && typeof mod === 'object' && !seen.has(mod)) {
      seen.add(mod);
      exportsList.push(mod);
    }
  };

  if (typeof metroRequire.getModules === 'function') {
    try {
      const modulesMap = metroRequire.getModules();
      if (modulesMap && typeof modulesMap === 'object') {
        const entries = modulesMap instanceof Map ? [...modulesMap.values()] : Object.values(modulesMap);
        for (const entry of entries) {
          if (entry && typeof entry === 'object' && (entry as any).isInitialized) {
            add((entry as any).publicModule?.exports);
          }
        }
      }
    } catch {
      // 忽略 getModules 读取异常
    }
  }

  // 若宿主未暴露 getModules，按历史候选模块号回退探测并校验导出签名
  for (const fallbackId of [3273, 3353, 3563, 3663]) {
    try {
      add(metroRequire(fallbackId));
    } catch {
      // 忽略未定义模块
    }
  }

  return exportsList;
}

function patchUsageModules(metroRequire: ((id: number) => any) & { getModules?: () => unknown }): {
  viewPatched: boolean;
  pinsPatched: boolean;
} {
  let viewPatched = false;
  let pinsPatched = false;
  const candidates = collectCandidateExports(metroRequire);

  for (const mod of candidates) {
    if (isUsageViewModule(mod)) {
      if (!patchedViewModules.has(mod)) {
        const origSettle = mod.settleReports.bind(mod);
        const origUpsert = typeof mod.upsertReport === 'function' ? mod.upsertReport.bind(mod) : null;
        const origResolveView = mod.resolveUsageView.bind(mod);

        mod.settleReports = (current: any, incoming: any) =>
          filterUsageReports(origSettle(filterUsageReports(current), filterUsageReports(incoming)));

        if (origUpsert) {
          mod.upsertReport = (current: any, item: any) => {
            const filteredCurrent = filterUsageReports(current);
            if (item?.sourceId && activeSuppressedSet.has(item.sourceId)) return filteredCurrent;
            return filterUsageReports(origUpsert(filteredCurrent, item));
          };
        }

        mod.resolveUsageView = (input: any, t?: any) => {
          const view = origResolveView(input, t);
          if (view && view.kind === 'ready' && Array.isArray(view.reports)) {
            return { ...view, reports: filterUsageReports(view.reports) };
          }
          return view;
        };
        patchedViewModules.add(mod);
      }
      viewPatched = true;
    }

    if (isUsagePinsModule(mod)) {
      if (!patchedPinModules.has(mod)) {
        const origEffectivePins = mod.effectiveUsagePins.bind(mod);
        mod.effectiveUsagePins = (preferences: any, reports: any) => {
          const filteredReports = filterUsageReports(reports);
          const normalizedPrefs =
            preferences && typeof preferences === 'object' && Array.isArray(preferences.pins)
              ? { ...preferences, pins: normalizeUsagePins(preferences.pins, { hideBuiltin: activeHideBuiltin }) }
              : preferences;
          const pins = origEffectivePins(normalizedPrefs, filteredReports);
          return normalizeUsagePins(pins, { hideBuiltin: activeHideBuiltin }) ?? [];
        };
        patchedPinModules.add(mod);
      }
      pinsPatched = true;
    }
  }

  return { viewPatched, pinsPatched };
}

/**
 * 在客户端显示计算层按 `provider-quotas.snapshot` 的 `hideBuiltin` 过滤内置额度来源与侧栏固定项，
 * 不写 `localStorage`、不调 `persistAppSettings`、不修改 `config.json`。
 * 返回 `{ applied }` 如实反映内部模块是否匹配成功。
 */
export function syncHideBuiltinUsage(
  hideBuiltin: readonly string[],
  runtimeGlobal: Record<string, any> = globalThis as Record<string, any>,
): { applied: boolean } {
  activeHideBuiltin = [...hideBuiltin];
  activeSuppressedSet = buildSuppressedSet(hideBuiltin);

  const metroRequire = typeof runtimeGlobal.__r === 'function' ? runtimeGlobal.__r : null;
  if (!metroRequire) {
    return { applied: false };
  }
  try {
    const { viewPatched, pinsPatched } = patchUsageModules(metroRequire);
    return { applied: viewPatched && pinsPatched };
  } catch {
    return { applied: false };
  }
}
