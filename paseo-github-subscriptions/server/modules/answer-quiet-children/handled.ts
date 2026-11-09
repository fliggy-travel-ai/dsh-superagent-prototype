import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 子会话免提醒的处理记录，供页面“最近处理的会话”和待办处理记录使用。 */
export interface HandledRecord {
  id: string;
  agentId: string;
  sessionTitle: string;
  eventKind: 'completed' | 'failed';
  clearedAttention: boolean;
  forwardedTo: string | null;
  forwardStatus: 'forwarded' | 'no-parent' | 'target-missing' | 'disabled';
  /** ISO 时间。 */
  at: string;
}

const DEDUPE_MS = 60_000;

export class HandledRecords {
  private records: HandledRecord[] = [];
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(path: string, limit = 100, now: () => number = Date.now) {
    this.path = path;
    this.limit = limit;
    this.now = now;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) this.records = parsed.filter(item => item && typeof item.id === 'string');
    } catch { /* 没有文件或损坏：从空记录开始 */ }
  }

  /** 同一会话同一类处理在一分钟内只记一条，避免状态更新反复写入。 */
  add(record: HandledRecord) {
    const recent = this.records.find(item => item.agentId === record.agentId && item.clearedAttention === record.clearedAttention && item.forwardStatus === record.forwardStatus
      && this.now() - Date.parse(item.at) < DEDUPE_MS && Math.abs(Date.parse(record.at) - Date.parse(item.at)) < DEDUPE_MS);
    if (recent) return;
    this.records.push(record);
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) { console.error('[开发自动化] 子会话处理记录暂时无法保存', error instanceof Error ? error.message : error); }
  }

  recent(count = 20): HandledRecord[] {
    return [...this.records].sort((left, right) => right.at.localeCompare(left.at)).slice(0, count);
  }
}
