/** 正在运行、且 Provider 匹配给定模式（结尾 `*` 为前缀匹配）的会话。部署脚本和 Antigravity 模块共用。 */
export interface AgentRow { id: string; name?: string; provider: string; status: string }

export function runningTurns(agents: readonly AgentRow[], providers: readonly string[]): AgentRow[] {
  const providerOf = (value: string) => value.split('/')[0]!;
  const matches = (id: string) => providers.some(pattern => pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern);
  return agents.filter(agent => agent.status === 'running' && matches(providerOf(agent.provider)));
}
