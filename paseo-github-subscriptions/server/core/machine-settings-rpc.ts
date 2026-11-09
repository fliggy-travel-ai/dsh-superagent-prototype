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
  { id: 'usage.claudeAccounts', label: 'Claude 账号与额度', defaultEnabled: false },
  { id: 'usage.providerQuotas', label: '其他 Provider 额度', defaultEnabled: false },
  { id: 'providers.antigravity', label: 'Antigravity 多账号', defaultEnabled: false },
  { id: 'github', label: 'GitHub 订阅', defaultEnabled: true },
  { id: 'todo.stalled', label: '停滞会话检查', defaultEnabled: true },
] as const;

interface PauseAllState {
  paused: boolean;
  saved?: {
    automationPaused?: boolean;
    presencePaused?: boolean;
    githubEnabled?: boolean;
    escalationEnabled?: boolean;
    quietEnabled?: boolean;
  };
}

async function readPauseAllState(stateDirectory: string): Promise<PauseAllState> {
  try {
    const raw = JSON.parse(await readFile(join(stateDirectory, 'pause-all.json'), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.paused === 'boolean') {
      return {
        paused: raw.paused,
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

  server.handle(machineSettingsPauseAll, async ({ paused }) => {
    const main = services.main;
    if (!main) throw new Error('主实例服务不可用');

    const prev = await readPauseAllState(stateDirectory);
    const saved: NonNullable<PauseAllState['saved']> = { ...(prev.saved ?? {}) };
    const tasks: Array<Promise<void>> = [];

    if (isModuleEnabled(machine, 'answer.automation', true)) {
      tasks.push(
        (async () => {
          const auto = await main.readyAutomation();
          if (paused) {
            if (!prev.paused) saved.automationPaused = auto.snapshot().paused;
            await auto.pause(true);
          } else {
            await auto.pause(saved.automationPaused ?? false);
          }
        })(),
      );
    }

    if (isModuleEnabled(machine, 'answer.presence', true)) {
      tasks.push(
        (async () => {
          const pres = await main.readyPresence();
          const current = pres.snapshot().settings;
          if (paused) {
            if (!prev.paused) saved.presencePaused = current.paused;
            await pres.configure({ ...current, paused: true });
          } else {
            await pres.configure({ ...current, paused: saved.presencePaused ?? false });
          }
        })(),
      );
    }

    if (isModuleEnabled(machine, 'github', true)) {
      tasks.push(
        (async () => {
          const gh = await main.github();
          const prefs = gh.storage.state.preferences;
          if (paused) {
            if (!prev.paused) saved.githubEnabled = prefs.enabled;
            if (prefs.enabled) {
              await gh.preferences({ ...prefs, enabled: false });
            }
          } else {
            const wantEnabled = saved.githubEnabled ?? prefs.enabled;
            if (prefs.enabled !== wantEnabled) {
              await gh.preferences({ ...prefs, enabled: wantEnabled });
            }
          }
        })(),
      );
    }

    if (main.escalation) {
      const esc = main.escalation;
      tasks.push(
        (async () => {
          const snap = await esc.snapshot();
          if (paused) {
            if (!prev.paused) saved.escalationEnabled = snap.enabled;
            await esc.configure({ enabled: false });
          } else {
            await esc.configure({ enabled: saved.escalationEnabled ?? true });
          }
        })(),
      );
    }

    if (main.quiet) {
      const quiet = main.quiet;
      tasks.push(
        (async () => {
          const snap = await quiet.snapshot();
          if (paused) {
            if (!prev.paused) saved.quietEnabled = snap.enabled;
            await quiet.configure({ enabled: false });
          } else {
            await quiet.configure({ enabled: saved.quietEnabled ?? true });
          }
        })(),
      );
    }

    const settled = await Promise.allSettled(tasks);
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    if (errors.length > 0) {
      throw new Error(`暂停或恢复自动化失败：${errors.join('；')}`);
    }

    await writePauseAllState(stateDirectory, paused ? { paused: true, saved } : { paused: false });
    return { paused };
  });

  server.handle(machineSettingsExportBackup, () => exportMachineBackup(baseDirectory));
}
