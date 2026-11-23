/**
 * Antigravity 本轮外续跑的判定（主实例转发模块和巡检脚本共用，纯数据，无运行时依赖）。
 *
 * 实测（#2258，Paseo 0.17.1）：Antigravity 把后台命令（IsDaemon）留在本轮之外，本轮先结束；
 * 命令结束后它会自己继续推理、调用工具、回复，但这些时间线条目没有 turnId，会话状态一直是 idle，
 * 不触发回合事件。判定依据就是“时间线上最后一个带 turnId 的条目之后，还有不带 turnId 的条目”。
 */

/** Paseo 内置 Antigravity 提供方及其多账号派生（antigravity-cy517 等）。 */
export function isAntigravityProvider(provider: string | null | undefined): boolean {
  return provider === 'antigravity' || (typeof provider === 'string' && provider.startsWith('antigravity-'));
}

export interface TimelineEntryLike {
  turnId?: string | null;
  timestamp?: string;
  item: { type: string; text?: string; status?: string; name?: string; detail?: { type?: string; command?: string } };
}

export interface OutOfTurnState {
  /** 最后一个带 turnId 的条目之后、不带 turnId 的有效条目数。 */
  count: number;
  /** 其中最后一条的时间。 */
  lastAt: string | null;
  /** 仍在运行的本轮外工具调用数。 */
  running: number;
  /** 本轮外最后一条助手消息。 */
  lastAssistant: string | null;
}

/** 不算续跑的条目：用户消息、系统通知、提供方连接错误提示。 */
function counts(item: TimelineEntryLike['item']): boolean {
  if (item.type === 'tool_call' || item.type === 'reasoning') return true;
  if (item.type !== 'assistant_message') return false;
  return !(item.text ?? '').trimStart().startsWith('[System Error]');
}

/** 按时间线顺序（旧到新）计算本轮外续跑状态。同一工具调用多次出现时按最后一次的状态计。 */
export function outOfTurnState(entries: readonly TimelineEntryLike[]): OutOfTurnState {
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.turnId) { start = index + 1; break; }
  }
  let count = 0;
  let lastAt: string | null = null;
  let lastAssistant: string | null = null;
  const tools = new Map<string, string>();
  for (const entry of entries.slice(start)) {
    if (entry.turnId || !counts(entry.item)) continue;
    count++;
    if (entry.timestamp) lastAt = entry.timestamp;
    // 投影后的时间线已把同一条消息的分片合并成一个条目。
    if (entry.item.type === 'assistant_message') lastAssistant = entry.item.text ?? '';
    if (entry.item.type === 'tool_call') tools.set(String((entry.item as { callId?: string }).callId ?? count), entry.item.status ?? '');
  }
  const running = [...tools.values()].filter(status => status === 'running' || status === 'pending').length;
  return { count, lastAt, running, lastAssistant: lastAssistant?.trim() || null };
}

/** 摘要：取最后一段，最多 limit 个字符。 */
export function summarize(text: string | null, limit = 600): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}
