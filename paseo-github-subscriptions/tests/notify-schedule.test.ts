import test from 'node:test';
import assert from 'node:assert/strict';
import { EscalationScheduleSchema, holdAsked, inImmediateWindow, DEFAULT_IMMEDIATE_WINDOWS } from '../server/notify/schedule.ts';

const schedule = EscalationScheduleSchema.parse({ timezone: 'Asia/Singapore', immediate: DEFAULT_IMMEDIATE_WINDOWS, delayMinutes: 30 });
const at = (text: string) => Date.parse(text);

test('新加坡时间每天 01:00–09:30 立即，左闭右开', () => {
  assert.equal(inImmediateWindow(schedule, at('2026-11-08T01:00:00+08:00')), true);
  assert.equal(inImmediateWindow(schedule, at('2026-11-08T09:29:59+08:00')), true);
  assert.equal(inImmediateWindow(schedule, at('2026-11-08T09:30:00+08:00')), false);
  assert.equal(inImmediateWindow(schedule, at('2026-11-08T00:59:59+08:00')), false);
});

test('工作日 12:00–14:00 立即，周末不算', () => {
  assert.equal(inImmediateWindow(schedule, at('2026-11-09T12:00:00+08:00')), true);
  assert.equal(inImmediateWindow(schedule, at('2026-11-09T14:00:00+08:00')), false);
  assert.equal(inImmediateWindow(schedule, at('2026-11-08T13:00:00+08:00')), false);
  assert.equal(inImmediateWindow(schedule, at('2026-11-07T13:00:00+08:00')), false);
});

test('时区按配置换算，与运行机器的时区无关', () => {
  const utc = EscalationScheduleSchema.parse({ timezone: 'UTC', immediate: [{ days: 'daily', from: '00:00', to: '01:00' }], delayMinutes: 5 });
  assert.equal(inImmediateWindow(utc, at('2026-11-08T00:30:00Z')), true);
  assert.equal(inImmediateWindow(utc, at('2026-11-08T08:30:00+08:00')), true);
  assert.equal(inImmediateWindow(utc, at('2026-11-08T01:30:00Z')), false);
});

test('跨午夜的时段和指定星期', () => {
  const night = EscalationScheduleSchema.parse({ timezone: 'UTC', immediate: [{ days: [6], from: '22:00', to: '02:00' }], delayMinutes: 5 });
  assert.equal(inImmediateWindow(night, at('2026-11-07T23:00:00Z')), true);
  assert.equal(inImmediateWindow(night, at('2026-11-08T01:00:00Z')), true);
  assert.equal(inImmediateWindow(night, at('2026-11-08T03:00:00Z')), false);
  assert.equal(inImmediateWindow(night, at('2026-11-07T01:00:00Z')), false);
});

test('延后等待：时段外未满等待时间继续等，进入时段立即升级', () => {
  const hold = holdAsked(schedule);
  const first = at('2026-11-08T10:00:00+08:00');
  assert.equal(hold(first, first + 10 * 60_000), true);
  assert.equal(hold(first, first + 30 * 60_000), false);
  const evening = at('2026-11-08T00:50:00+08:00');
  assert.equal(hold(evening, evening + 15 * 60_000), false);
  assert.equal(hold(evening, evening + 1000), true);
});

test('等待时间为 0 时全天立即，与旧插件实际行为一致', () => {
  const hold = holdAsked(EscalationScheduleSchema.parse({}));
  const first = at('2026-11-08T10:00:00+08:00');
  assert.equal(hold(first, first), false);
});

test('配置校验：时区、时间格式、星期', () => {
  assert.throws(() => EscalationScheduleSchema.parse({ timezone: 'Nowhere/City' }));
  assert.throws(() => EscalationScheduleSchema.parse({ immediate: [{ days: 'daily', from: '25:00', to: '26:00' }] }));
  assert.throws(() => EscalationScheduleSchema.parse({ immediate: [{ days: [7], from: '01:00', to: '02:00' }] }));
  assert.throws(() => EscalationScheduleSchema.parse({ delayMinutes: -1 }));
});
