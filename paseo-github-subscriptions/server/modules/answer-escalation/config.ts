import { z } from 'zod';
import { DeliverySchema } from '../../../shared/escalation.ts';
import { EscalationScheduleSchema, ImmediateWindowSchema, type EscalationSchedule } from '../../notify/schedule.ts';
import { WebhookConfigSchema } from './webhook.ts';

/**
 * machine.json 的 `escalation` 区块。全部有默认值：时段规则沿用旧插件文档的新加坡时间，
 * 等待时间 0 分钟（全天立即，与旧插件实际行为一致）。只有实际发送。
 * webhook 地址、凭据、服务名和本机路径只写在机器配置或 Keychain 里，不进仓库。
 */
export const EscalationSectionSchema = z.strictObject({
  /** 影子模式已删除。旧配置里的值照常读取，按实际发送处理（见 shadowNotice）。 */
  delivery: DeliverySchema.optional(),
  timezone: EscalationScheduleSchema.shape.timezone,
  immediate: z.array(ImmediateWindowSchema).default(EscalationScheduleSchema.parse({}).immediate),
  delayMinutes: EscalationScheduleSchema.shape.delayMinutes,
  webhook: WebhookConfigSchema.optional(),
  quotaAlerts: z.strictObject({
    enabled: z.boolean().default(true),
    /** 额度报警 webhook 的凭据文件目录（目录里有 url 和 key 两个文件）。 */
    fileDirectory: z.string().min(1).optional(),
  }).default({ enabled: true }),
  /** 新建项目、新建工作区时通知。 */
  newObjects: z.boolean().default(true),
  /** 发送前的预筛脚本；脚本输出 {"action":"suppress"} 时不发送。没有配置就不预筛。 */
  prefilter: z.strictObject({ command: z.string().min(1).default('/usr/bin/python3'), script: z.string().min(1) }).optional(),
  /** 旧插件状态目录，默认 `<Paseo 目录>/event-notifications`。 */
  legacyDirectory: z.string().min(1).optional(),
});
export type EscalationSection = z.infer<typeof EscalationSectionSchema>;
export const ESCALATION_FALLBACK: EscalationSection = EscalationSectionSchema.parse({});

/** 页面写入的设置，只保存改过的项。delivery 是旧页面写入的值，照常读取，不再使用。 */
export const RuntimeSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  delivery: DeliverySchema.optional(),
  timezone: EscalationScheduleSchema.shape.timezone.optional(),
  immediate: z.array(ImmediateWindowSchema).optional(),
  delayMinutes: EscalationScheduleSchema.shape.delayMinutes.optional(),
});
export interface RuntimeSettings {
  enabled: boolean;
  timezone: string;
  immediate: EscalationSchedule['immediate'];
  delayMinutes: number;
}
export const runtimeDefaults = (section: EscalationSection): RuntimeSettings => ({
  enabled: true,
  timezone: section.timezone,
  immediate: section.immediate,
  delayMinutes: section.delayMinutes,
});

/** 旧配置仍写着影子模式时的日志提示；没有就返回 null。 */
export function shadowNotice(section: EscalationSection, stored: { delivery?: string }): string | null {
  const places = [section.delivery === 'shadow' ? 'machine.json 的 escalation.delivery' : null, stored.delivery === 'shadow' ? '页面设置（escalation/settings.json）' : null].filter(Boolean);
  return places.length ? `${places.join('、')}写着 shadow：影子模式已删除，按实际发送处理。可以删掉这一项。` : null;
}
