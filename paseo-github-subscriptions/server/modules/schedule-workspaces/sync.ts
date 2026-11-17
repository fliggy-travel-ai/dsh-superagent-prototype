export interface ScheduleAgent {
  workspaceId?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string>;
}

export interface ScheduleWorkspacePort {
  schedule(id: string): Promise<{ name: string | null; target: { type: string } } | null>;
  workspace(id: string): Promise<{ name?: string | null; title?: string | null; archivedAt?: string | null; pinnedAt?: string | null } | null>;
  rename(id: string, title: string): Promise<unknown>;
  pin(id: string): Promise<unknown>;
}

export function scheduledWorkspace(agent: ScheduleAgent) {
  const scheduleId = agent.labels?.['paseo.schedule-id'];
  if (!scheduleId || !agent.workspaceId || agent.archivedAt || agent.labels?.['paseo.parent-agent-id']) return null;
  return { scheduleId, workspaceId: agent.workspaceId };
}

export async function syncScheduleWorkspace(port: ScheduleWorkspacePort, agent: ScheduleAgent): Promise<boolean> {
  const target = scheduledWorkspace(agent);
  if (!target) return false;
  const schedule = await port.schedule(target.scheduleId);
  if (!schedule || schedule.target.type !== 'new-agent') return false;
  const name = schedule.name?.trim().replace(/^(?:【每日】\s*)+/, '').trim();
  if (!name) return false;
  const workspace = await port.workspace(target.workspaceId);
  if (!workspace || workspace.archivedAt) return false;
  const title = `【每日】${name}`;
  if ((workspace.title ?? workspace.name) !== title) await port.rename(target.workspaceId, title);
  if (!workspace.pinnedAt) await port.pin(target.workspaceId);
  return true;
}
