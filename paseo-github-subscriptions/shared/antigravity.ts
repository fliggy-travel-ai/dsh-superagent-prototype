import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** Provider ID：必须以 antigravity- 开头。内置的 `antigravity` 和其他 Provider（cloud-session、claude 等）因此不会被占用；重复注册会停掉整个 Provider 实例。 */
export const ANTIGRAVITY_ID_PATTERN = /^antigravity-[a-z0-9][a-z0-9-]{0,31}$/;
export const ANTIGRAVITY_ID_MESSAGE = 'Provider ID 需以 antigravity- 开头，仅含小写字母、数字和连字符';

export const AntigravityAccountItemSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  homeDir: z.string().optional(),
});
export type AntigravityAccountItem = z.infer<typeof AntigravityAccountItemSchema>;

export const AntigravitySnapshotSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(AntigravityAccountItemSchema),
  runningSessionsCount: z.number().int().nonnegative(),
  reloadRequired: z.boolean(),
  error: z.string().nullable(),
});
export type AntigravitySnapshot = z.infer<typeof AntigravitySnapshotSchema>;

export const AntigravityAccountToggleInputSchema = z.object({
  providerId: z.string().min(1),
  enabled: z.boolean(),
});
export type AntigravityAccountToggleInput = z.infer<typeof AntigravityAccountToggleInputSchema>;

export const AntigravityAccountAddInputSchema = z.object({
  providerId: z.string().regex(ANTIGRAVITY_ID_PATTERN, ANTIGRAVITY_ID_MESSAGE),
  label: z.string().min(1),
  homeDir: z.string().min(1).optional(),
  proxy: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).nonempty().optional(),
});
export type AntigravityAccountAddInput = z.infer<typeof AntigravityAccountAddInputSchema>;

export const antigravitySnapshot = defineRpc({
  name: 'antigravity.snapshot',
  input: z.object({}),
  output: AntigravitySnapshotSchema,
});

export const antigravityAccountToggle = defineRpc({
  name: 'antigravity.account.toggle',
  input: AntigravityAccountToggleInputSchema,
  output: AntigravitySnapshotSchema,
});
export const antigravityToggleAccount = antigravityAccountToggle;

export const antigravityAccountAdd = defineRpc({
  name: 'antigravity.account.add',
  input: AntigravityAccountAddInputSchema,
  output: AntigravitySnapshotSchema,
});
export const antigravityAddAccount = antigravityAccountAdd;
