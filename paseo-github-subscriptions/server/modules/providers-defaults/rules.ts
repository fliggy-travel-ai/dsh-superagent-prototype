import { z } from 'zod';

/**
 * 新建会话默认设置的规则（machine.json 的 `agentDefaults` 区块）。
 *
 * - `provider`：Provider ID，或 ID 列表；结尾 `*` 表示前缀匹配。
 * - `apply`：`missing`（默认）只在创建请求没有显式值时写入；`always` 无条件覆盖（沿用 Codex 旧插件的行为）。
 * - `modeId`：默认模式；`replaceModeIds` 列出视同“没有指定”的模式（例如 `auto`）。
 * - `features`：默认功能值；`removeFeatures`：要去掉的旧功能键。
 */
const ProviderPatternSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*\*?$/);
export const AgentDefaultRuleSchema = z.strictObject({
  provider: z.union([ProviderPatternSchema, z.array(ProviderPatternSchema).min(1)]),
  apply: z.enum(['missing', 'always']).default('missing'),
  modeId: z.string().min(1).optional(),
  replaceModeIds: z.array(z.string().min(1)).optional(),
  features: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  removeFeatures: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().default(true),
});
export const AgentDefaultsSchema = z.array(AgentDefaultRuleSchema);
export type AgentDefaultRule = z.infer<typeof AgentDefaultRuleSchema>;

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
