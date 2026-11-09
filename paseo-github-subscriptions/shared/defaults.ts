import { defineRpc } from '@getpaseo/plugin';
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

export const DefaultsSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  rules: AgentDefaultsSchema,
  error: z.string().nullable(),
});
export type DefaultsSnapshot = z.infer<typeof DefaultsSnapshotSchema>;

export const DefaultsSaveInputSchema = z.strictObject({
  enabled: z.boolean().optional(),
  rules: AgentDefaultsSchema.optional(),
});
export type DefaultsSaveInput = z.infer<typeof DefaultsSaveInputSchema>;

export const defaultsSnapshot = defineRpc({
  name: 'defaults.snapshot',
  input: z.object({}),
  output: DefaultsSnapshotSchema,
});

export const defaultsSave = defineRpc({
  name: 'defaults.save',
  input: DefaultsSaveInputSchema,
  output: DefaultsSnapshotSchema,
});
