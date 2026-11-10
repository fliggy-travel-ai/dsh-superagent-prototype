import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../storage.ts';

const timestamp = z.number().finite().nonnegative();
const contact = z.object({ at: timestamp, heartbeat: z.boolean().default(false), ended: z.boolean().default(false) });
const schema = z.object({ version: z.literal(1), contacts: z.record(z.string(), z.union([timestamp, contact])) });
export type CloudContact = z.infer<typeof contact>;
export interface CloudContactStore { load(): Record<string, CloudContact>; save(contacts: Record<string, CloudContact>): Promise<void> }
export function fileContactStore(path: string): CloudContactStore {
  let writes: Promise<unknown> = Promise.resolve();
  return {
    load() {
      try {
        const contacts = schema.parse(JSON.parse(readFileSync(path, 'utf8'))).contacts;
        return Object.fromEntries(Object.entries(contacts).map(([id, value]) => [id, typeof value === 'number' ? { at: value, heartbeat: false, ended: false } : value]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('云端联系记录损坏或无法读取，按空记录继续');
        return {};
      }
    },
    save(contacts) {
      const content = JSON.stringify({ version: 1, contacts });
      const next = writes.then(async () => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await atomicWrite(path, content); });
      writes = next.catch(() => {}); return next;
    },
  };
}
