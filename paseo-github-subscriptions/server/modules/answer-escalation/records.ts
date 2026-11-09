import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 升级通知的页面记录：每次升级（影子记录、实际送达或失败）一条，供“待办总览”的升级事件和
 * 最近投递使用。与通知引擎的状态分开存放，页面标为已处理不影响引擎去重。
 */
export interface EscalationRecord {
  id: string;
  event: string;
  agentId: string;
  sessionTitle: string;
  workspaceId: string | null;
  questionText: string;
  summary: string;
  /** ISO 时间。 */
  at: string;
  delivery: 'shadow' | 'live';
  status: 'delivered' | 'recorded-shadow' | 'failed';
  acknowledged: boolean;
  /** 来源提问（合并通知含全部提问成员）。旧记录没有，启动时从审计日志回填。 */
  requests?: Array<{ agentId: string; requestId: string; done?: boolean }>;
  /** 来源不再等待时自动结束的时间（ISO）和原因。 */
  closedAt?: string;
  closedReason?: ClosedReason;
}

/** resolved：提问已回答、取消或权限已处理；session-*：会话不存在、已归档、已关闭，或出错后已继续运行。 */
export type ClosedReason = 'resolved' | 'session-gone' | 'session-archived' | 'session-closed' | 'session-resumed';
export const CLOSED_REASON_TEXT: Record<ClosedReason, string> = {
  resolved: '提问已回答或已取消',
  'session-gone': '会话已不存在',
  'session-archived': '会话已归档',
  'session-closed': '会话已关闭',
  'session-resumed': '会话已继续运行',
};

/** 对账时看到的会话现状；null 表示 Paseo 中查不到这个会话。 */
export type AgentView = { status: string | null; archivedAt: string | null; pending: string[] } | null;

const PENDING_EVENTS = new Set(['asked', 'error']);
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;

