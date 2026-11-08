import { z } from 'zod';

/**
 * 升级通知的时段规则。时段内的待答问题立即升级；时段外先等 `delayMinutes` 分钟，
 * 到点或进入立即时段后才升级。`delayMinutes` 为 0 时全天立即（旧插件的实际行为）。
 * 时间按 `timezone` 换算，和运行机器的时区无关。
 */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式为 HH:MM');
const Days = z.union([z.enum(['daily', 'weekdays', 'weekends']), z.array(z.number().int().min(0).max(6)).min(1)]);
export const ImmediateWindowSchema = z.strictObject({ days: Days.default('daily'), from: Time, to: Time });
export type ImmediateWindow = z.infer<typeof ImmediateWindowSchema>;

export const DEFAULT_IMMEDIATE_WINDOWS: ImmediateWindow[] = [
  { days: 'daily', from: '01:00', to: '09:30' },
  { days: 'weekdays', from: '12:00', to: '14:00' },
];

const Timezone = z.string().refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, '不是有效的时区');
export const EscalationScheduleSchema = z.strictObject({
  timezone: Timezone.default('Asia/Singapore'),
  immediate: z.array(ImmediateWindowSchema).default(DEFAULT_IMMEDIATE_WINDOWS),
  delayMinutes: z.number().int().min(0).max(24 * 60).default(0),
});
export type EscalationSchedule = z.infer<typeof EscalationScheduleSchema>;

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

function localParts(timezone: string, now: number): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { day: WEEKDAY[value('weekday') as keyof typeof WEEKDAY], minutes: Number(value('hour')) * 60 + Number(value('minute')) };
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const dayMatches = (days: ImmediateWindow['days'], day: number) =>
  Array.isArray(days) ? days.includes(day) : days === 'daily' || (days === 'weekdays' ? day >= 1 && day <= 5 : day === 0 || day === 6);

/** 跨午夜的时段（from 晚于 to）：`days` 按晚上开始的那一天算。 */
export function inImmediateWindow(schedule: Pick<EscalationSchedule, 'timezone' | 'immediate'>, now: number): boolean {
  const { day, minutes } = localParts(schedule.timezone, now);
  return schedule.immediate.some(window => {
    const from = minutesOf(window.from);
    const to = minutesOf(window.to);
    if (from <= to) return dayMatches(window.days, day) && minutes >= from && minutes < to;
    if (minutes >= from) return dayMatches(window.days, day);
    return minutes < to && dayMatches(window.days, (day + 6) % 7);
  });
}

/** 给通知引擎用：返回 true 表示问题还要继续等待。 */
export function holdAsked(schedule: EscalationSchedule): (firstSeenAt: number, now: number) => boolean {
  return (firstSeenAt, now) => schedule.delayMinutes > 0 && !inImmediateWindow(schedule, now) && now - firstSeenAt < schedule.delayMinutes * 60_000;
}
