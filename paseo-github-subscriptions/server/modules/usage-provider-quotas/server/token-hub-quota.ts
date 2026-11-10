type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Token Hub 响应格式无效");
  return value as RecordValue;
}

function data(value: unknown): unknown {
  const response = record(value);
  if (response.errorCode !== 0 || response.data === undefined) throw new Error("Token Hub 请求未成功");
  return response.data;
}

function midnight(value: unknown): { text: string; time: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Token Hub 周期日期无效");
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw new Error("Token Hub 周期日期无效");
  return { text: `${value}T00:00:00+08:00`, time: utc - 8 * 60 * 60 * 1000 };
}

function decimal(value: unknown): { coefficient: bigint; scale: number } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Token Hub 额度数值无效");
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(value.toString());
  if (!match) throw new Error("Token Hub 额度数值无效");
  const fraction = match[2] ?? "";
  const scale = fraction.length - Number(match[3] ?? 0);
  const coefficient = BigInt(match[1]! + fraction);
  return scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale };
}

/** Parse shared account Credits for the current Shanghai cycle.
 * @param meta - Complete Token Hub analysis metadata response.
 * @param quota - Complete Token Hub Credits quota response.
 * @param nowMs - Current Unix time in milliseconds.
 * @returns Shared total, usage, remaining Credits and cycle timestamps.
 * @throws When the responses or current cycle cannot establish a valid balance.
 */
export function parseTokenHubCredits(meta: unknown, quota: unknown, nowMs: number): {
  total: number; used: number; remaining: number; remainingPct: number; periodStart: string; resetsAt: string;
} {
  const metadata = record(data(meta));
  if (metadata.zoneId !== "Asia/Shanghai") throw new Error("Token Hub 周期时区不受支持");
  const cycle = record(metadata.cycle);
  const start = midnight(cycle.startDate);
  const end = midnight(cycle.nextStartDate);
  if (!Number.isFinite(nowMs) || start.time >= end.time || nowMs < start.time || nowMs >= end.time) {
    throw new Error("Token Hub 额度周期无效或已过期");
  }
  const entries = data(quota);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Token Hub 额度列表无效");
  const values: Array<{ total: { coefficient: bigint; scale: number }; used: { coefficient: bigint; scale: number } }> = [];
  for (const item of entries) {
    const entry = record(item);
    const policy = record(entry.quotaPolicy);
    if (policy.type !== 0 && policy.type !== 1 && policy.type !== 2) throw new Error("Token Hub 资源包类型不受支持");
    if (typeof entry.quotaPolicyCount !== "number" || !Number.isSafeInteger(entry.quotaPolicyCount) || entry.quotaPolicyCount <= 0) {
      throw new Error("Token Hub 资源包数量无效");
    }
    const limit = decimal(policy.creditsQuota);
    const used = decimal(entry.credits);
    if (policy.type !== 2) values.push({ total: { coefficient: limit.coefficient * BigInt(entry.quotaPolicyCount), scale: limit.scale }, used });
  }
  if (values.length === 0) throw new Error("Token Hub 缺少共享额度");
  const scale = Math.max(...values.flatMap(value => [value.total.scale, value.used.scale]));
  const scaled = (value: { coefficient: bigint; scale: number }) => value.coefficient * 10n ** BigInt(scale - value.scale);
  const totalInt = values.reduce((sum, value) => sum + scaled(value.total), 0n);
  const usedInt = values.reduce((sum, value) => sum + scaled(value.used), 0n);
  const divisor = 10n ** BigInt(scale);
  if (totalInt <= 0n || totalInt > BigInt(Number.MAX_SAFE_INTEGER) * divisor || usedInt > BigInt(Number.MAX_SAFE_INTEGER) * divisor) {
    throw new Error("Token Hub 共享额度数值无效");
  }
  const asNumber = (value: bigint) => Number(`${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / divisor}.${((value < 0n ? -value : value) % divisor).toString().padStart(scale, "0")}`);
  const total = asNumber(totalInt);
  const used = asNumber(usedInt);
  const remaining = asNumber(totalInt - usedInt);
  return { total, used, remaining, remainingPct: remaining / total * 100, periodStart: start.text, resetsAt: end.text };
}
