export interface ParsedScheduleInput {
  cron: string;
  timezone: string | null;
  oneShot: boolean;
  description: string;
  nextRunAt: string;
}

export interface SchedulePreset {
  label: string;
  value: string;
  detail: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { label: '15 分钟后（单次）', value: 'in 15 minutes', detail: '单次执行' },
  { label: '1 小时后（单次）', value: 'in 1 hour', detail: '单次执行' },
  { label: '每 5 分钟', value: 'every 5 minutes', detail: '*/5 * * * *' },
  { label: '每 15 分钟', value: 'every 15 minutes', detail: '*/15 * * * *' },
  { label: '每 30 分钟', value: 'every 30 minutes', detail: '*/30 * * * *' },
  { label: '每小时', value: 'every hour', detail: '0 * * * *' },
  { label: '每天 09:00', value: 'every day at 9am', detail: '0 9 * * * (UTC)' },
  { label: '工作日 09:00', value: 'weekdays at 9am', detail: '0 9 * * 1-5 (UTC)' },
];

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  five: 5,
  ten: 10,
  fifteen: 15,
  thirty: 30,
};

const BOUNDS = [
  { min: 0, max: 59, name: '分钟' },
  { min: 0, max: 23, name: '小时' },
  { min: 1, max: 31, name: '日期' },
  { min: 1, max: 12, name: '月份' },
  { min: 0, max: 6, name: '星期' },
] as const;

function parseNumber(source: string): number | null {
  const word = WORD_NUMBERS[source];
  if (word !== undefined) return word;
  if (!/^\d+$/.test(source)) return null;
  const number = Number.parseInt(source, 10);
  return Number.isSafeInteger(number) ? number : null;
}

function durationMs(amount: number, unit: string): number {
  const hours = /^(?:h|hr|hrs|hour|hours|小时|时)$/.test(unit);
  return amount * (hours ? 60 * 60_000 : 60_000);
}

function cronForInterval(milliseconds: number): string | null {
  const minutes = milliseconds / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes === 60) return '0 * * * *';
  if (minutes % 60 !== 0) return null;
  const hours = minutes / 60;
  if (hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (hours === 24) return '0 0 * * *';
  return null;
}

function oneShotCron(target: Date): string {
  return `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`;
}

