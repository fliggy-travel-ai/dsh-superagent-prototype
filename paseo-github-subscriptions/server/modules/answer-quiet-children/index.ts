import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import * as rpc from '../../../shared/quiet.ts';
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { createSettingsStore } from '../../core/settings-store.ts';
import type { RoleAgent } from '../../core/session-roles.ts';
import { isMainInstance, type Module } from '../types.ts';
import { QUIET_FALLBACK, QuietSectionSchema, QuietSettingsSchema, quietDefaults, type QuietSection } from './config.ts';
import { createMainResolver } from './resolver.ts';
import { QuietRuntime } from './runtime.ts';

/** 本机未归档会话，按角色判定需要的字段。 */
async function listAgents(daemon: { ready(): Promise<{ client: { fetchAgents(options: unknown): Promise<{ entries: Array<{ agent: Record<string, unknown> }>; pageInfo: { hasMore: boolean; nextCursor?: string | null } }> } }> }): Promise<RoleAgent[]> {
  const { client } = await daemon.ready();
  const agents: RoleAgent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await client.fetchAgents({ filter: { includeArchived: false }, page: { limit: 100, cursor }, timeout: 15_000 });
    for (const { agent } of result.entries) {
      agents.push({ id: String(agent.id), workspaceId: (agent.workspaceId as string | null | undefined) ?? null, status: agent.status as string | undefined, archivedAt: agent.archivedAt as string | null | undefined, updatedAt: agent.updatedAt as string | undefined, labels: agent.labels as Record<string, string> | undefined });
    }
    if (!result.pageInfo.hasMore) return agents;
    if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  throw new Error('会话清单未完整返回');
}

/**
 * 子会话免提醒和事件转发。主会话 = 置顶工作区中的会话；其他会话完成或出错时不打扰用户，
 * 需要接续的事件转给主会话。替代旧插件 subsession-quiet 和 event-notifications 中的转发部分。
 */
export const quietChildrenModule: Module<QuietSection> = {
  id: 'answer.quietChildren',
  label: '子会话免提醒',
  defaultEnabled: false,
  appliesTo: isMainInstance,
  config: { section: 'quietChildren', spec: { schema: QuietSectionSchema, fallback: QUIET_FALLBACK } },
  register(context) {
    const { server, config, services } = context;
    const directory = join(context.stateDirectory, 'quiet-children');
    const roles = sessionRoles(services.home);
    const resolveLocal = createMainResolver({ list: () => listAgents(services.daemon as never), roles });
    const forwarder = legacyPluginStatus(services.home, config.legacyForwarderId);
    const runtime = new QuietRuntime({
      server: server as PluginServerContext,
      daemon: services.daemon,
      roles,
      directory,
      machineName: context.machine.machine ?? 'local',
      settings: createSettingsStore(join(directory, 'settings.json'), QuietSettingsSchema, quietDefaults(config)),
      resolveLocal,
      ...(forwarder.enabled ? { forwardBlocked: `${forwarder.problem ?? `旧插件 ${config.legacyForwarderId} 仍启用`}，事件转发已关闭。先停用旧插件，再打开事件转发。` } : {}),
    });
    runtime.start();
    if (services.main) services.main.quiet = runtime;
    server.handle(rpc.quietSnapshot, async () => runtime.snapshot());
    server.handle(rpc.quietConfigure, async input => runtime.configure(input));
    // 对方主机转发子会话事件时，用这个接口重新确认“现任主会话”。
    server.handle(rpc.quietResolveMain, async input => resolveLocal({ parentId: input.parentAgentId, parentWorkspaceId: input.parentWorkspaceId ?? null }));
    return () => {
      if (services.main?.quiet === runtime) services.main.quiet = null;
      return runtime.stop();
    };
  },
};
