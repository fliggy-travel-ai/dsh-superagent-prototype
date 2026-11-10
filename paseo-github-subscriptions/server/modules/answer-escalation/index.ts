import { join } from 'node:path';
import * as rpc from '../../../shared/escalation.ts';
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { createSettingsStore } from '../../core/settings-store.ts';
import { startWithRetry } from '../../core/start-retry.ts';
import { summarizeError } from '../../core/modules.ts';
import { isMainInstance, type Module } from '../types.ts';
import { ESCALATION_FALLBACK, EscalationSectionSchema, RuntimeSettingsSchema, runtimeDefaults, shadowNotice, type EscalationSection } from './config.ts';
import { migrateLegacyEscalation } from './migrate.ts';
import { EscalationRuntime } from './runtime.ts';

const LEGACY_PLUGIN = 'event-notifications';

/**
 * 升级通知：主会话（置顶工作区中的会话）的提问和错误按时段规则送到 Grok webhook，
 * 新建项目和工作区也通知，另有额度报警。默认关闭。只有实际发送（影子模式已删除）。
 * 与代答（answer.presence）是两套独立规则：同一道题可能先被代答，之后仍被升级。
 * 替代旧插件 event-notifications（停旧开新；旧插件仍启用时本模块不启动、不发送）。
 */
export const escalationModule: Module<EscalationSection> = {
  id: 'answer.escalation',
  label: '升级通知',
  defaultEnabled: false,
  appliesTo: isMainInstance,
  config: { section: 'escalation', spec: { schema: EscalationSectionSchema, fallback: ESCALATION_FALLBACK } },
  register(context) {
    const { server, config, services } = context;
    const directory = join(context.stateDirectory, 'escalation');
    const legacyDirectory = config.legacyDirectory ?? join(services.home, LEGACY_PLUGIN);
    const legacy = legacyPluginStatus(services.home, LEGACY_PLUGIN);
    // 旧插件仍在运行时它的状态还在变，复制过来没有意义：不复制。停用旧插件后重载才复制，只复制不覆盖。
    if (!legacy.enabled) {
      const migration = migrateLegacyEscalation(legacyDirectory, directory);
      if (migration.report.copied.length) console.error(`[开发自动化·升级通知] 已复制旧状态：${migration.report.copied.join('、')}。旧文件未改动。${migration.notes.join('')}`);
    }
    const settings = createSettingsStore(join(directory, 'settings.json'), RuntimeSettingsSchema, runtimeDefaults(config));
    const shadow = shadowNotice(config, settings.read() as { delivery?: string });
    if (shadow) console.error(`[开发自动化·升级通知] ${shadow}`);
    const machineOwnerOnly = (context.machine as { ownerOnly?: { localKeywords?: string[] } }).ownerOnly;
    const runtime = new EscalationRuntime({
      server,
      daemon: services.daemon,
      roles: sessionRoles(services.home),
      directory,
      machineName: context.machine.machine ?? 'local',
      section: config,
      settings,
      localKeywords: () =>
        config.ownerOnly?.localKeywords ??
        machineOwnerOnly?.localKeywords ??
        services.main?.ownerOnlyKeywords ??
        undefined!,
      presence: () => {
        const obs = services.main?.presence?.snapshot().observation;
        return obs ? { mode: obs.mode, source: obs.source } : null;
      },
      ...(legacy.enabled ? { blocked: `${legacy.problem ?? `旧插件“会话事件通知”（${LEGACY_PLUGIN}）仍启用`}。本模块不发送，以免同一事件发两次；停用旧插件后重载本插件。` } : {}),
    });
    const lifetime = new AbortController();
    void startWithRetry(() => runtime.start().catch(error => { runtime.markFailed(error); throw error; }), {
      delayMs: 60_000,
      signal: lifetime.signal,
      onError: error => console.error(`[开发自动化·升级通知] 启动失败，60 秒后重试：${summarizeError(error)}`),
    });

    server.handle(rpc.escalationSnapshot, async () => runtime.snapshot());
    server.handle(rpc.escalationConfigure, async input => runtime.configure(input));
    server.handle(rpc.escalationTestWebhook, async () => runtime.testWebhook());
    server.handle(rpc.escalationWebhookConfigure, async input => runtime.configureWebhook(input));
    server.handle(rpc.escalationAcknowledge, async ({ id }) => ({ ok: runtime.acknowledge(id) }));
    if (services.main) services.main.escalation = runtime;
    return async () => {
      if (services.main?.escalation === runtime) services.main.escalation = null;
      lifetime.abort();
      await runtime.stop();
    };
  },
};