function startOfNextMinute(date: Date): Date {
  const next = new Date(date);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

function ceilToMinute(date: Date): Date {
  const result = new Date(date);
  if (result.getUTCSeconds() === 0 && result.getUTCMilliseconds() === 0) return result;
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(result.getUTCMinutes() + 1);
  return result;
}

function allowedValues(source: string, bounds: (typeof BOUNDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const rawPart of source.split(',')) {
    const parts = rawPart.trim().split('/');
    if (parts.length > 2) throw new Error(`无效的 Cron ${bounds.name}步长`);
    const [base = '', stepSource] = parts;
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (
      !Number.isInteger(step) ||
      step <= 0 ||
      (stepSource !== undefined && String(step) !== stepSource)
    ) {
      throw new Error(`无效的 Cron ${bounds.name}步长`);
    }
    let start: number;
    let end: number;
    if (base === '*') {
      start = bounds.min;
      end = bounds.max;
    } else {
      const range = base.match(/^(\d+)-(\d+)$/);
      if (range) {
        start = Number.parseInt(range[1]!, 10);
        end = Number.parseInt(range[2]!, 10);
      } else if (/^\d+$/.test(base)) {
        // Paseo 0.16 (#8607) 拒绝 0/15 这类在单数字后带步长的写法，需要写成 */15 或 0-59/15。
        if (stepSource !== undefined) {
          throw new Error(`Cron ${bounds.name}字段不支持单数字步长（如 ${base}/${stepSource}），请改用 */${stepSource} 或范围步长`);
        }
        start = Number.parseInt(base, 10);
        end = start;
      } else {
        throw new Error(`无效的 Cron ${bounds.name}取值`);
      }
    }
    if (start < bounds.min || end > bounds.max || start > end) {
      throw new Error(`Cron ${bounds.name}范围超出限制`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`无效的 Cron ${bounds.name}字段`);
  return values;
}

function parseCron(expression: string): readonly Set<number>[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('请输入延迟时间（如 15m）、周期短语（如 every 15 minutes / 每 15 分钟）或五段式 Cron 表达式。');
  }
  return fields.map((field, index) => allowedValues(field, BOUNDS[index]!));
}

export function nextCronRun(expression: string, after: Date): Date {
  const fields = parseCron(expression);
  let cursor = startOfNextMinute(after);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (
      fields[0]!.has(cursor.getUTCMinutes()) &&
      fields[1]!.has(cursor.getUTCHours()) &&
      fields[2]!.has(cursor.getUTCDate()) &&
      fields[3]!.has(cursor.getUTCMonth() + 1) &&
      fields[4]!.has(cursor.getUTCDay())
    ) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error('该 Cron 表达式在未来一年内没有匹配的运行时间。');
}

function intervalDescription(milliseconds: number): string {
  const minutes = milliseconds / 60_000;
  if (minutes === 60) return '每小时';
  if (minutes === 24 * 60) return '每天';
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

export function parseScheduleInput(source: string, now = new Date()): ParsedScheduleInput {
  const normalized = source.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('请输入心跳运行时间。');

  if (normalized === 'hourly' || normalized === 'every hour' || normalized === '每小时') {
    const cron = '0 * * * *';
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: '每小时',
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }
  if (
    normalized === 'daily' ||
    normalized === 'every day' ||
    normalized === '每天' ||
    normalized === 'every day at 9am' ||
    normalized === '每天 09:00' ||
    normalized === '每天 9:00'
  ) {
    const atNine = normalized.endsWith('9am') || normalized.endsWith('09:00') || normalized.endsWith('9:00');
    const cron = atNine ? '0 9 * * *' : '0 0 * * *';
    const description = atNine ? '每天 09:00 UTC' : '每天 00:00 UTC';
    return {
      cron,
      timezone: null,
      oneShot: false,
      description,
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }
  if (normalized === 'weekdays at 9am' || normalized === '工作日 09:00' || normalized === '工作日 9:00') {
    const cron = '0 9 * * 1-5';
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: '工作日 09:00 UTC',
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }

  const recurring =
    normalized.match(/^every\s+(\d+|[a-z]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/) ??
    normalized.match(/^每\s*(\d+)\s*(分钟|分|小时|时)$/);
  if (recurring) {
    const amount = parseNumber(recurring[1]!);
    if (!amount || amount <= 0) throw new Error('循环间隔必须为正整数。');
    const milliseconds = durationMs(amount, recurring[2]!);
    const cron = cronForInterval(milliseconds);
    if (!cron) {
      throw new Error(
        '该间隔无法精确表示为五段式 Cron，请使用 5、10、15、20、30 分钟，或 1、2、3、4、6、8、12、24 小时。',
      );
    }
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: intervalDescription(milliseconds),
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }

  const oneShot =
    normalized.match(/^(?:in\s+)?(\d+|[a-z]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/) ??
    normalized.match(/^(\d+)\s*(分钟|分|小时|时)(?:后|之后)?$/);
  if (oneShot) {
    const amount = parseNumber(oneShot[1]!);
    if (!amount || amount <= 0) throw new Error('延迟时间必须为正整数。');
    const milliseconds = durationMs(amount, oneShot[2]!);
    const minimum = now.getTime() + milliseconds;
    const target = ceilToMinute(new Date(minimum));
    if (!Number.isFinite(target.getTime())) throw new Error('延迟时间过大。');
    const cron = oneShotCron(target);
    if (nextCronRun(cron, now).getTime() !== target.getTime()) {
      throw new Error('单次延迟时间必须在未来一年内。');
    }
    return {
      cron,
      timezone: 'UTC',
      oneShot: true,
      description: `单次执行 · ${target.toLocaleString()}`,
      nextRunAt: target.toISOString(),
    };
  }

  const cron = source.trim().replace(/\s+/g, ' ');
  const next = nextCronRun(cron, now);
  return {
    cron,
    timezone: null,
    oneShot: false,
    description: describeCron(cron),
    nextRunAt: next.toISOString(),
  };
}

export function describeCron(cron: string): string {
  const minuteStep = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minuteStep) return `每 ${minuteStep[1]} 分钟`;
  const hourStep = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourStep) return `每 ${hourStep[1]} 小时`;
  if (cron === '0 * * * *') return '每小时';
  if (cron === '0 0 * * *') return '每天 00:00';
  if (cron === '0 9 * * *') return '每天 09:00';
  if (cron === '0 9 * * 1-5') return '工作日 09:00';
  return '自定义 Cron';
}
