import { isChildSession, type WorkspaceRoles } from '../../core/session-roles.ts';

export interface AgentState {
  workspaceId?: string | null;
  status?: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  pendingPermissions?: ReadonlyArray<{ kind?: string }> | null;
}

/** 子会话进入“待查看”时清除。提问由主会话回答；等待工具授权的会话保留提醒，避免会话卡住没人知道。 */
export function shouldClearAttention(agent: AgentState, roles: WorkspaceRoles): boolean {
  if (!agent.requiresAttention || !isChildSession(agent, roles)) return false;
  // 守护进程清除已关闭会话的标记前会先重新加载会话，代价很高，所以只处理已加载的会话。
  if (agent.status === 'closed' || agent.status === 'initializing' || !agent.status) return false;
  const pending = agent.pendingPermissions ?? [];
  return !pending.some(request => request.kind !== 'question');
}

export function attentionClearScope(agent: AgentState, roles: WorkspaceRoles): 'workspace' | 'agent' | null {
  if (!shouldClearAttention(agent, roles)) return null;
  return (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === 'permission' ? 'agent' : 'workspace';
}
