import type { RpcInput } from '@getpaseo/plugin';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import {
  createHeartbeat,
  deleteHeartbeat,
  listHeartbeatCounts,
  listHeartbeats,
  updateHeartbeat,
  type Heartbeat,
} from '../../shared/heartbeats.ts';

const POLL_INTERVAL_MS = 15_000;

export interface AgentHeartbeatsView {
  readonly heartbeats: readonly Heartbeat[];
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
}

export interface AgentHeartbeatCount {
  /** 有效（未暂停）的心跳数量。 */
  readonly active: number;
  /** 已暂停的心跳数量。 */
  readonly paused: number;
}

export interface HeartbeatStoreState {
  readonly counts: ReadonlyMap<string, AgentHeartbeatCount>;
  readonly agents: ReadonlyMap<string, AgentHeartbeatsView>;
}

const EMPTY_AGENT_VIEW: AgentHeartbeatsView = {
  heartbeats: [],
  loading: false,
  loaded: false,
  error: null,
};

export function heartbeatErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error || '心跳操作失败。');
}

export function createHeartbeatStore(client: Pick<PluginClientContext, 'rpc'>) {
  let state: HeartbeatStoreState = {
    counts: new Map(),
    agents: new Map(),
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const setAgentList = (agentId: string, heartbeats: readonly Heartbeat[]) => {
    if (disposed) return;
    const nextAgents = new Map(state.agents);
    nextAgents.set(agentId, {
      heartbeats,
      loading: false,
      loaded: true,
      error: null,
    });
    const nextCounts = new Map(state.counts);
    const paused = heartbeats.filter(item => item.status === 'paused').length;
    if (heartbeats.length > 0) {
      nextCounts.set(agentId, { active: heartbeats.length - paused, paused });
    } else {
      nextCounts.delete(agentId);
    }
    state = { counts: nextCounts, agents: nextAgents };
    emit();
  };

  const refreshCounts = async () => {
    if (disposed) return;
    try {
      const result = await client.rpc(listHeartbeatCounts, {});
      if (disposed) return;
      const nextCounts = new Map<string, AgentHeartbeatCount>();
      for (const entry of result.counts) {
        if (entry.count + entry.paused > 0) {
          nextCounts.set(entry.agentId, { active: entry.count, paused: entry.paused });
        }
      }
      let same = nextCounts.size === state.counts.size;
      if (same) {
        for (const [agentId, count] of nextCounts) {
          const previous = state.counts.get(agentId);
          if (!previous || previous.active !== count.active || previous.paused !== count.paused) {
            same = false;
            break;
          }
        }
      }
      if (!same) {
        state = { ...state, counts: nextCounts };
        emit();
      }
    } catch {
      // 守护进程尚未加载模块或连接短暂不可用时静默保留上次计数。
    }
  };

  const loadAgent = async (agentId: string) => {
    if (disposed || !agentId) return;
    const current = state.agents.get(agentId) ?? EMPTY_AGENT_VIEW;
    const nextAgents = new Map(state.agents);
    nextAgents.set(agentId, { ...current, loading: true, error: null });
    state = { ...state, agents: nextAgents };
    emit();
    try {
      const result = await client.rpc(listHeartbeats, { agentId });
      setAgentList(agentId, result.heartbeats);
    } catch (error) {
      if (disposed) return;
      const failedAgents = new Map(state.agents);
      failedAgents.set(agentId, {
        heartbeats: current.heartbeats,
        loading: false,
        loaded: current.loaded,
        error: heartbeatErrorMessage(error),
      });
      state = { ...state, agents: failedAgents };
      emit();
    }
  };

  return {
    getState: () => state,
    getAgentView: (agentId: string): AgentHeartbeatsView => state.agents.get(agentId) ?? EMPTY_AGENT_VIEW,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (disposed || timer) return;
      void refreshCounts();
      timer = setInterval(() => {
        void refreshCounts();
      }, POLL_INTERVAL_MS);
      timer.unref?.();
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      listeners.clear();
    },
    refreshCounts,
    loadAgent,
    async create(input: RpcInput<typeof createHeartbeat>) {
      const result = await client.rpc(createHeartbeat, input);
      setAgentList(input.agentId, result.heartbeats);
      return result;
    },
    async update(input: RpcInput<typeof updateHeartbeat>) {
      const result = await client.rpc(updateHeartbeat, input);
      setAgentList(input.agentId, result.heartbeats);
      return result;
    },
    async remove(input: RpcInput<typeof deleteHeartbeat>) {
      const result = await client.rpc(deleteHeartbeat, input);
      setAgentList(input.agentId, result.heartbeats);
      return result;
    },
  };
}

export type HeartbeatStore = ReturnType<typeof createHeartbeatStore>;
