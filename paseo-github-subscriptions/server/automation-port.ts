import type { PaseoApi } from '@getpaseo/client';
import type { AutomationPort, NativeAgent } from './automation.ts';

export function isClaudeProvider(provider: string, providers: Record<string, { extends?: unknown; enabled?: boolean }>): boolean {
  if (providers[provider]?.enabled === false) return false;
  const seen = new Set<string>();
  while (provider !== 'claude') {
    if (seen.has(provider)) return false;
    seen.add(provider);
    const parent = providers[provider]?.extends;
    if (typeof parent !== 'string') return false;
    provider = parent;
  }
  return true;
}

export function automationPort(paseo: PaseoApi, approve: AutomationPort['approve']): AutomationPort {
  return {
    async list() {
      const agents: NativeAgent[] = [];
      const { config } = await paseo.config.get();
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
        agents.push(...result.entries.map(entry => ({ ...entry.agent, claudeProvider: isClaudeProvider(entry.agent.provider, config.providers) })));
        if (!result.pageInfo.hasMore) return { agents, truncated: false };
        if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return { agents, truncated: true };
    },
    async refresh(agentId) {
      const [result, { config }] = await Promise.all([paseo.agents.ref(agentId).refresh(), paseo.config.get()]);
      return result ? { ...result.agent, claudeProvider: isClaudeProvider(result.agent.provider, config.providers) } : null;
    },
    approve,
  };
}
