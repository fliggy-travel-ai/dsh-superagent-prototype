import type { StalledHostTimings, StalledSnapshot } from '../shared/stalled.ts';
import { isMainSession, type WorkspaceRoles } from './core/session-roles.ts';

export const STALLED_SCAN_INTERVAL_MS = 10_000;
export const STALLED_MAX_WAIT_MS = 50;

export interface StalledAgent {
  id: string;
  hostId: string;
  title: string | null;
  workspaceId?: string | null;
  status: string;
  updatedAt: string;
  attentionTimestamp?: string | null;
  activeTurn?: unknown;
  archivedAt?: string | null;
  internal?: boolean;
  pendingPermissions?: unknown[];
  labels?: Record<string, string>;
}
export interface StalledPort {
  collect(): Promise<{
    hostId: string;
    agents: StalledAgent[];
    listeners: Set<string>;
    roles: WorkspaceRoles;
    hosts?: StalledHostTimings[];
  }>;
  subagents(agent: StalledAgent): Promise<boolean>;
  message(agent: StalledAgent): Promise<string | null>;
  current(agent: StalledAgent): Promise<StalledAgent | null>;
  liveIds(): Promise<Set<string>>;
}

export interface StalledRuntimeOptions {
  now?: () => number;
  maxWaitMs?: number;
  cacheTtlMs?: number;
  scanIntervalMs?: number;
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;
const key = (agent: StalledAgent) => `${agent.hostId}:${agent.id}`;
const working = (agent: StalledAgent) => ['running', 'initializing'].includes(agent.status) || !!agent.activeTurn || !!agent.pendingPermissions?.length;
/** 主会话 = 置顶工作区中的会话（见 core/session-roles.ts）。父会话标签不再决定是否检查。 */
const candidate = (agent: StalledAgent, roles: WorkspaceRoles) => !agent.archivedAt && !agent.internal && isMainSession(agent, roles) && ['idle', 'error'].includes(agent.status) && !working(agent);

export function descendants(parent: StalledAgent, agents: StalledAgent[]) {
  const found = new Set([key(parent)]);
  const children: StalledAgent[] = [];
  for (let index = 0; index <= children.length; index++) {
    const ancestor = index === 0 ? parent : children[index - 1];
    for (const agent of agents) {
      if (agent.archivedAt || found.has(key(agent))) continue;
      if (agent.labels?.['paseo.parent-agent-id'] !== ancestor.id) continue;
      if ((agent.labels['paseo.parent-server-id'] || agent.hostId) !== ancestor.hostId) continue;
      found.add(key(agent)); children.push(agent);
    }
  }
  return children;
}

export class StalledRuntime {
  private port: StalledPort;
  private now: () => number;
  private maxWaitMs: number;
  private cacheTtlMs: number;
  private scanIntervalMs: number;
  private inflight: Promise<StalledSnapshot> | null = null;
  private lastSnapshot: StalledSnapshot | null = null;
  private lastScannedAtMs = 0;
  private lastHostId = 'local';
  private lastRoles: WorkspaceRoles | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private messages = new Map<string, { version: string; text: string | null }>();

  constructor(port: StalledPort, options: StalledRuntimeOptions = {}) {
    this.port = port;
    this.now = options.now ?? Date.now;
    this.maxWaitMs = options.maxWaitMs ?? STALLED_MAX_WAIT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.scanIntervalMs = options.scanIntervalMs ?? STALLED_SCAN_INTERVAL_MS;
  }

