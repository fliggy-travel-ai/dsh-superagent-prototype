import { join } from 'node:path';
import { StalledRuntime } from '../../stalled.ts';
import { stalledPort } from '../../stalled-port.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { EscalationRecords } from '../answer-escalation/records.ts';
import { HandledRecords } from '../answer-quiet-children/handled.ts';
import { TodoRuntime } from '../../todo.ts';
import { TodoActionOutputSchema, TodoLocalSnapshotSchema, todoAct, todoList, todoLocal } from '../../../shared/todo.ts';
import { defaultsSave, defaultsSnapshot, AgentDefaultsSchema, type AgentDefaultRule } from '../../../shared/defaults.ts';
import {
  machineSettingsExportBackup,
  machineSettingsPauseAll,
  machineSettingsSnapshot,
  machineSettingsToggleModule,
} from '../../../shared/machine-settings.ts';
import { exportMachineBackup, patchMachineConfig, readRawMachineConfig } from '../../core/machine-writer.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

const RELOAD_MODULES = new Set([
  'providers.cloudSession',
  'providers.antigravity',
  'usage.claudeAccounts',
  'usage.providerQuotas',
]);

/** 待办汇总与全局机器设置：本机与跨主机待办合看、处理记录、模块配置与备份。 */
export const todoModule: Module = {
  id: 'todo',
  label: '待办汇总',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server, machine, baseDirectory } = context;
    const services = mainOf(context);
    let stalled: StalledRuntime | null = null;
    let pausedAll = false;

    const getStalled = async () => {
      await Promise.all([services.readyPresence(), services.github()]);
      const connection = await context.services.daemon.ready();
      stalled ??= new StalledRuntime(
        stalledPort(
          connection.client,
          services.presenceHosts!,
          () =>
            services.runtime!.storage.state.preferences.enabled && !services.runtime!.storage.state.preferences.shadow
              ? services.runtime!.storage.state.subscriptions
                  .filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now())
                  .map(subscription => subscription.agentId)
              : [],
          sessionRoles(context.services.home),
        ),
      );
      return stalled.snapshot();
    };

    const runtime = new TodoRuntime({
      async selfHost() {
        const presence = await services.readyPresence().catch(() => null);
        const snap = presence?.snapshot();
        const first = snap?.hosts[0];
        return {
          id: first?.id ?? 'local',
          name: snap?.hostName || first?.name || machine.machine || '本机',
        };
      },
      async hosts() {
        const presence = await services.readyPresence();
        return presence.snapshot().hosts;
      },
      async presence() {
        return (await services.readyPresence()).snapshot();
      },
      async browser() {
        return (await services.readyBrowser()).snapshot();
      },
      async stalled() {
        return getStalled();
      },
      async escalationPending() {
        return new EscalationRecords(join(context.stateDirectory, 'escalation', 'records.json')).pending();
      },
      async quietHandled() {
        return new HandledRecords(join(context.stateDirectory, 'quiet-children', 'handled.json')).recent(20);
      },
      async remoteLocal(hostId) {
        await services.readyPresence();
        const raw = await services.presenceHosts!.invoke(hostId, 'todo.local', {});
        return TodoLocalSnapshotSchema.parse(raw);
      },
      async remoteAct(hostId, input) {
        await services.readyPresence();
        const raw = await services.presenceHosts!.invoke(hostId, 'todo.act', input);
        return TodoActionOutputSchema.parse(raw);
      },
      async answerQuestion(input) {
        return (await services.readyPresence()).answer(input);
      },
      async markQuestionRead(input) {
        return (await services.readyPresence()).markRead(input);
      },
      async acknowledgeEscalation(id) {
        return new EscalationRecords(join(context.stateDirectory, 'escalation', 'records.json')).acknowledge(id);
      },
    });

    server.handle(todoLocal, () => runtime.local());
    server.handle(todoList, () => runtime.list());
    server.handle(todoAct, input => runtime.act(input));

    // 当 providers.defaults 默认关闭而未在启动时注册时，由本模块提供规则读取与保存入口
    if (machine.modules['providers.defaults'] !== true) {
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
      const raw = await readRawMachineConfig(machine.path).catch(() => ({ version: 1 } as Record<string, unknown>));
      const rawModules = raw.modules && typeof raw.modules === 'object' ? (raw.modules as Record<string, boolean>) : {};
      const defs = [
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
      ];
      return {
        configPath: machine.path,
        source: machine.source,
        machine: (typeof raw.machine === 'string' ? raw.machine : machine.machine) ?? null,
        errors: [...machine.errors],
        modules: defs.map(def => {
          const enabled = rawModules[def.id] ?? machine.modules[def.id] ?? def.defaultEnabled;
          return {
            id: def.id,
            label: def.label,
            enabled: Boolean(enabled),
            state: enabled ? ('running' as const) : ('off' as const),
            reloadRequired: RELOAD_MODULES.has(def.id),
          };
        }),
        pausedAll,
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
      pausedAll = paused;
      await Promise.allSettled([
        services.readyAutomation().then(auto => auto.pause(paused)),
        services.readyPresence().then(pres => pres.configure({ ...pres.snapshot().settings, paused })),
        services.github().then(gh => gh.preferences({ ...gh.storage.state.preferences, enabled: !paused })),
      ]);
      return { paused: pausedAll };
    });
    server.handle(machineSettingsExportBackup, () => exportMachineBackup(baseDirectory));
  },
};
