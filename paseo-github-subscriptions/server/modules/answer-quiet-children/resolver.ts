import { resolveForwardTarget, type RoleAgent, type RolesReader } from '../../core/session-roles.ts';

export interface ResolverDeps {
  /** 本机未归档的会话。 */
  list(): Promise<RoleAgent[]>;
  roles: RolesReader;
}

export interface MainResolution { agentId: string | null; workspaceId: string | null }

/**
 * “现任主会话”解析：父会话仍在置顶工作区时用父会话；接班后（父会话已归档、已关闭或不再置顶）
 * 改发父会话所在工作区中最近活动的会话；找不到时返回 null，调用方只记录。
 */
export function createMainResolver(deps: ResolverDeps) {
  return async (input: { parentId: string; parentWorkspaceId?: string | null; childId?: string }): Promise<MainResolution> => {
    const [agents, roles] = await Promise.all([deps.list(), deps.roles.read()]);
    const target = resolveForwardTarget({ parentId: input.parentId, parentWorkspaceId: input.parentWorkspaceId, childId: input.childId ?? '', agents, roles });
    if (!target) return { agentId: null, workspaceId: null };
    const chosen = agents.find(agent => agent.id === target.agentId);
    return { agentId: target.agentId, workspaceId: chosen?.workspaceId ?? null };
  };
}
