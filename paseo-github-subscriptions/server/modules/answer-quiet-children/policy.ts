import { isChildSession, type AgentLookup, type WorkspaceRoles } from '../../core/session-roles.ts';

export interface AgentState {
  id?: string;
  workspaceId?: string | null;
  labels?: Record<string, string>;
  status?: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  pendingPermissions?: ReadonlyArray<{ kind?: string }> | null;
}

export interface ClearOptions {
  /**
   * 子会话的提问有人接手：事件转发已打开并找到了转发目标，或旧的转发插件仍在运行。
   * 没有人接手时保留提问提醒，否则提问没人知道。
   */
  questionHandled?: boolean;
  /** 查父会话所在工作区，用来认出置顶工作区里的子会话。 */
  lookup?: AgentLookup;
}

/** 子会话进入“待查看”时清除。提问由主会话回答（前提是有人把提问转给它）；等待工具授权的会话保留提醒，避免会话卡住没人知道。 */
export function shouldClearAttention(agent: AgentState, roles: WorkspaceRoles, options: ClearOptions = {}): boolean {
  if (!agent.requiresAttention || !isChildSession(agent, roles, options.lookup)) return false;
  // 守护进程清除已关闭会话的标记前会先重新加载会话，代价很高，所以只处理已加载的会话。
  if (agent.status === 'closed' || agent.status === 'initializing' || !agent.status) return false;
  const pending = agent.pendingPermissions ?? [];
  if (pending.some(request => request.kind !== 'question')) return false;
  return pending.length === 0 || options.questionHandled === true;
}

export function attentionClearScope(agent: AgentState, roles: WorkspaceRoles, options: ClearOptions = {}): 'workspace' | 'agent' | null {
  if (!shouldClearAttention(agent, roles, options)) return null;
  // 置顶工作区里还有主会话，只能清这个子会话自己，不能按工作区清。
  const sharesMainWorkspace = !!agent.workspaceId && roles.pinned.has(agent.workspaceId);
  return sharesMainWorkspace || (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === 'permission' ? 'agent' : 'workspace';
}
