import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** Claude 账号额度（模块 usage.claudeAccounts）的页面契约。RPC 约定见 #1737 评论 6728145308。 */
export const ClaudeAccountSchema = z.strictObject({
  providerId: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  appleLogin: z.boolean(),
  configDir: z.string(),
  needsRelogin: z.boolean(),
  remainingPct: z.number().nullable(),
});

export const ActiveFlowSchema = z.strictObject({
  providerId: z.string(),
  configDir: z.string(),
  /** 1 写配置 2 建目录 3 开终端 4 等浏览器登录 5 等授权码 6 读邮箱命名 */
  step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  terminalId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  loginUrl: z.string().nullable(),
  detectedEmail: z.string().nullable(),
  requiresRealEmailConfirmation: z.boolean(),
  error: z.string().nullable(),
});

export const ClaudeAccountsSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  accounts: z.array(ClaudeAccountSchema),
  quotaName: z.strictObject({
    enabled: z.boolean(),
    lowestRemainingPct: z.number().nullable(),
    autoResumeDefault: z.boolean(),
    hiddenBuiltinSources: z.array(z.string()),
  }),
  activeFlow: ActiveFlowSchema.nullable(),
  error: z.string().nullable(),
});
export type ClaudeAccountsSnapshot = z.infer<typeof ClaudeAccountsSnapshotSchema>;

export const claudeAccountsSnapshot = defineRpc({ name: 'claude-accounts.snapshot', input: z.object({}), output: ClaudeAccountsSnapshotSchema });
export const claudeAccountsConfigure = defineRpc({
  name: 'claude-accounts.configure',
  input: z.strictObject({ labelWithQuota: z.boolean().optional(), autoResumeDefault: z.boolean().optional() }),
  output: ClaudeAccountsSnapshotSchema,
});
export const claudeAccountsRename = defineRpc({
  name: 'claude-accounts.rename',
  input: z.strictObject({ providerId: z.string().min(1), label: z.string().min(1).max(80).optional(), realEmail: z.string().min(3).max(200).optional() }),
  output: ClaudeAccountsSnapshotSchema,
});
export const claudeAccountsLoginStart = defineRpc({
  name: 'claude-accounts.login.start',
  input: z.strictObject({ providerId: z.string().min(1).optional(), browserProfile: z.string().min(1).max(100).optional() }),
  output: ClaudeAccountsSnapshotSchema,
});
export const claudeAccountsLoginSubmitCode = defineRpc({
  name: 'claude-accounts.login.submit-code',
  input: z.strictObject({ providerId: z.string().min(1), code: z.string().min(1).max(4096), realEmail: z.string().min(3).max(200).optional() }),
  output: ClaudeAccountsSnapshotSchema,
});
export const claudeAccountsLoginRetry = defineRpc({
  name: 'claude-accounts.login.retry',
  input: z.strictObject({ providerId: z.string().min(1) }),
  output: ClaudeAccountsSnapshotSchema,
});

/** 聊天中额度不足卡片用：读取这个会话的自动继续状态，开关自动继续。 */
export const quotaRetryStatus = defineRpc({
  name: 'claude-accounts.retry-status',
  input: z.object({ agentId: z.string(), text: z.string().max(65536), messageId: z.string().optional() }),
  output: z.object({ retryAt: z.number().nullable(), enabled: z.boolean() }),
});
export const quotaSetAutoResume = defineRpc({
  name: 'claude-accounts.set-auto-resume',
  input: z.object({ agentId: z.string(), enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});
export const quotaRow = z.object({ text: z.string(), messageId: z.string().optional(), phase: z.enum(['streaming', 'complete']) });
