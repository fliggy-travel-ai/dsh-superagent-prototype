import { AgentDefaultRuleSchema, AgentDefaultsSchema, type AgentDefaultRule } from '../../../shared/defaults.ts';

// 规则结构定义在 shared/defaults.ts（客户端也要用；Paseo 插件编译器不允许 shared/ 引入 server/）。
export { AgentDefaultRuleSchema, AgentDefaultsSchema, type AgentDefaultRule };

interface CreateRequest { config: { provider: string; modeId?: string; featureValues?: Record<string, unknown> } }

const matches = (pattern: string, provider: string) => pattern.endsWith('*') ? provider.startsWith(pattern.slice(0, -1)) : pattern === provider;

export function applyAgentDefaults<Request extends CreateRequest>(request: Request, rules: readonly AgentDefaultRule[]): Request {
  let config = request.config;
  let changed = false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const patterns = Array.isArray(rule.provider) ? rule.provider : [rule.provider];
    if (!patterns.some(pattern => matches(pattern, config.provider))) continue;
    const always = rule.apply === 'always';
    const next = { ...config };
    if (rule.modeId && (always || !next.modeId || rule.replaceModeIds?.includes(next.modeId))) next.modeId = rule.modeId;
    if (rule.features || rule.removeFeatures) {
      const features: Record<string, unknown> = { ...next.featureValues };
      for (const key of rule.removeFeatures ?? []) delete features[key];
      for (const [key, value] of Object.entries(rule.features ?? {})) if (always || !(key in features)) features[key] = value;
      next.featureValues = features;
    }
    config = next;
    changed = true;
  }
  return changed ? { ...request, config } : request;
}
