import { z } from 'zod';

/**
 * machine.json 的 `claudeAccounts` 区块。全部有默认值。
 * `sourceId` 与旧插件相同（默认 claude-accounts），所以旧插件仍启用时整个模块拒绝启动（来源 ID 重复会让
 * 整个实例停止）；需要两个同时存在时，改成不同的来源 ID，但自动继续和显示名称仍会重复，不建议。
 */
export const ClaudeAccountsSectionSchema = z.strictObject({
  sourceId: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).default('claude-accounts'),
  /** 兼容旧 machine.json；Provider 显示名称带额度始终按开启处理。 */
  labelWithQuota: z.boolean().optional().transform(() => true),
  /** 额度耗尽后自动继续：没有单独选择过的会话（含新会话）的默认值。 */
  autoResumeDefault: z.boolean().default(false),
  /** 后台登录续期。 */
  renewal: z.boolean().default(true),
  legacyPluginId: z.string().min(1).default('claude-quota-resume'),
  /** 旧插件状态目录，默认 `<Paseo 目录>/claude-quota-resume`。 */
  legacyDirectory: z.string().min(1).optional(),
  /** 兼容旧 machine.json：添加账号引导已删除（由 Paseo 自带），这两项读到后忽略。 */
  loginGuide: z.unknown().optional().transform(() => undefined),
  loginWorkspaceName: z.unknown().optional().transform(() => undefined),
});
export type ClaudeAccountsSection = z.infer<typeof ClaudeAccountsSectionSchema>;
export const CLAUDE_ACCOUNTS_FALLBACK: ClaudeAccountsSection = ClaudeAccountsSectionSchema.parse({});

/** 页面写入的设置，只保存改过的项（兼容忽略旧文件中的 labelWithQuota）。 */
export const QuotaSettingsSchema = z.strictObject({
  labelWithQuota: z.boolean().optional(),
  autoResumeDefault: z.boolean().optional(),
}).transform(({ autoResumeDefault }) => (autoResumeDefault === undefined ? {} : { autoResumeDefault }));
export interface QuotaSettings { autoResumeDefault: boolean }
export const quotaDefaults = (section: ClaudeAccountsSection): QuotaSettings => ({ autoResumeDefault: section.autoResumeDefault });
