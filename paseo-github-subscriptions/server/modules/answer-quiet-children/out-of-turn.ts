import { isAntigravityProvider, summarize } from '../../../shared/out-of-turn.ts';

/**
 * Antigravity 子会话本轮外续跑跟踪（方案 A，#2258）。
 *
 * Antigravity 的后台命令（IsDaemon）不保持本轮；命令结束后它自己继续工作，但这些时间线事件没有 turnId，
 * 会话一直是 idle，不触发回合事件，主会话收不到完成通知。这里在子会话时间线订阅上识别这类事件，
 * 静默 quietMs 后报告一次“后台续跑已结束”，由转发模块发给主会话。不给子会话发任何消息。
 */

export interface StreamEvent {
  type: string;
  provider?: string;
  turnId?: string | null;
  item?: { type: string; text?: string; status?: string; callId?: string; messageId?: string };
}

export interface OutOfTurnReport {
  agentId: string;
  provider: string;
  firstAt: string;
  lastAt: string;
  count: number;
  /** 静默时仍处于运行状态的本轮外工具调用数（可能是常驻服务）。 */
  runningTools: number;
  lastAssistant: string | null;
}

export interface TrackerOptions {
  quietMs?: number;
  /** 有运行中的工具时最多再等多久，超过后照常报告（常驻服务不会结束）。 */
  runningCapMs?: number;
  /** 早于此时长的事件视为历史回放，不报告。 */
  maxAgeMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  report: (report: OutOfTurnReport) => void;
}

interface Run {
  provider: string;
  firstAt: number;
  lastAt: number;
  count: number;
  tools: Map<string, string>;
  /** messageId → 已拼接的文本；最后一条助手消息取 lastMessageId。 */
  messages: Map<string, string>;
  lastMessageId: string | null;
  timer: unknown;
}

const counts = (item: NonNullable<StreamEvent['item']>) =>
  item.type === 'tool_call' || item.type === 'reasoning' ||
  (item.type === 'assistant_message' && !(item.text ?? '').trimStart().startsWith('[System Error]'));

export class OutOfTurnTracker {
  private readonly runs = new Map<string, Run>();
  private readonly quietMs: number;
  private readonly runningCapMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly report: (report: OutOfTurnReport) => void;

  constructor(options: TrackerOptions) {
    this.quietMs = options.quietMs ?? 60_000;
    this.runningCapMs = options.runningCapMs ?? 10 * 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.report = options.report;
  }

  /** 子会话时间线订阅收到的每个事件。provider 取事件自带的，缺省用会话登记的。 */
  observe(agentId: string, event: StreamEvent, at: number = this.now(), agentProvider?: string | null) {
    if (event.type === 'turn_started') { this.drop(agentId); return; }
    if (event.type !== 'timeline' || event.turnId || !event.item) return;
    const provider = event.provider ?? agentProvider ?? '';
    if (!isAntigravityProvider(provider) || !counts(event.item)) return;
    if (this.now() - at > this.maxAgeMs) return;
    let run = this.runs.get(agentId);
    if (!run) {
      run = { provider, firstAt: at, lastAt: at, count: 0, tools: new Map(), messages: new Map(), lastMessageId: null, timer: null };
      this.runs.set(agentId, run);
    }
    run.count++;
    run.lastAt = Math.max(run.lastAt, at);
    const item = event.item;
    if (item.type === 'tool_call' && item.callId) run.tools.set(item.callId, item.status ?? '');
    if (item.type === 'assistant_message') {
      // 实时事件按分片到达，同一 messageId 拼接。
      const id = item.messageId ?? `message-${run.count}`;
      run.messages.set(id, (run.messages.get(id) ?? '') + (item.text ?? ''));
      run.lastMessageId = id;
    }
    this.schedule(agentId, run, this.quietMs);
  }

  /** 会话归档、关闭或不再是子会话时丢弃。 */
  drop(agentId: string) {
    const run = this.runs.get(agentId);
    if (!run) return;
    this.clearTimer(run.timer);
    this.runs.delete(agentId);
  }

  dropAll() { for (const id of [...this.runs.keys()]) this.drop(id); }

  pending(): string[] { return [...this.runs.keys()]; }

  private schedule(agentId: string, run: Run, ms: number) {
    this.clearTimer(run.timer);
    run.timer = this.setTimer(() => this.settle(agentId, run), ms);
  }

  private settle(agentId: string, run: Run) {
    if (this.runs.get(agentId) !== run) return;
    const running = [...run.tools.values()].filter(status => status === 'running' || status === 'pending').length;
    const waited = this.now() - run.lastAt;
    if (running > 0 && waited < this.runningCapMs) {
      this.schedule(agentId, run, Math.min(this.quietMs, this.runningCapMs - waited));
      return;
    }
    this.runs.delete(agentId);
    const text = run.lastMessageId ? run.messages.get(run.lastMessageId) ?? null : null;
    this.report({
      agentId, provider: run.provider,
      firstAt: new Date(run.firstAt).toISOString(), lastAt: new Date(run.lastAt).toISOString(),
      count: run.count, runningTools: running, lastAssistant: summarize(text),
    });
  }
}
