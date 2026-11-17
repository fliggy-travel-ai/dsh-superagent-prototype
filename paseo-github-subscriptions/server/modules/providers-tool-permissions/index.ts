import { isMainInstance, type Module } from '../types.ts';
import { ToolPermissionRuntime, type PermissionAgent } from './runtime.ts';

export const toolPermissionsModule: Module = {
  id: 'providers.toolPermissions',
  label: '工具权限自动批准',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register({ server, services }) {
    const runtime = new ToolPermissionRuntime({
      async list() {
        const { client } = await services.daemon.ready();
        const agents: PermissionAgent[] = [];
        let cursor: string | undefined;
        do {
          const result = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
          agents.push(...result.entries.map(entry => entry.agent));
          const next = result.pageInfo.nextCursor;
          if (!result.pageInfo.hasMore || !next || next === cursor) break;
          cursor = next;
        } while (cursor);
        return agents;
      },
      async refresh(agentId) {
        const { paseo } = await services.daemon.ready();
        return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
      },
      async approve(agentId, requestId) {
        const connection = await services.daemon.ready();
        await connection.approve(agentId, requestId);
        console.info(`[工具权限自动批准] 已批准会话 ${agentId} 的请求 ${requestId}`);
      },
      failed(agentId, requestId) {
        console.error(`[工具权限自动批准] 会话 ${agentId} 的请求 ${requestId} 批准失败，稍后重试`);
      },
    });
    const scan = () => runtime.scan().catch(() => {
      console.error('[工具权限自动批准] 无法读取待批准请求，稍后重试');
    });
    const remove = server.addHook('agent.permission.before', async () => { await scan(); });
    const timer = setInterval(() => { void scan(); }, 5000);
    timer.unref();
    void scan();
    return async () => {
      remove();
      clearInterval(timer);
      await runtime.stop();
    };
  },
};
