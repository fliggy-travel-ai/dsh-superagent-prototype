import { join } from 'node:path';
import * as rpc from '../../../shared/escalation.ts';
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { createSettingsStore } from '../../core/settings-store.ts';
import { startWithRetry } from '../../core/start-retry.ts';
import { summarizeError } from '../../core/modules.ts';
import { isMainInstance, type Module } from '../types.ts';
import { ESCALATION_FALLBACK, EscalationSectionSchema, RuntimeSettingsSchema, runtimeDefaults, type EscalationSection } from './config.ts';
import { migrateLegacyEscalation } from './migrate.ts';
import { EscalationRuntime } from './runtime.ts';

const LEGACY_PLUGIN = 'event-notifications';

/**
 * 升级通知：主会话（置顶工作区中的会话）的提问和错误按时段规则送到 Grok webhook，
 * 新建项目和工作区也通知，另有额度报警。默认关闭，打开后默认影子模式（只记录，不投递）。
 * 与代答（answer.presence）是两套独立规则：同一道题可能先被代答，之后仍被升级。
 * 替代旧插件 event-notifications（停旧开新；旧插件仍启用时强制影子模式）。
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
    // 旧插件仍在运行时它的状态还在变，复制过来没有意义，切实际发送后还可能重复发 Grok：不复制。
    // 切到实际发送前（beforeLive）再试一次，只复制不覆盖。
    const copyLegacy = () => {
      if (legacy.enabled) return;
      const migration = migrateLegacyEscalation(legacyDirectory, directory);
      if (migration.report.copied.length) console.error(`[开发自动化·升级通知] 已复制旧状态：${migration.report.copied.join('、')}。旧文件未改动。${migration.notes.join('')}`);
    };
    copyLegacy();
    const runtime = new EscalationRuntime({
      server,
      daemon: services.daemon,
      roles: sessionRoles(services.home),
      directory,
      machineName: context.machine.machine ?? 'local',
      section: config,
      settings: createSettingsStore(join(directory, 'settings.json'), RuntimeSettingsSchema, runtimeDefaults(config)),
      beforeLive: copyLegacy,
      ...(legacy.enabled ? { forceShadow: `${legacy.problem ?? `旧插件 ${LEGACY_PLUGIN} 仍启用`}，已强制影子模式。先停用旧插件，再切换到实际发送。` } : {}),
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
    return async () => { lifetime.abort(); await runtime.stop(); };
  },
};