  start(intervalMs = this.scanIntervalMs): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (!this.inflight) {
        this.inflight = this.scan().finally(() => {
          this.inflight = null;
        });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  invalidate(): void {
    this.lastSnapshot = null;
    this.lastScannedAtMs = 0;
  }

  private async filterLocalActive(snapshot: StalledSnapshot): Promise<StalledSnapshot> {
    if (snapshot.sessions.length === 0) return snapshot;
    try {
      const checks = await Promise.all(
        snapshot.sessions.map(async session => {
          const current = await this.port.current({
            id: session.agentId,
            hostId: this.lastHostId,
            title: session.title,
            status: 'idle',
            updatedAt: session.since,
          });
          if (!current) return null;
          if (
            this.lastRoles
              ? !candidate(current, this.lastRoles)
              : Boolean(current.archivedAt) ||
                Boolean(current.internal) ||
                !['idle', 'error'].includes(current.status) ||
                working(current)
          ) {
            return null;
          }
          return session;
        }),
      );
      const filtered = checks.filter((item): item is StalledSnapshot['sessions'][number] => item !== null);
      if (filtered.length === snapshot.sessions.length) return snapshot;
      const next: StalledSnapshot = { ...snapshot, sessions: filtered };
      if (this.lastSnapshot === snapshot) this.lastSnapshot = next;
      return next;
    } catch {
      return snapshot;
    }
  }

  async snapshot(): Promise<StalledSnapshot> {
    if (this.lastSnapshot && this.lastSnapshot.sessions.length > 0) {
      await this.filterLocalActive(this.lastSnapshot);
    }
    const nowMs = this.now();
    const hadInflight = Boolean(this.inflight);
    const cacheFresh =
      this.lastSnapshot !== null &&
      this.cacheTtlMs > 0 &&
      nowMs - this.lastScannedAtMs < this.cacheTtlMs;

    if (!this.inflight && !cacheFresh) {
      this.inflight = this.scan().finally(() => {
        this.inflight = null;
      });
    }

    if (this.inflight) {
      if (hadInflight && this.lastSnapshot) {
        return this.lastSnapshot;
      }
      if (this.maxWaitMs <= 0 && this.lastSnapshot) {
        return this.lastSnapshot;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        this.inflight,
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), this.maxWaitMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (completed) {
        return completed;
      }
    }

    return (
      this.lastSnapshot ?? {
        sessions: [],
        error: null,
        scannedAt: null,
      }
    );
  }

  private async scan(): Promise<StalledSnapshot> {
    const scanStart = performance.now();
    let collectMs = 0;
    let hostTimings: StalledHostTimings[] | undefined;
    let subagentsMs = 0;
    let messageMs = 0;
    let currentMs = 0;
    let liveIdsMs = 0;
    const sessions: StalledSnapshot['sessions'] = [];
    const errors = new Set<string>();
    try {
      const tCollect0 = performance.now();
      const fleet = await this.port.collect();
      collectMs = roundMs(performance.now() - tCollect0);
      hostTimings = fleet.hosts;
      this.lastHostId = fleet.hostId;
      this.lastRoles = fleet.roles;
      const candidates = fleet.agents.filter(agent => agent.hostId === fleet.hostId && candidate(agent, fleet.roles));
      const live = new Set(candidates.map(key));
      for (const identity of this.messages.keys()) if (!live.has(identity)) this.messages.delete(identity);
      let cursor = 0;
      const inspect = async () => {
        while (cursor < candidates.length) {
          const agent = candidates[cursor++];
          const family = [agent, ...descendants(agent, fleet.agents)];
          if (family.some(member => working(member) || fleet.listeners.has(key(member)))) continue;
          try {
            let active = false;
            for (const member of family) {
              const tSub0 = performance.now();
              const busy = await this.port.subagents(member);
              subagentsMs += performance.now() - tSub0;
              if (busy) { active = true; break; }
            }
            if (active) continue;
            let message = this.messages.get(key(agent));
            let messageError: string | null = null;
            if (!message || message.version !== agent.updatedAt) {
              const tMsg0 = performance.now();
              try {
                message = { version: agent.updatedAt, text: await this.port.message(agent) };
                this.messages.set(key(agent), message);
              } catch {
                message = undefined;
                messageError = '最后消息读取失败，请打开会话查看。';
              } finally {
                messageMs += performance.now() - tMsg0;
              }
            }
            const tCur0 = performance.now();
            const current = await this.port.current(agent);
            currentMs += performance.now() - tCur0;
            if (!current || !candidate(current, fleet.roles) || current.updatedAt !== agent.updatedAt) continue;
            sessions.push({ agentId: agent.id, title: agent.title || '未命名会话', since: agent.attentionTimestamp || agent.updatedAt, lastMessage: message?.text ?? null, messageError });
          } catch { errors.add('部分会话的子代理状态无法确认，暂未列为停滞。'); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(candidates.length, 4) }, inspect));
      if (sessions.length) {
        const tLive0 = performance.now();
        try {
          const liveIds = await this.port.liveIds();
          for (let index = sessions.length - 1; index >= 0; index--) if (!liveIds.has(sessions[index].agentId)) sessions.splice(index, 1);
        } catch {
          sessions.length = 0;
          errors.add('无法核对会话是否已归档，暂不显示停滞会话。');
        } finally {
          liveIdsMs = roundMs(performance.now() - tLive0);
        }
      }
    } catch (error) { errors.add(error instanceof Error ? error.message : '主机状态无法确认，暂不判定停滞。'); }
    sessions.sort((left, right) => right.since.localeCompare(left.since));
    const finishedAt = this.now();
    const rawResult: StalledSnapshot = {
      sessions,
      error: [...errors].join(' ') || null,
      scannedAt: new Date(finishedAt).toISOString(),
      timings: {
        collectMs,
        ...(hostTimings ? { hosts: hostTimings } : {}),
        subagentsMs: roundMs(subagentsMs),
        messageMs: roundMs(messageMs),
        currentMs: roundMs(currentMs),
        liveIdsMs,
        totalMs: roundMs(performance.now() - scanStart),
      },
    };
    const finalResult = rawResult.sessions.length > 0 ? await this.filterLocalActive(rawResult) : rawResult;
    this.lastSnapshot = finalResult;
    this.lastScannedAtMs = finishedAt;
    return finalResult;
  }
}
