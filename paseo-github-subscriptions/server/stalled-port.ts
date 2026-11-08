import type { DaemonClient, FetchAgentTimelineCursor } from '@getpaseo/client/internal/daemon-client';
import type { PresenceHosts } from './presence-port.ts';
import type { StalledAgent, StalledPort } from './stalled.ts';
import { SnapshotSchema } from '../shared/model.ts';

async function list(client: DaemonClient, hostId: string): Promise<StalledAgent[]> {
  const agents: StalledAgent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await client.fetchAgents({ filter: { includeArchived: false }, page: { limit: 100, cursor }, timeout: 15_000 });
    agents.push(...result.entries.map(entry => ({ ...entry.agent, hostId })));
    if (!result.pageInfo.hasMore) return agents;
    if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  throw new Error('会话清单未完整返回，暂不判定停滞。');
}

export function stalledPort(origin: DaemonClient, hosts: PresenceHosts, githubListeners: () => string[]): StalledPort {
  const hostId = () => origin.getLastServerInfoMessage()!.serverId;
  const onHost = <T>(id: string, operation: (client: DaemonClient) => Promise<T>): Promise<T> => id === hostId() ? operation(origin) : hosts.withHost(id, operation);
  return {
    async collect() {
      const directory = await origin.listHosts();
      const enabled = directory.hosts.filter(host => host.enabled && host.serverId);
      if (enabled.some(host => host.status !== 'online')) throw new Error('有来源主机离线，无法确认跨主机子会话，暂不判定停滞。');
      const listeners = new Set(githubListeners().map(id => `${hostId()}:${id}`));
      const pages = await Promise.all([directory.self.serverId, ...enabled.map(host => host.serverId!)].map(id => onHost(id, async client => {
        const [agents, schedules, subscriptions] = await Promise.all([list(client, id), client.scheduleList(), id === hostId() ? null : client.invokePluginRpc('github-subscriptions', 'subscriptions.snapshot', {}).then(value => SnapshotSchema.parse(value))]);
        const now = Date.now();
        if (subscriptions?.preferences.enabled && !subscriptions.preferences.shadow) {
          for (const subscription of subscriptions.subscriptions) if (!subscription.expiresAt || Date.parse(subscription.expiresAt) > now) listeners.add(`${id}:${subscription.agentId}`);
        }
        for (const schedule of schedules.schedules) {
          if (schedule.status === 'active' && schedule.target.type === 'agent' && schedule.nextRunAt && (!schedule.expiresAt || Date.parse(schedule.expiresAt) > now)) listeners.add(`${id}:${schedule.target.agentId}`);
        }
        return agents;
      }).catch(error => {
        const name = id === directory.self.serverId ? '本机' : enabled.find(host => host.serverId === id)?.label || id;
        throw new Error(`读取主机“${name}”的工作状态失败：${error instanceof Error ? error.message : String(error)}`);
      })));
      return { hostId: hostId(), agents: pages.flat(), listeners };
    },
    async subagents(agent) {
      return onHost(agent.hostId, async client => {
        const result = await client.listProviderSubagents(agent.id, { timeout: 15_000 });
        if (result.error) throw new Error(result.error);
        return result.subagents.some(child => child.status === 'running');
      });
    },
    async message(agent) {
      let cursor: FetchAgentTimelineCursor | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await origin.fetchAgentTimeline(agent.id, { direction: cursor ? 'before' : 'tail', cursor, limit: 100, projection: 'projected', timeout: 5000 });
        if (result.error || result.staleCursor || result.gap) throw new Error(result.error || '时间线发生变化，请重试');
        for (const entry of [...result.entries].reverse()) if (entry.item.type === 'assistant_message') return entry.item.text.slice(0, 2000);
        if (!result.hasOlder) return null;
        if (!result.startCursor || JSON.stringify(result.startCursor) === JSON.stringify(cursor)) break;
        cursor = result.startCursor;
      }
      throw new Error('最近时间线未找到助手消息，请打开会话查看');
    },
    async current(agent) {
      const result = await origin.fetchAgent(agent.id);
      return result?.agent ? { ...result.agent, hostId: agent.hostId } : null;
    },
  };
}
