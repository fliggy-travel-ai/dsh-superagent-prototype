import { normalizeHideBuiltinId, normalizeUsagePins } from '../shared/provider-quotas.ts';

const APP_SETTINGS_KEY = '@paseo:app-settings';

const QODER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none">
  <path fill="currentColor" d="M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z" />
</svg>`;

const GROK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 1024 1024" fill="none">
  <path fill="currentColor" d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916" />
  <path fill="currentColor" d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339" />
</svg>`;

let activeHideBuiltin: string[] = [];
let activeSuppressedSet = new Set<string>();
const patchedModules = new WeakSet<object>();

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

function patchUsageModules(metroRequire: (id: number) => any): void {
  const candidateIds = [996, 3273, 3353, 3563, 3663];
  for (const id of candidateIds) {
    let mod: any;
    try {
      mod = metroRequire(id);
    } catch {
      continue;
    }
    if (!mod || typeof mod !== 'object') continue;

    // 1. 确保 providerSnapshotIcons 为 Map
    const store = mod.providerSnapshotIcons;
    if (
      store &&
      typeof store.getState === 'function' &&
      typeof store.setState === 'function' &&
      !(store.getState() instanceof Map)
    ) {
      store.setState(new Map(), true);
    }

    // 2. 补充 qoder 与 grok 图标
    if (mod.ACP_PROVIDER_ICON_SVGS && typeof mod.ACP_PROVIDER_ICON_SVGS === 'object') {
      mod.ACP_PROVIDER_ICON_SVGS.qoder = QODER_SVG;
      mod.ACP_PROVIDER_ICON_SVGS.grok = GROK_SVG;
    }

    if (patchedModules.has(mod)) continue;

    // 3. 过滤额度面板与主机额度报告显示（settleReports / upsertReport / resolveUsageView）
    if (typeof mod.settleReports === 'function' && typeof mod.resolveUsageView === 'function') {
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
      patchedModules.add(mod);
    }

    // 4. 过滤侧栏固定额度项（effectiveUsagePins）
    if (typeof mod.effectiveUsagePins === 'function') {
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
      patchedModules.add(mod);
    }
  }
}

/**
 * 照 provider-quotas-usage-source/index.client.ts 的做法，在客户端按 provider-quotas.snapshot 的 hideBuiltin
 * 过滤 Paseo 内置额度来源的显示和侧栏固定项，不修改 config.json 的 plugins。
 */
export function syncHideBuiltinUsage(
  hideBuiltin: readonly string[],
  runtimeGlobal: Record<string, any> = globalThis as Record<string, any>,
): void {
  activeHideBuiltin = [...hideBuiltin];
  activeSuppressedSet = buildSuppressedSet(hideBuiltin);

  const metroRequire = typeof runtimeGlobal.__r === 'function' ? runtimeGlobal.__r : null;
  if (metroRequire) {
    try {
      patchUsageModules(metroRequire);
    } catch {
      // 忽略运行时桥接差异
    }
  }

  // 1. 直接更新 localStorage 中的 @paseo:app-settings 固定项
  try {
    const storage = runtimeGlobal.localStorage;
    if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
      const raw = storage.getItem(APP_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.usage && Array.isArray(parsed.usage.pins)) {
          const nextPins = normalizeUsagePins(parsed.usage.pins, { hideBuiltin: activeHideBuiltin });
          if (JSON.stringify(nextPins) !== JSON.stringify(parsed.usage.pins)) {
            parsed.usage = { ...parsed.usage, pins: nextPins };
            storage.setItem(APP_SETTINGS_KEY, JSON.stringify(parsed));
          }
        }
      }
    }
  } catch {
    // 忽略存储访问异常
  }

  // 2. 通过 Paseo 的 persistAppSettings 同步更新 React Query 中的 app-settings 缓存
  if (metroRequire) {
    try {
      const mod996 = metroRequire(996);
      const persist = mod996 && typeof mod996.persistAppSettings === 'function' ? mod996.persistAppSettings : null;
      if (persist) {
        void persist((prev: any) => {
          const currentPins = prev?.usage?.pins;
          if (!Array.isArray(currentPins)) return {};
          const nextPins = normalizeUsagePins(currentPins, { hideBuiltin: activeHideBuiltin });
          if (JSON.stringify(nextPins) === JSON.stringify(currentPins)) return {};
          return {
            usage: {
              ...prev.usage,
              pins: nextPins,
            },
          };
        });
      }
    } catch {
      // 忽略模块 ID 变化
    }
  }
}
