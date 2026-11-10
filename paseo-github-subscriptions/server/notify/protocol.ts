export type EventName =
  | 'asked'
  | 'answered'
  | 'user_reply'
  | 'turn_end'
  | 'idle'
  | 'error'
  | 'bg_cmd_done'
  | 'subagent_done'
  | 'new_project'
  | 'new_workspace'
  | 'test';
export type Actor = 'user' | 'assistant' | 'automation';
export interface AgentInfo {
  id: string;
  workspaceId?: string | null;
  title?: string | null;
  provider?: string;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
}
export interface WorkspaceInfo {
  id: string;
  name: string;
  labels?: string[];
  path?: string;
}
export function needsUser(data: unknown): boolean {
  const text = JSON.stringify(data) || '';
  return /(?:合并|merge)[\s\S]*\bmaster\b|\bmaster\b[\s\S]*(?:合并|merge)|复盘|retrospect|post.?mortem/i.test(text);
}
export function questionSummary(data: unknown): {
  text: string;
  questions: unknown[];
  options: unknown[];
  recommended: unknown[];
} {
  const d = data as Record<string, unknown> | null;
  const input = d?.input as Record<string, unknown> | undefined;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const firstQuestion = questions[0] as { question?: unknown } | undefined;
  const firstText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';
  return {
    text: firstText || String(d?.title || d?.description || d?.name || ''),
    questions,
    options: Array.isArray(input?.questions)
      ? input.questions.flatMap((q: any) => (Array.isArray(q.options) ? q.options : []))
      : Array.isArray(d?.actions) ? d.actions : [],
    recommended: Array.isArray(input?.questions)
      ? input.questions.flatMap((q: any) => (q.options || []).filter((o: any) => o.recommended === true || o.isRecommended === true || /推荐|recommended/i.test(String(o.label || ''))))
      : [],
  };
}
export function wakePolicy(event: EventName): 'immediate' | 'coalesce' | 'none' {
  if (event === 'asked' || event === 'new_project' || event === 'new_workspace') return 'immediate';
  if (event === 'answered' || event === 'test') return 'none';
  return 'coalesce';
}
export function duplicateWorkspaceIds(workspaces: Map<string, WorkspaceInfo>, id: string, path: string): string[] {
  return [...workspaces.values()].filter(w => w.id !== id && w.path === path).map(w => w.id);
}
