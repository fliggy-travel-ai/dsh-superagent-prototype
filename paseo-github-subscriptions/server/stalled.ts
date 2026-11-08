import type { StalledSnapshot } from '../shared/stalled.ts';

export interface StalledAgent {
  id: string;
  hostId: string;
  title: string | null;
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
  collect(): Promise<{ hostId: string; agents: StalledAgent[]; listeners: Set<string> }>;
  subagents(agent: StalledAgent): Promise<boolean>;
  message(agent: StalledAgent): Promise<string | null>;
  current(agent: StalledAgent): Promise<StalledAgent | null>;
}
const key = (agent: StalledAgent) => `${agent.hostId}:${agent.id}`;
const working = (agent: StalledAgent) => ['running', 'initializing'].includes(agent.status) || !!agent.activeTurn || !!agent.pendingPermissions?.length;
const candidate = (agent: StalledAgent) => !agent.archivedAt && !agent.internal && !agent.labels?.['paseo.parent-agent-id'] && ['idle', 'error'].includes(agent.status) && !working(agent);

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
  private inflight: Promise<StalledSnapshot> | null = null;
  private messages = new Map<string, { version: string; text: string | null }>();
  constructor(port: StalledPort) { this.port = port; }
  snapshot() {
    this.inflight ??= this.scan().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  private async scan(): Promise<StalledSnapshot> {
    const sessions: StalledSnapshot['sessions'] = [];
    const errors = new Set<string>();
    try {
      const fleet = await this.port.collect();
      const candidates = fleet.agents.filter(agent => agent.hostId === fleet.hostId && candidate(agent));
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
            for (const member of family) if (await this.port.subagents(member)) { active = true; break; }
            if (active) continue;
            let message = this.messages.get(key(agent));
            let messageError: string | null = null;
            if (!message || message.version !== agent.updatedAt) {
              try { message = { version: agent.updatedAt, text: await this.port.message(agent) }; this.messages.set(key(agent), message); }
              catch { message = undefined; messageError = '最后消息读取失败，请打开会话查看。'; }
            }
            const current = await this.port.current(agent);
            if (!current || !candidate(current) || current.updatedAt !== agent.updatedAt) continue;
            sessions.push({ agentId: agent.id, title: agent.title || '未命名会话', since: agent.attentionTimestamp || agent.updatedAt, lastMessage: message?.text ?? null, messageError });
          } catch { errors.add('部分会话的子代理状态无法确认，暂未列为停滞。'); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(candidates.length, 4) }, inspect));
    } catch (error) { errors.add(error instanceof Error ? error.message : '主机状态无法确认，暂不判定停滞。'); }
    sessions.sort((left, right) => right.since.localeCompare(left.since));
    return { sessions, error: [...errors].join(' ') || null };
  }
}
