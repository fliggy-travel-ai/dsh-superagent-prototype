import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MigrationRecord { state: 'in_progress' | 'needs_review'; autoResume?: boolean; reason?: string; trigger?: string; phase?: 'locking' | 'started'; lease?: string }
/** 迁移开始前落盘；中断和结果不明的记录保留到人工核查。 */
export class MigrationJournal {
  private records: Record<string, MigrationRecord> = {};
  private chain: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  async load() {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('迁移记录格式无效');
      const loaded: Record<string, MigrationRecord> = {};
      for (const [id, record] of Object.entries(value)) {
        if (!record || typeof record !== 'object' || !['in_progress', 'needs_review'].includes((record as MigrationRecord).state)) throw Error('迁移记录格式无效');
        loaded[id] = record as MigrationRecord;
      }
      this.records = loaded;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  get(id: string) { return this.records[id]; }
  entries() { return Object.entries(this.records); }
  private change(fn: (next: Record<string, MigrationRecord>) => void) {
    const operation = this.chain.then(async () => {
      const next = { ...this.records }; fn(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path); this.records = next;
    });
    this.chain = operation.catch(() => {}); return operation;
  }
  begin(id: string, lease: string, trigger: string) { return this.change(next => { if (next[id]) throw Error('needs_review'); next[id] = { state: 'in_progress', phase: 'locking', lease, trigger }; }); }
  markStarted(id: string) { return this.change(next => { if (!next[id]) throw Error('missing_journal'); next[id] = { ...next[id], phase: 'started' }; }); }
  saveResume(id: string, autoResume: boolean) { return this.change(next => { if (!next[id]) throw Error('missing_journal'); next[id] = { ...next[id], autoResume }; }); }
  review(id: string, reason: string) { return this.change(next => { next[id] = { ...next[id], state: 'needs_review', reason }; }); }
  finish(id: string) { return this.change(next => { delete next[id]; }); }
  async verifyMissing(id: string) { const records = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, MigrationRecord>; return !(id in records); }
}
