import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { AgentDefaultsSchema, defaultsSave, defaultsSnapshot, type AgentDefaultRule } from '../../shared/defaults.ts';
import {
  machineSettingsExportBackup,
  machineSettingsPauseAll,
  machineSettingsSnapshot,
  machineSettingsToggleModule,
} from '../../shared/machine-settings.ts';
import { loadMachineConfig, type LoadedMachineConfig, type SectionSpec } from './machine-config.ts';
import { MAIN_PLUGIN_ID } from '../../shared/instances.ts';
import { BrowserSettingsSchema, BrowserBindingInputSchema, BrowserApprovalEventSchema } from '../../shared/browser.ts';
import { createSettingsStore } from './settings-store.ts';
import { RuntimeSettingsSchema, ESCALATION_FALLBACK, runtimeDefaults } from '../modules/answer-escalation/config.ts';
import { QuietSettingsSchema, QUIET_FALLBACK, quietDefaults } from '../modules/answer-quiet-children/config.ts';
import { exportMachineBackup, patchMachineConfig, readRawMachineConfig } from './machine-writer.ts';
import type { ModuleHost } from './modules.ts';
import type { Services } from '../modules/types.ts';

export function isModuleEnabled(
  machine: { modules: Record<string, boolean> },
  id: string,
  defaultEnabled: boolean,
): boolean {
  const value = machine.modules[id];
  return value === undefined ? defaultEnabled : value === true;
}

const MODULE_DEFS = [
  { id: 'providers.defaults', label: '新建会话默认设置', defaultEnabled: false },
  { id: 'answer.presence', label: '问答模式与蓝牙', defaultEnabled: true },
  { id: 'answer.automation', label: '精确授权', defaultEnabled: true },
  { id: 'answer.browser', label: '网页版 claude.ai', defaultEnabled: true },
  { id: 'answer.escalation', label: '升级通知', defaultEnabled: false },
  { id: 'answer.quietChildren', label: '子会话免提醒', defaultEnabled: false },
  { id: 'usage.claudeAccounts', label: 'Claude 账号与额度', defaultEnabled: true },
  { id: 'usage.providerQuotas', label: '其他 Provider 额度', defaultEnabled: false },
  { id: 'providers.antigravity', label: 'Antigravity 多账号', defaultEnabled: false },
  { id: 'github', label: 'GitHub 订阅', defaultEnabled: true },
  { id: 'todo.stalled', label: '停滞会话检查', defaultEnabled: true },
] as const;

interface PauseAllState {
  paused: boolean;
  inProgress?: boolean;
  saved?: {
    automationPaused?: boolean;
    presencePaused?: boolean;
    githubEnabled?: boolean;
    escalationEnabled?: boolean;
    quietEnabled?: boolean;
    stalledPaused?: boolean;
  };
}

