import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { AgentDefaultsSchema, defaultsSave, defaultsSnapshot, type AgentDefaultRule } from '../../shared/defaults.ts';
import {
  machineSettingsExportBackup,
  machineSettingsPauseAll,
  machineSettingsSnapshot,
  machineSettingsToggleModule,
} from '../../shared/machine-settings.ts';
import type { LoadedMachineConfig } from './machine-config.ts';
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
      errors: [...machine.errors],
      modules: MODULE_DEFS.map(def => {
        const enabled = Boolean(rawModules[def.id] ?? machine.modules[def.id] ?? def.defaultEnabled);
        const live = liveById.get(def.id);
        const state = live ? live.state : (enabled ? ('running' as const) : ('off' as const));
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
    };
  };

  server.handle(machineSettingsSnapshot, () => buildSettingsSnapshot());

  server.handle(machineSettingsToggleModule, async ({ id, enabled }) => {
    await patchMachineConfig(machine.path, raw => ({
      ...raw,
      modules: {
        ...(raw.modules && typeof raw.modules === 'object' ? (raw.modules as Record<string, unknown>) : {}),
        [id]: enabled,
      },
    }));
    return buildSettingsSnapshot();
  });

  let pauseQueue: Promise<unknown> = Promise.resolve();

  server.handle(machineSettingsPauseAll, ({ paused }) => {
    const run = pauseQueue.then(async () => {
      const main = services.main;
      if (!main) throw new Error('主实例服务不可用');

      const prev = await readPauseAllState(stateDirectory);
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
        if (paused && !prev.paused && !rollbackFailed) {
          await writePauseAllState(stateDirectory, { paused: false });
        } else {
          await writePauseAllState(stateDirectory, {
            paused: prev.paused,
            ...(rollbackFailed ? { inProgress: true } : {}),
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