export class EscalationRecords {
  private records: EscalationRecord[] = [];
  private readonly path: string;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(path: string, now: () => number = Date.now, limit = 200) {
    this.path = path;
    this.now = now;
    this.limit = limit;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) this.records = parsed.filter(item => item && typeof item.id === 'string');
    } catch { /* 没有文件或损坏：从空记录开始 */ }
  }

  private save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) { console.error('[开发自动化] 升级记录暂时无法保存', error instanceof Error ? error.message : error); }
  }

  /** 同一编号再次写入时更新（失败后重试送达），保留“已处理”标记。 */
  upsert(record: EscalationRecord) {
    const index = this.records.findIndex(item => item.id === record.id);
    const previous = index >= 0 ? this.records[index]! : null;
    // 先结束、后重试送达时保留结束状态，不让已结束的事件回到待办。
    if (previous) this.records[index] = {
      ...record, acknowledged: previous.acknowledged || record.acknowledged,
      ...(previous.requests ? { requests: previous.requests } : {}),
      ...(previous.closedAt ? { closedAt: previous.closedAt, closedReason: previous.closedReason } : {}),
    };
    else this.records.push(record);
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    this.save();
  }

  acknowledge(id: string): boolean {
    const record = this.records.find(item => item.id === id);
    if (!record) return false;
    if (!record.acknowledged) { record.acknowledged = true; this.save(); }
    return true;
  }

  /** 尚未结束的提问和错误记录。投递失败的不进待办，但同样跟踪结束，免得重试送达后又回到待办。 */
  private open(): EscalationRecord[] {
    return this.records.filter(item => !item.acknowledged && !item.closedAt && PENDING_EVENTS.has(item.event));
  }

  pending(): EscalationRecord[] {
    const now = this.now();
    return this.open()
      .filter(item => item.status !== 'failed' && now - Date.parse(item.at) <= PENDING_MAX_AGE_MS)
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  /** 有未结束记录的会话，供对账逐个查询。 */
  agentsWithOpen(): string[] {
    const ids = new Set<string>();
    for (const item of this.open()) {
      if (item.agentId) ids.add(item.agentId);
      for (const request of item.requests ?? []) if (!request.done) ids.add(request.agentId);
    }
    return [...ids];
  }

  private finish(item: EscalationRecord, reason: ClosedReason) {
    item.closedAt = new Date(this.now()).toISOString();
    item.closedReason = reason;
  }

  /** 一个来源提问不再等待。记录的全部提问都结束时自动结束，返回本次结束的记录。 */
  closeRequest(agentId: string, requestId: string, reason: ClosedReason = 'resolved'): EscalationRecord[] {
    const closed: EscalationRecord[] = [];
    let changed = false;
    for (const item of this.open()) {
      const request = item.requests?.find(r => r.agentId === agentId && r.requestId === requestId && !r.done);
      if (!request) continue;
      request.done = true;
      changed = true;
      if (item.requests!.every(r => r.done)) { this.finish(item, reason); closed.push(item); }
    }
    if (changed) this.save();
    return closed;
  }

  /**
   * 按会话现状对账。会话查不到、已归档、已关闭：全部结束。
   * 提问：请求已不在等待列表中就结束；旧记录不知道请求编号时，会话没有任何等待中的请求才结束。
   * 错误：会话已继续运行才结束。
   */
  settleAgent(agentId: string, view: AgentView): EscalationRecord[] {
    const closed: EscalationRecord[] = [];
    const whole: ClosedReason | null = !view ? 'session-gone' : view.archivedAt ? 'session-archived' : view.status === 'closed' ? 'session-closed' : null;
    let changed = false;
    for (const item of this.open()) {
      const mine = (item.requests ?? []).filter(r => r.agentId === agentId && !r.done);
      if (item.agentId !== agentId && !mine.length) continue;
      if (whole) {
        for (const request of mine) request.done = true;
        changed ||= mine.length > 0;
        if ((item.requests ?? []).every(r => r.done)) { this.finish(item, whole); closed.push(item); }
        continue;
      }
      if (item.event === 'error') {
        if (view!.status === 'running') { this.finish(item, 'session-resumed'); closed.push(item); }
        continue;
      }
      if (!item.requests?.length) {
        if (!view!.pending.length) { this.finish(item, 'resolved'); closed.push(item); }
        continue;
      }
      for (const request of mine) if (!view!.pending.includes(request.requestId)) { request.done = true; changed = true; }
      if (item.requests.every(r => r.done)) { this.finish(item, 'resolved'); closed.push(item); }
    }
    if (closed.length || changed) this.save();
    return closed;
  }

  /** 从审计日志（events.jsonl 的行）按通知编号回填旧记录的请求编号，返回回填条数。 */
  backfillRequests(lines: Iterable<string>): number {
    const missing = new Map(this.records.filter(item => !item.requests && PENDING_EVENTS.has(item.event)).map(item => [item.id, item]));
    if (!missing.size) return 0;
    let filled = 0;
    for (const line of lines) {
      if (!missing.size) break;
      let entry: { notice?: Parameters<typeof requestsOf>[0] };
      try { entry = JSON.parse(line); } catch { continue; }
      const item = entry?.notice?.id ? missing.get(entry.notice.id) : undefined;
      if (!item) continue;
      const requests = requestsOf(entry.notice!);
      missing.delete(item.id);
      if (!requests) continue;
      item.requests = requests;
      filled++;
    }
    if (filled) this.save();
    return filled;
  }

  /** 最近自动结束的记录，供待办的处理记录显示。 */
  closures(count = 30): EscalationRecord[] {
    return this.records.filter(item => item.closedAt).sort((left, right) => right.closedAt!.localeCompare(left.closedAt!)).slice(0, count);
  }

  recent(count = 30): EscalationRecord[] {
    return [...this.records].sort((left, right) => right.at.localeCompare(left.at)).slice(0, count);
  }
}

interface NoticeLike { id?: string; event?: string; agentId?: string; requestId?: string | null; events?: NoticeLike[] }

/** 通知里的来源提问：单条取自身，合并通知取全部提问成员，去重。没有就返回 undefined。 */
export function requestsOf(notice: NoticeLike): EscalationRecord['requests'] {
  const requests: Array<{ agentId: string; requestId: string }> = [];
  for (const member of notice.events?.length ? notice.events : [notice]) {
    if (member?.event !== 'asked' || typeof member.requestId !== 'string' || !member.requestId || typeof member.agentId !== 'string') continue;
    if (!requests.some(r => r.agentId === member.agentId && r.requestId === member.requestId)) requests.push({ agentId: member.agentId, requestId: member.requestId });
  }
  return requests.length ? requests : undefined;
}
