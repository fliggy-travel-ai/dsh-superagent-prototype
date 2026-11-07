import type { PluginClientContext } from '@getpaseo/plugin/client';
import {
  pollNow,
  removeToken,
  saveToken,
  savePreferences,
  snapshot as snapshotRpc,
  unsubscribe,
} from '../shared/contracts.ts';
import type { Preferences, Snapshot, TokenStatus } from '../shared/model.ts';

/** 兼容 0.15.x：SDK 没有 defineSubscription/useSubscription，这里用 snapshot RPC 定时刷新。 */
export const REFRESH_INTERVAL_MS = 5000;

export interface StoreState {
  snapshot: Snapshot | null;
  error: string | null;
  loaded: boolean;
}

export interface SnapshotStore {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  unsubscribe(id: string): Promise<void>;
  savePreferences(preferences: Preferences): Promise<void>;
  saveToken(token: string): Promise<TokenStatus>;
  removeToken(): Promise<void>;
  pollNow(): Promise<void>;
  start(): void;
  dispose(): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 整个客户端共用一个 store 和一个定时器；页面、胶囊、侧边栏都只读它。 */
export function createSnapshotStore(client: Pick<PluginClientContext, 'rpc'>): SnapshotStore {
  let state: StoreState = { snapshot: null, error: null, loaded: false };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let inflight: Promise<void> | null = null;
  let seq = 0;
  let appliedSeq = 0;

  const emit = (next: StoreState) => {
    const same =
      next.error === state.error &&
      next.loaded === state.loaded &&
      JSON.stringify(next.snapshot) === JSON.stringify(state.snapshot);
    if (same) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const applySnapshot = (snapshot: Snapshot, mySeq: number) => {
    if (disposed || mySeq < appliedSeq) return;
    appliedSeq = mySeq;
    emit({ snapshot, error: null, loaded: true });
  };

  const applyError = (error: unknown, mySeq: number) => {
    if (disposed || mySeq < appliedSeq) return;
    emit({ snapshot: state.snapshot, error: errorMessage(error), loaded: true });
  };

  const refresh = () => {
    if (inflight) return inflight;
    const mySeq = ++seq;
    inflight = client
      .rpc(snapshotRpc, {})
      .then(
        (snapshot) => applySnapshot(snapshot, mySeq),
        (error: unknown) => applyError(error, mySeq),
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    async unsubscribe(id) {
      const current = state.snapshot;
      if (current) {
        // 乐观更新：胶囊数字立即变化；并让更早发出的刷新结果作废。
        appliedSeq = ++seq;
        emit({
          ...state,
          snapshot: { ...current, subscriptions: current.subscriptions.filter((item) => item.id !== id) },
        });
      }
      try {
        await client.rpc(unsubscribe, { id });
      } finally {
        inflight = null;
        await refresh();
      }
    },
    async savePreferences(preferences) {
      await client.rpc(savePreferences, preferences);
      await refresh();
    },
    async saveToken(token) {
      try {
        const status = await client.rpc(saveToken, { token });
        await refresh();
        return status;
      } catch (error) {
        // 错误文字里不能带令牌。
        throw new Error(errorMessage(error).split(token).join('***'));
      }
    },
    async removeToken() {
      await client.rpc(removeToken, {});
      await refresh();
    },
    async pollNow() {
      const mySeq = ++seq;
      const snapshot = await client.rpc(pollNow, {});
      applySnapshot(snapshot, mySeq);
    },
    start() {
      if (disposed || timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}
