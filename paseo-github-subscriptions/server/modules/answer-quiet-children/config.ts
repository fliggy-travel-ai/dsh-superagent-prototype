import { z } from 'zod';

/** machine.json 的 `quietChildren` 区块。免提醒默认开；事件转发默认关（打开后会向主会话发消息）。 */
export const QuietSectionSchema = z.strictObject({
  enabled: z.boolean().default(true),
  forwardEvents: z.boolean().default(false),
  /** 旧事件通知插件的 ID。它仍启用时不转发事件，避免同一事件发两次。 */
  legacyForwarderId: z.string().min(1).default('event-notifications'),
});
export type QuietSection = z.infer<typeof QuietSectionSchema>;
export const QUIET_FALLBACK: QuietSection = QuietSectionSchema.parse({});

export const QuietSettingsSchema = z.strictObject({ enabled: z.boolean().optional(), forwardEvents: z.boolean().optional() });
export interface QuietSettings { enabled: boolean; forwardEvents: boolean }
export const quietDefaults = (section: QuietSection): QuietSettings => ({ enabled: section.enabled, forwardEvents: section.forwardEvents });