async function readPauseAllState(stateDirectory: string): Promise<PauseAllState> {
  try {
    const raw = JSON.parse(await readFile(join(stateDirectory, 'pause-all.json'), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.paused === 'boolean') {
      return {
        paused: raw.paused,
        ...(raw.inProgress === true ? { inProgress: true } : {}),
        ...(raw.saved && typeof raw.saved === 'object' ? { saved: raw.saved } : {}),
      };
    }
  } catch {
    // 文件不存在或损坏时默认未暂停
  }
  return { paused: false };
}

async function writePauseAllState(stateDirectory: string, state: PauseAllState): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const filePath = join(stateDirectory, 'pause-all.json');
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

export function registerMachineSettingsRpcs(options: {
  server: PluginServerContext;
  machine: LoadedMachineConfig;
  host: ModuleHost;
  services: Services;
  stateDirectory: string;
  baseDirectory: string;
  sections?: Readonly<Record<string, SectionSpec>>;
  reload?: () => Promise<unknown>;
}): void {
  const { server, machine, host, services, stateDirectory, baseDirectory } = options;

  void readPauseAllState(stateDirectory).then(state => {
    if (services.main && state.paused) {
      services.main.stalledPaused = true;
    }
  });

  // 当 providers.defaults 默认关闭而未在启动时注册时，由核心层提供规则读取与保存入口（独立于 todo 模块）
  const defaultsRunning = host.status().modules.some(m => m.id === 'providers.defaults' && m.state === 'running');
  if (!defaultsRunning) {
    let enabled = Boolean(machine.modules['providers.defaults']);
    const section = machine.section<AgentDefaultRule[]>('agentDefaults');
    let rules: AgentDefaultRule[] = section.ok ? [...section.value] : [];
    server.handle(defaultsSnapshot, async () => ({
      enabled,
      rules,
      error: section.ok ? null : section.error,
    }));
    server.handle(defaultsSave, async input => {
      if (!section.ok) {
        throw new Error(`默认规则配置段读取失败，拒绝覆盖保存：${section.error}`);
      }
      if (input.enabled !== undefined) enabled = input.enabled;
      if (input.rules !== undefined) rules = AgentDefaultsSchema.parse(input.rules);
      await patchMachineConfig(machine.path, raw => ({
        ...raw,
        modules: {
          ...(raw.modules && typeof raw.modules === 'object' ? (raw.modules as Record<string, unknown>) : {}),
          'providers.defaults': enabled,
        },
        agentDefaults: rules,
      }));
      return { enabled, rules, error: null };
    });
  }

  let reloadPending = false;
  const buildSettingsSnapshot = async () => {
    const [raw, pauseState] = await Promise.all([
      readRawMachineConfig(machine.path).catch(() => ({ version: 1 } as Record<string, unknown>)),
      readPauseAllState(stateDirectory),
    ]);
    const rawModules = raw.modules && typeof raw.modules === 'object' ? (raw.modules as Record<string, boolean>) : {};
    const liveById = new Map(host.status().modules.map(m => [m.id, m]));

    return {
      configPath: machine.path,
      source: machine.source,
      machine: (typeof raw.machine === 'string' ? raw.machine : machine.machine) ?? null,
      errors: [...loadMachineConfig(machine.path, options.sections ?? {}).errors],
      modules: MODULE_DEFS.map(def => {
        const enabled = Boolean(rawModules[def.id] ?? machine.modules[def.id] ?? def.defaultEnabled);
        const live = liveById.get(def.id);
        const state = live?.state ?? ('off' as const);
        const reason = live?.reason ?? live?.lastUncaught?.summary;
        return {
          id: def.id,
          label: def.label,
          enabled,
          state,
          ...(reason ? { reason } : {}),
          // 所有模块只在 contribute() 启动时由 startModules 注册一次，切换任何模块开关都需要重载才生效
          reloadRequired: true,
        };
      }),
      pausedAll: pauseState.paused,
      reloadInProgress: reloadPending,
    };
  };

  server.handle(machineSettingsSnapshot, () => buildSettingsSnapshot());

  const moduleSections: Record<string, string> = {
    'providers.defaults': 'agentDefaults', 'providers.antigravity': 'antigravity',
    'answer.escalation': 'escalation', 'answer.quietChildren': 'quietChildren',
    'usage.claudeAccounts': 'claudeAccounts', 'usage.providerQuotas': 'providerQuotas',
  };
  server.handle(machineSettingsToggleModule, ({ id, enabled }) => {
    if (reloadPending) return Promise.reject(new Error('插件正在重新加载，请稍后再试'));
    reloadPending = true;
    const run = (async () => {
      if (!MODULE_DEFS.some(def => def.id === id)) throw new Error('未知模块');
      const section = moduleSections[id];
      const spec = section ? options.sections?.[section] : undefined;
      const checked = loadMachineConfig(machine.path, section && spec ? { [section]: spec } : {});
      if (checked.errors.length) throw new Error(`配置无效，未保存：${checked.errors.join('；')}`);
      // 功能内部开关与模块开关同步，失败时恢复先写的功能状态。
      let rollback: (() => Promise<unknown>) | undefined;
      let committed = false;
      try {
        if (id === 'answer.browser' && services.main) {
          if (host.status().modules.some(m => m.id === id && m.state === 'running')) {
            const browser = await services.main.readyBrowser();
            const previous = browser.snapshot().settings;
            rollback = () => browser.configure(previous);
            await browser.configure({ ...previous, enabled });
          } else {
            const path = join(stateDirectory, 'browser-state.json');
            let state: Record<string, unknown>;
            let previousText: string | null = null;
            try {
              previousText = await readFile(path, 'utf8');
              const parsed: unknown = JSON.parse(previousText);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('浏览器状态文件无效');
              state = parsed as Record<string, unknown>;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('浏览器状态文件无效，未保存');
              state = {};
            }
            const settings = BrowserSettingsSchema.parse(state.settings ?? {});
            const bindings = BrowserBindingInputSchema.extend({ agentId: BrowserBindingInputSchema.shape.agentId.unwrap() }).array().parse(state.bindings ?? []);
            const approvals = BrowserApprovalEventSchema.array().parse(state.approvals ?? []);
            rollback = async () => {
              if (previousText === null) await unlink(path).catch(() => {});
              else {
                const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
                await writeFile(temp, previousText, { mode: 0o600 });
                await rename(temp, path);
              }
            };
            await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
            const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
            await writeFile(temp, JSON.stringify({ ...state, settings: { ...settings, enabled }, bindings, approvals }), { mode: 0o600 });
            await rename(temp, path);
            await chmod(path, 0o600);
          }
        }
        if (id === 'answer.escalation') {
          if (services.main?.escalation) {
            const runtime = services.main.escalation;
            const previous = (await runtime.snapshot()).enabled;
            rollback = () => runtime.configure({ enabled: previous });
            await runtime.configure({ enabled });
          }
          else {
            const store = createSettingsStore(join(stateDirectory, 'escalation', 'settings.json'), RuntimeSettingsSchema, runtimeDefaults(ESCALATION_FALLBACK));
            if (store.error()) throw new Error(store.error()!);
            const previous = store.read().enabled;
            rollback = async () => store.update({ enabled: previous });
            store.update({ enabled });
          }
        }
        if (id === 'answer.quietChildren') {
          if (services.main?.quiet) {
            const runtime = services.main.quiet;
            const previous = (await runtime.snapshot()).enabled;
            rollback = () => runtime.configure({ enabled: previous });
            await runtime.configure({ enabled });
          }
          else {
            const store = createSettingsStore(join(stateDirectory, 'quiet-children', 'settings.json'), QuietSettingsSchema, quietDefaults(QUIET_FALLBACK));
            if (store.error()) throw new Error(store.error()!);
            const previous = store.read().enabled;
            rollback = async () => store.update({ enabled: previous });
            store.update({ enabled });
          }
        }
        await patchMachineConfig(machine.path, raw => ({
          ...raw,
          modules: { ...(raw.modules && typeof raw.modules === 'object' ? raw.modules as Record<string, unknown> : {}), [id]: enabled },
        }));
        committed = true;
        const result = await buildSettingsSnapshot();
        // 响应先发送，再通过守护进程重载当前插件；重载会关闭此子进程。
        setTimeout(() => {
          const reload = options.reload ?? (async () => (await services.daemon.ready()).client.reloadPlugin(MAIN_PLUGIN_ID));
          void Promise.resolve().then(reload).catch(error => console.error('插件自动重载失败', error)).finally(() => { reloadPending = false; });
        }, 500);
        return result;
      } catch (error) {
        if (!committed && rollback) {
          try { await rollback(); } catch { throw new Error('保存失败且功能状态回滚失败，请检查配置'); }
        }
        throw error;
      }
    })();
    return run.catch(error => { reloadPending = false; throw error; });
  });

  let pauseQueue: Promise<unknown> = Promise.resolve();

  server.handle(machineSettingsPauseAll, ({ paused }) => {
    const run = pauseQueue.then(async () => {
      const main = services.main;
      if (!main) throw new Error('主实例服务不可用');

      const prev = await readPauseAllState(stateDirectory);
      if (paused && prev.paused) {
        return { paused: true };
      }
      const reuseSaved = Boolean(prev.paused || prev.inProgress);
      const saved: NonNullable<PauseAllState['saved']> = paused
        ? reuseSaved
          ? { ...(prev.saved ?? {}) }
          : {}
        : { ...(prev.saved ?? {}) };
      const rollbacks: Array<() => Promise<void>> = [];
      const persistProgress = () =>
        writePauseAllState(stateDirectory, { paused: prev.paused, inProgress: true, saved });

      const isRunning = (id: string, defaultEnabled: boolean) =>
        typeof main.isModuleRunning === 'function'
          ? main.isModuleRunning(id, machine, defaultEnabled)
          : isModuleEnabled(machine, id, defaultEnabled);

      try {
        if (isRunning('todo.stalled', true)) {
          const before = Boolean(main.stalledPaused);
          if (paused) {
            if (saved.stalledPaused === undefined) saved.stalledPaused = before;
            await persistProgress();
            main.stalledPaused = true;
            main.invalidateStalledCache?.();
            rollbacks.push(async () => {
              main.stalledPaused = saved.stalledPaused ?? before;
              main.invalidateStalledCache?.();
            });
          } else if (saved.stalledPaused !== undefined) {
            main.stalledPaused = saved.stalledPaused;
            main.invalidateStalledCache?.();
          } else {
            main.stalledPaused = false;
            main.invalidateStalledCache?.();
          }
        }

        if (isRunning('answer.presence', true)) {
          const pres = await main.readyPresence();
          const current = pres.snapshot().settings;
          if (paused) {
            if (saved.presencePaused === undefined) saved.presencePaused = current.paused;
            await persistProgress();
            await pres.configure({ ...current, paused: true });
            const restorePaused = saved.presencePaused;
            rollbacks.push(async () => {
              await pres.configure({ ...pres.snapshot().settings, paused: restorePaused });
            });
          } else if (saved.presencePaused !== undefined) {
            await pres.configure({ ...current, paused: saved.presencePaused });
          }
        }

        if (main.escalation) {
          const esc = main.escalation;
          const snap = await esc.snapshot();
          if (paused) {
            if (saved.escalationEnabled === undefined) saved.escalationEnabled = snap.enabled;
            await persistProgress();
            await esc.configure({ enabled: false });
            const restoreEnabled = saved.escalationEnabled;
            rollbacks.push(async () => {
              await esc.configure({ enabled: restoreEnabled });
            });
          } else if (saved.escalationEnabled !== undefined) {
            await esc.configure({ enabled: saved.escalationEnabled });
          }
        }

        if (main.quiet) {
          const quiet = main.quiet;
          const snap = await quiet.snapshot();
          if (paused) {
            if (saved.quietEnabled === undefined) saved.quietEnabled = snap.enabled;
            await persistProgress();
            await quiet.configure({ enabled: false });
            const restoreEnabled = saved.quietEnabled;
            rollbacks.push(async () => {
              await quiet.configure({ enabled: restoreEnabled });
            });
          } else if (saved.quietEnabled !== undefined) {
            await quiet.configure({ enabled: saved.quietEnabled });
          }
        }

        if (isRunning('github', true)) {
          const gh = await main.github();
          const prefs = gh.storage.state.preferences;
          if (paused) {
            if (saved.githubEnabled === undefined) saved.githubEnabled = prefs.enabled;
            await persistProgress();
            if (prefs.enabled) {
              await gh.preferences({ ...prefs, enabled: false });
              rollbacks.push(async () => {
                const cur = gh.storage.state.preferences;
                await gh.preferences({ ...cur, enabled: true });
              });
            }
          } else if (saved.githubEnabled !== undefined) {
            if (prefs.enabled !== saved.githubEnabled) {
              await gh.preferences({ ...prefs, enabled: saved.githubEnabled });
            }
          }
        }

        if (isRunning('answer.automation', true)) {
          const auto = await main.readyAutomation();
          if (paused) {
            const before = auto.snapshot().paused;
            if (saved.automationPaused === undefined) saved.automationPaused = before;
            await persistProgress();
            await auto.pause(true);
            const restorePaused = saved.automationPaused;
            rollbacks.push(async () => {
              await auto.pause(restorePaused);
            });
          } else if (saved.automationPaused !== undefined) {
            await auto.pause(saved.automationPaused);
          }
        }
      } catch (error) {
        let rollbackFailed = false;
        if (paused && rollbacks.length > 0) {
          const results = await Promise.allSettled([...rollbacks].reverse().map(fn => fn()));
          rollbackFailed = results.some(r => r.status === 'rejected');
        }
        if (paused && !prev.paused && !prev.inProgress && !rollbackFailed) {
          await writePauseAllState(stateDirectory, { paused: false });
        } else {
          await writePauseAllState(stateDirectory, {
            paused: prev.paused,
            ...(prev.inProgress || rollbackFailed ? { inProgress: true } : {}),
            ...(Object.keys(saved).length > 0 ? { saved } : {}),
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`暂停或恢复自动化失败：${msg}`);
      }

      await writePauseAllState(stateDirectory, paused ? { paused: true, saved } : { paused: false });
      return { paused };
    });
    pauseQueue = run.catch(() => {});
    return run;
  });

  server.handle(machineSettingsExportBackup, () => exportMachineBackup(baseDirectory));
}
