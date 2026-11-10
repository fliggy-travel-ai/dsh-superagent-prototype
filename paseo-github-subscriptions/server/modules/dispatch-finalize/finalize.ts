export type Agent = { id: string; workspaceId?: string | null; archivedAt?: string | null; labels?: Record<string, string> };
export type Workspace = { id: string; pinnedAt?: string | null; labels?: string[]; archivedAt?: string | null; archivingAt?: string | null };
export type Step = { name: string; status: 'done' | 'skipped' | 'failed' };
export interface FinalizePort {
  agent(id: string): Promise<Agent | null>;
  workspace(id: string): Promise<Workspace | null>;
  detach(id: string): Promise<void>;
  pin(id: string): Promise<void>;
  label(id: string): Promise<void>;
}
export const issueOf = (agent: Agent) => agent.labels?.need || agent.labels?.issue || null;
export async function finalize(port: FinalizePort, id: string): Promise<{ ok: boolean; reason: string | null; issue: string | null; steps: Step[] }> {
  const steps: Step[] = [];
  let issue: string | null = null;
  try {
    const a = await port.agent(id);
    issue = a && issueOf(a);
    if (!a || a.archivedAt || !a.workspaceId || a.labels?.role !== 'main' || !issue) throw Error('会话不符合收尾条件');
    const w = await port.workspace(a.workspaceId);
    if (!w || w.archivedAt || w.archivingAt) throw Error('工作区不存在或已归档');
    steps.push({ name: 'validate', status: 'done' });
    const step = async (name: string, needed: boolean, run: () => Promise<void>) => {
      if (!needed) { steps.push({ name, status: 'skipped' }); return; }
      try { await run(); steps.push({ name, status: 'done' }); }
      catch { steps.push({ name, status: 'failed' }); throw Error(`${name}失败`); }
    };
    await step('detach', !!a.labels?.['paseo.parent-agent-id'], () => port.detach(id));
    await step('pin', !w.pinnedAt, () => port.pin(w.id));
    await step('label', !w.labels?.includes('主会话'), () => port.label(w.id));
    const readback = await port.agent(id);
    if (!readback || readback.labels?.['paseo.parent-agent-id']) { steps.push({ name: 'readback', status: 'failed' }); throw Error('解绑读回失败'); }
    steps.push({ name: 'readback', status: 'done' });
    return { ok: true, reason: null, issue, steps };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : '收尾失败', issue, steps }; }
}
