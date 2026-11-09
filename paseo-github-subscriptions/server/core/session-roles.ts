import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 会话角色。主会话 = 置顶且未归档的工作区中的会话。
 * 父会话标签 `paseo.parent-agent-id` 不决定谁是主会话，只用来找子会话事件的转发目标。
 * 停滞会话、子会话免提醒、升级通知使用同一判定。
 */
export interface WorkspaceRoles {
  readonly pinned: ReadonlySet<string>;
  readonly archived: ReadonlySet<string>;
}

export interface RoleAgent {
  id: string;
  workspaceId?: string | null;
  status?: string;
  archivedAt?: string | null;
  updatedAt?: string;
  labels?: Record<string, string>;
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

export function parseWorkspaceRoles(records: unknown): WorkspaceRoles {
  const pinned = new Set<string>();
  const archived = new Set<string>();
  if (Array.isArray(records)) {
    for (const record of records as Array<Record<string, unknown> | null>) {
      if (!record || !text(record.workspaceId)) continue;
      if (text(record.archivedAt)) archived.add(record.workspaceId);
      else if (text(record.pinnedAt)) pinned.add(record.workspaceId);
    }
  }
  return { pinned, archived };
}

export function isMainSession(agent: Pick<RoleAgent, 'workspaceId'>, roles: WorkspaceRoles): boolean {
  return text(agent.workspaceId) && roles.pinned.has(agent.workspaceId);
}

/** 子会话：知道所在工作区，且该工作区未置顶、未归档。不知道工作区时不动它（与旧子会话免提醒一致）。 */
export function isChildSession(agent: Pick<RoleAgent, 'workspaceId'>, roles: WorkspaceRoles): boolean {
  return text(agent.workspaceId) && !roles.pinned.has(agent.workspaceId) && !roles.archived.has(agent.workspaceId);
}

export function parentLink(agent: Pick<RoleAgent, 'labels'>): { agentId: string; serverId?: string } | null {
  const agentId = agent.labels?.['paseo.parent-agent-id'];
  if (!text(agentId)) return null;
  const serverId = agent.labels?.['paseo.parent-server-id'];
  return text(serverId) ? { agentId, serverId } : { agentId };
}

const live = (agent: RoleAgent) => !agent.archivedAt && agent.status !== 'closed';

export interface ForwardTarget { agentId: string; reason: 'parent' | 'successor' }

/**
 * 子会话事件发给谁。父会话仍是置顶工作区中的活动会话时发给它；
 * 父会话已归档、已关闭或不在置顶工作区（接班）时，发给父会话所在工作区中最近活动的主会话。
 * 找不到时返回 null，调用方只记录，不发送。
 */
export function resolveForwardTarget(input: { parentId: string; parentWorkspaceId?: string | null; childId: string; agents: readonly RoleAgent[]; roles: WorkspaceRoles }): ForwardTarget | null {
  const { parentId, childId, agents, roles } = input;
  const parent = agents.find(agent => agent.id === parentId);
  if (parent && live(parent) && isMainSession(parent, roles)) return { agentId: parentId, reason: 'parent' };
  const workspaceId = parent?.workspaceId ?? input.parentWorkspaceId;
  if (!text(workspaceId) || !roles.pinned.has(workspaceId)) return null;
  const successors = agents
    .filter(agent => agent.id !== childId && agent.id !== parentId && agent.workspaceId === workspaceId && live(agent))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  return successors[0] ? { agentId: successors[0].id, reason: 'successor' } : null;
}

export interface RolesReader {
  /** 文件不存在、无法读取或无法解析时都抛错，调用方不要把错误当作“没有置顶”：要显示原因，且不做依赖角色的操作。 */
  read(): Promise<WorkspaceRoles>;
}

/** 读取 `<home>/projects/workspaces.json`，按修改时间缓存。 */
export function createRolesReader(home: string): RolesReader {
  const file = join(home, 'projects', 'workspaces.json');
  let mtime = -1;
  let cached: WorkspaceRoles = parseWorkspaceRoles(null);
  return {
    async read() {
      try {
        const { mtimeMs } = await stat(file);
        if (mtimeMs !== mtime) { cached = parseWorkspaceRoles(JSON.parse(await readFile(file, 'utf8'))); mtime = mtimeMs; }
        return cached;
      } catch (error) {
        mtime = -1;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('工作区状态文件 workspaces.json 不存在，无法确定哪些工作区已置顶');
        throw error;
      }
    },
  };
}

const readers = new Map<string, RolesReader>();
/** 同一个 Paseo 目录共用一个读取器，各模块不用互相传递。 */
export function sessionRoles(home: string): RolesReader {
  let reader = readers.get(home);
  if (!reader) { reader = createRolesReader(home); readers.set(home, reader); }
  return reader;
}

export interface AncestorTarget { agentId: string; serverId?: string }

/**
 * 多层子会话：沿父会话标签逐层向上，找到置顶工作区中的主会话（与旧插件继承上层目标一致）。
 * - 上层是主会话就停；上层记录已不存在，或不是主会话又没有更上层时，目标取最后找到的父会话，
 *   投递时再按工作区接班（resolveForwardTarget）。
 * - 上层在另一台主机（serverId 不是本机）时不能继续向上走，目标带 serverId，由对方主机解析。
 * - 标签成环时停在成环处。本身就是主会话或没有父会话标签时返回 null。
 */
export function findMainAncestor(input: { agentId: string; lookup: (id: string) => RoleAgent | undefined; roles: WorkspaceRoles; localServerId?: string | null }): AncestorTarget | null {
  const start = input.lookup(input.agentId);
  let link = start && !isMainSession(start, input.roles) ? parentLink(start) : null;
  const seen = new Set<string>([input.agentId]);
  let last: AncestorTarget | null = null;
  while (link) {
    const remote = !!link.serverId && link.serverId !== input.localServerId;
    last = remote ? { agentId: link.agentId, serverId: link.serverId! } : { agentId: link.agentId };
    if (remote || seen.has(link.agentId)) return last;
    seen.add(link.agentId);
    const parent = input.lookup(link.agentId);
    if (!parent || isMainSession(parent, input.roles)) return last;
    link = parentLink(parent);
  }
  return last;
}
