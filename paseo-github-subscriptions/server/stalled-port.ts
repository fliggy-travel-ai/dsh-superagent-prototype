import type { DaemonClient, FetchAgentTimelineCursor } from '@getpaseo/client/internal/daemon-client';
import type { PresenceHosts } from './presence-port.ts';
import type { StalledAgent, StalledPort } from './stalled.ts';
import type { StalledHostTimings } from '../shared/stalled.ts';
import { SnapshotSchema, type Snapshot } from '../shared/model.ts';
import { isMainSession, type RolesReader } from './core/session-roles.ts';

/** 远端主机会话清单、定时任务与订阅快照的常规缓存有效期（45 秒）。 */
export const REMOTE_COLLECT_CACHE_TTL_MS = 45_000;
/** 远端主机离线或暂时不可达时，允许沿用最近一次缓存的过期上限（60 秒）；超过上限仍离线则报错不判定停滞。 */
export const REMOTE_COLLECT_OFFLINE_MAX_AGE_MS = 60_000;

export interface StalledPortOptions {
  now?: () => number;
  remoteCacheTtlMs?: number;
  remoteOfflineMaxAgeMs?: number;
}

interface RemoteCacheEntry {
  at: number;
  agents: StalledAgent[];
  schedules: Awaited<ReturnType<DaemonClient['scheduleList']>>['schedules'];
  subscriptions: Snapshot | null;
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;
const isWorking = (agent: StalledAgent) =>
  ['running', 'initializing'].includes(agent.status) ||
  Boolean(agent.activeTurn) ||
  Boolean(agent.pendingPermissions?.length);

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

function applyListeners(
  id: string,
  schedules: RemoteCacheEntry['schedules'],
  subscriptions: Snapshot | null,
  nowMs: number,
  listeners: Set<string>,
) {
  if (subscriptions?.preferences.enabled && !subscriptions.preferences.shadow) {
    for (const subscription of subscriptions.subscriptions) {
      if (!subscription.expiresAt || Date.parse(subscription.expiresAt) > nowMs) {
        listeners.add(`${id}:${subscription.agentId}`);
      }
    }
  }
  for (const schedule of schedules) {
    if (
      schedule.status === 'active' &&
      schedule.target.type === 'agent' &&
      schedule.nextRunAt &&
      (!schedule.expiresAt || Date.parse(schedule.expiresAt) > nowMs)
    ) {
      listeners.add(`${id}:${schedule.target.agentId}`);
    }
  }
}

export function stalledPort(
  origin: DaemonClient,
  hosts: PresenceHosts,
  githubListeners: () => string[],
  roles: RolesReader,
  options: StalledPortOptions = {},
): StalledPort {
  const now = options.now ?? Date.now;
  const remoteCacheTtlMs = options.remoteCacheTtlMs ?? REMOTE_COLLECT_CACHE_TTL_MS;
  const remoteOfflineMaxAgeMs = options.remoteOfflineMaxAgeMs ?? REMOTE_COLLECT_OFFLINE_MAX_AGE_MS;
  const remoteCache = new Map<string, RemoteCacheEntry>();
  const hostId = () => origin.getLastServerInfoMessage()!.serverId;
  const onHost = <T>(id: string, operation: (client: DaemonClient) => Promise<T>): Promise<T> =>
    id === hostId() ? operation(origin) : hosts.withHost(id, operation);
  return {
    async liveIds() {
      return new Set(
        (await list(origin, hostId()))
          .filter(agent => !agent.archivedAt && ['idle', 'error'].includes(agent.status) && !isWorking(agent))
          .map(agent => agent.id),
      );
    },
    async collect() {
      // 置顶状态只存在本机；读取失败时抛错，不能当作“没有主会话”。
      const workspaceRoles = await roles.read();
      const directory = await origin.listHosts();
      const selfId = directory.self.serverId;
      const enabled = directory.hosts.filter(host => host.enabled && host.serverId && host.serverId !== selfId);
      const listeners = new Set(githubListeners().map(id => `${selfId}:${id}`));
      const hostTimings: StalledHostTimings[] = [];

      const localStart = performance.now();
      let localListMs = 0;
      let localScheduleMs = 0;
      const localAgents = await onHost(selfId, async client => {
        const tList0 = performance.now();
        const listTask = list(client, selfId).then(value => {
          localListMs = roundMs(performance.now() - tList0);
          return value;
        });
        const tSched0 = performance.now();
        const schedTask = client.scheduleList().then(value => {
          localScheduleMs = roundMs(performance.now() - tSched0);
          return value;
        });
        const [agents, schedules] = await Promise.all([listTask, schedTask]);
        applyListeners(selfId, schedules.schedules, null, now(), listeners);
        return agents;
      }).catch(error => {
        throw new Error(`读取主机“本机”的工作状态失败：${error instanceof Error ? error.message : String(error)}`);
      });
      hostTimings.push({
        hostId: selfId,
        listMs: localListMs,
        scheduleListMs: localScheduleMs,
        subscriptionsMs: null,
        totalMs: roundMs(performance.now() - localStart),
        cached: false,
      });

      const localCandidates = localAgents.filter(
        agent =>
          !agent.archivedAt &&
          !agent.internal &&
          isMainSession(agent, workspaceRoles) &&
          ['idle', 'error'].includes(agent.status) &&
          !isWorking(agent) &&
          !listeners.has(`${selfId}:${agent.id}`),
      );
      if (localCandidates.length === 0) {
        return { hostId: selfId, agents: localAgents, listeners, roles: workspaceRoles, hosts: hostTimings };
      }

      const latestCandidateUpdateMs = Math.max(
        0,
        ...localCandidates.map(candidate => Date.parse(candidate.updatedAt) || 0),
      );

      const remotePages = await Promise.all(
        enabled.map(async host => {
          const id = host.serverId!;
          const name = host.label || id;
          const cached = remoteCache.get(id);
          const nowMs = now();

          if (host.status !== 'online') {
            if (cached && nowMs - cached.at < remoteOfflineMaxAgeMs) {
              applyListeners(id, cached.schedules, cached.subscriptions, nowMs, listeners);
              hostTimings.push({
                hostId: id,
                listMs: 0,
                scheduleListMs: 0,
                subscriptionsMs: 0,
                totalMs: 0,
                cached: true,
              });
              return cached.agents;
            }
            throw new Error('有来源主机离线，无法确认跨主机子会话，暂不判定停滞。');
          }

          if (cached && nowMs - cached.at < remoteCacheTtlMs && latestCandidateUpdateMs <= cached.at) {
            applyListeners(id, cached.schedules, cached.subscriptions, nowMs, listeners);
            hostTimings.push({
              hostId: id,
              listMs: 0,
              scheduleListMs: 0,
              subscriptionsMs: 0,
              totalMs: 0,
              cached: true,
            });
            return cached.agents;
          }

          const remoteStart = performance.now();
          let listMs = 0;
          let scheduleListMs = 0;
          let subscriptionsMs = 0;
          try {
            return await onHost(id, async client => {
              const tList0 = performance.now();
              const listTask = list(client, id).then(value => {
                listMs = roundMs(performance.now() - tList0);
                return value;
              });
              const tSched0 = performance.now();
              const schedTask = client.scheduleList().then(value => {
                scheduleListMs = roundMs(performance.now() - tSched0);
                return value;
              });
              const tSub0 = performance.now();
              const subTask = client
                .invokePluginRpc('github-subscriptions', 'subscriptions.snapshot', {})
                .then(value => {
                  subscriptionsMs = roundMs(performance.now() - tSub0);
                  return SnapshotSchema.parse(value);
                });
              const [agents, schedules, subscriptions] = await Promise.all([listTask, schedTask, subTask]);
              const fetchedAt = now();
              remoteCache.set(id, {
                at: fetchedAt,
                agents,
                schedules: schedules.schedules,
                subscriptions,
              });
              applyListeners(id, schedules.schedules, subscriptions, fetchedAt, listeners);
              hostTimings.push({
                hostId: id,
                listMs,
                scheduleListMs,
                subscriptionsMs,
                totalMs: roundMs(performance.now() - remoteStart),
                cached: false,
              });
              return agents;
            });
          } catch (error) {
            const fallbackNow = now();
            if (cached && fallbackNow - cached.at < remoteOfflineMaxAgeMs) {
              applyListeners(id, cached.schedules, cached.subscriptions, fallbackNow, listeners);
              hostTimings.push({
                hostId: id,
                listMs,
                scheduleListMs,
                subscriptionsMs,
                totalMs: roundMs(performance.now() - remoteStart),
                cached: true,
              });
              return cached.agents;
            }
            throw new Error(`读取主机“${name}”的工作状态失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      return {
        hostId: selfId,
        agents: [localAgents, ...remotePages].flat(),
        listeners,
        roles: workspaceRoles,
        hosts: hostTimings,
      };
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
