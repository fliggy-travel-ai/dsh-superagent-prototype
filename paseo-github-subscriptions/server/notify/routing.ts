export function questionRequest(data: unknown): boolean {
  const d = data as { kind?: string; name?: string } | null;
  return d?.kind === 'question' || /(?:^|__)AskUserQuestion$/.test(d?.name || '');
}
export function deliveryClass(event: string, isMain: boolean, isChild: boolean, orphan = false): 'grok' | 'parent' | 'record' {
  if (['capacity', 'main_finalized', 'main_migrated', 'lb_exception'].includes(event)) return 'grok';
  // MCP 已负责子会话完结通知；这里只保留审计，包括无主归属的完结事件。
  if (['answered', 'user_reply', 'turn_end', 'idle', 'subagent_done', 'test'].includes(event)) return 'record';
  if (isChild) return ['asked', 'error', 'bg_cmd_done'].includes(event) ? 'parent' : 'record';
  if (event === 'new_project' || event === 'new_workspace') return 'grok';
  return isMain && ['asked', 'error'].includes(event) ? 'grok' : 'record';
}
