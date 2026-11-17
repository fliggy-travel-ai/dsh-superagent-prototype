import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';

export interface PermissionAgent {
  id: string;
  archivedAt?: string | null;
  pendingPermissions: readonly AgentPermissionRequest[];
}

export interface ToolPermissionPort {
  list(): Promise<PermissionAgent[]>;
  refresh(agentId: string): Promise<PermissionAgent | null>;
  approve(agentId: string, requestId: string): Promise<unknown>;
  failed(agentId: string, requestId: string): void;
}

export function isToolPermission(request: AgentPermissionRequest): boolean {
  return request.kind === 'tool' && !/^(?:AskUserQuestion|request_user_input(?:_async)?|EnterPlanMode|ExitPlanMode)$/i.test(request.name);
}

export class ToolPermissionRuntime {
  private stopped = false;
  private cycle: Promise<void> | null = null;
  private rescanNeeded = false;
  private approved = new Set<string>();
  private readonly port: ToolPermissionPort;

  constructor(port: ToolPermissionPort) { this.port = port; }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.rescanNeeded = true;
    this.cycle ??= this.drain().finally(() => { this.cycle = null; });
    return this.cycle;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.rescanNeeded) {
      this.rescanNeeded = false;
      await this.check();
    }
  }

  private async check(): Promise<void> {
    const agents = await this.port.list();
    const pending = new Set(agents.flatMap(agent => agent.pendingPermissions.map(request => `${agent.id}:${request.id}`)));
    for (const key of this.approved) if (!pending.has(key)) this.approved.delete(key);
    for (const agent of agents) {
      if (agent.archivedAt) continue;
      for (const request of agent.pendingPermissions) {
        if (this.stopped) return;
        const key = `${agent.id}:${request.id}`;
        if (!isToolPermission(request) || this.approved.has(key)) continue;
        try {
          const current = await this.port.refresh(agent.id);
          const latest = current?.pendingPermissions.find(item => item.id === request.id);
          if (this.stopped) return;
          if (!current || current.archivedAt || !latest || !isToolPermission(latest)) continue;
          await this.port.approve(agent.id, request.id);
          this.approved.add(key);
        } catch {
          this.port.failed(agent.id, request.id);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.cycle?.catch(() => {});
  }
}
