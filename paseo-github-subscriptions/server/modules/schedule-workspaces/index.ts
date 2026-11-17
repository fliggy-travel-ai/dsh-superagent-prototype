import { isMainInstance, type Module } from '../types.ts';
import { scheduledWorkspace, syncScheduleWorkspace } from './sync.ts';
import { summarizeError } from '../../core/modules.ts';

export const scheduleWorkspacesModule: Module = {
  id: 'schedules.workspaces', label: '定时任务工作区', defaultEnabled: true, appliesTo: isMainInstance,
  register(context) {
    const completed = new Set<string>();
    let stopped = false;
    let queue: Promise<void> = Promise.resolve();
    const report = (error: unknown) => console.error(`[定时任务工作区] ${summarizeError(error)}`);
    const processAgent = async (id: string) => {
      if (stopped) return;
      const { client } = await context.services.daemon.ready();
      const agent = (await client.fetchAgent(id))?.agent;
      const target = agent && scheduledWorkspace(agent);
      if (!agent || !target || completed.has(target.workspaceId) || stopped) return;
      const done = await syncScheduleWorkspace({
        schedule: async scheduleId => (await client.scheduleInspect({ id: scheduleId })).schedule,
        workspace: async workspaceId => {
          let cursor: string | undefined;
          do {
            const page = await client.fetchWorkspaces({ includeBackground: true, page: { limit: 100, cursor } });
            const found = page.entries.find(workspace => workspace.id === workspaceId);
            if (found) return found;
            if (!page.pageInfo.hasMore) return null;
            if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('工作区列表不完整');
            cursor = page.pageInfo.nextCursor;
          } while (!stopped);
          return null;
        },
        rename: (workspaceId, title) => stopped ? Promise.resolve() : client.setWorkspaceTitle(workspaceId, title),
        pin: workspaceId => stopped ? Promise.resolve() : client.setWorkspacePinned(workspaceId, true),
      }, agent);
      if (done && !stopped) completed.add(target.workspaceId);
    };
    const enqueue = (id: string) => {
      queue = queue.then(() => processAgent(id)).catch(report);
      return queue;
    };
    const removeCreated = context.server.addHook('agent.create.after', async ({ agent }) => {
      if (!agent.parentAgentId && agent.workspaceId && !completed.has(agent.workspaceId)) void enqueue(agent.id);
    });
    const startup = (async () => {
      const { client } = await context.services.daemon.ready();
      let cursor: string | undefined;
      do {
        if (stopped) return;
        const page = await client.fetchAgents({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
        for (const { agent } of page.entries) {
          if (scheduledWorkspace(agent)) await enqueue(agent.id);
        }
        if (!page.pageInfo.hasMore) return;
        if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('会话列表不完整');
        cursor = page.pageInfo.nextCursor;
      } while (!stopped);
    })().catch(report);
    return async () => {
      stopped = true;
      removeCreated();
      await startup;
      await queue;
    };
  },
};
