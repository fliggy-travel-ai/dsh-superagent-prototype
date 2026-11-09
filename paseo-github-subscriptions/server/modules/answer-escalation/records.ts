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
}

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
    if (index >= 0) this.records[index] = { ...record, acknowledged: this.records[index]!.acknowledged || record.acknowledged };
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

  pending(): EscalationRecord[] {
    const now = this.now();
    return this.records
      .filter(item => !item.acknowledged && item.status !== 'failed' && PENDING_EVENTS.has(item.event) && now - Date.parse(item.at) <= PENDING_MAX_AGE_MS)
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  recent(count = 30): EscalationRecord[] {
    return [...this.records].sort((left, right) => right.at.localeCompare(left.at)).slice(0, count);
  }
}
