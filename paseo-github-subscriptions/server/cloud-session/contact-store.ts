import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../storage.ts';

const schema = z.object({ version: z.literal(1), contacts: z.record(z.string(), z.number().finite().nonnegative()) });
export interface CloudContactStore { load(): Record<string, number>; save(contacts: Record<string, number>): Promise<void> }
export function fileContactStore(path: string): CloudContactStore {
  let writes: Promise<unknown> = Promise.resolve();
  return {
    load() {
      try { return schema.parse(JSON.parse(readFileSync(path, 'utf8'))).contacts; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw Error('云端联系记录无法读取'); }
    },
    save(contacts) {
      const content = JSON.stringify({ version: 1, contacts });
      const next = writes.then(async () => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await atomicWrite(path, content); });
      writes = next.catch(() => {}); return next;
    },
  };
}
