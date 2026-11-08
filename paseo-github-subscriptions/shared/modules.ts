import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const ModuleStateSchema = z.enum(['running', 'off', 'error']);
export type ModuleState = z.infer<typeof ModuleStateSchema>;

export const ModuleStatusSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  state: ModuleStateSchema,
  /** 关闭或出错的原因，已脱敏。 */
  reason: z.string().optional(),
  /** 最近一次未捕获的异步错误，模块仍在运行。 */
  lastUncaught: z.strictObject({ at: z.string(), summary: z.string() }).optional(),
});
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const ModulesSnapshotSchema = z.strictObject({
  instance: z.strictObject({ role: z.enum(['main', 'provider']), legacy: z.boolean() }),
  config: z.strictObject({ path: z.string(), source: z.enum(['file', 'default']), errors: z.array(z.string()) }),
  modules: z.array(ModuleStatusSchema),
});
export type ModulesSnapshot = z.infer<typeof ModulesSnapshotSchema>;

/** 模块状态，供页面显示“运行、关闭、出错和原因”。两个实例都注册。 */
export const modulesStatus = defineRpc({ name: 'modules.status', input: z.object({}), output: ModulesSnapshotSchema });
