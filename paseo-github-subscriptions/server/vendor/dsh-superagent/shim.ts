import { createHash } from 'node:crypto';
import type { z } from 'zod';

export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
}

export interface ChannelRef { source: string; thread: string; address: Record<string, string> }
export interface ThreadRef { source: string; id: string }
export interface ActorRef { source: string; id: string }
export interface Trigger {
  id: string;
  source: string;
  threads: ThreadRef[];
  actor: ActorRef;
  human: boolean;
  addressed?: 'mention';
  at: string;
  text: string;
  channel?: ChannelRef;
  url?: string;
  meta: Record<string, unknown>;
}

export type Text = string | { zh: string; en: string };
export interface ThreadFact { label?: Text; value: Text; problem?: true }

export interface ContextMessage {
  id: string; from: string; at: string; text: string;
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number;
}
export type ContextPartName = 'thread' | 'root' | 'parent';
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
export interface ThreadContext<Config> {
  messageId(trigger: Trigger): string;
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: Config): Promise<ContextPart>;
}

export interface Tally { skipped: number }
export function validItems<Item>(item: z.ZodType<Item>, list: readonly unknown[], tally?: Tally): Item[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : []; });
  if (tally) tally.skipped += list.length - items.length;
  return items;
}

export interface Commands {
  api<Value>(schema: z.ZodType<Value>, path: string, ...flags: string[]): Promise<Value>;
  api(path: string, ...flags: string[]): Promise<string>;
  pages<Value>(item: z.ZodType<Value>, path: string, tally?: Tally): Promise<Value[]>;
}
