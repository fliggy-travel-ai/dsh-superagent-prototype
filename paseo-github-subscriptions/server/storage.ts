import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DeliverySchema, GithubEventSchema, PreferencesSchema, SubscriptionSchema } from '../shared/model.ts';

const PendingSchema = DeliverySchema.extend({ text: z.string(), events: z.array(GithubEventSchema), attempts: z.number(), retryAt: z.number() });
export type PendingDelivery = z.infer<typeof PendingSchema>;
const StateSchema = z.object({
  version: z.literal(1), preferences: PreferencesSchema,
  subscriptions: z.array(SubscriptionSchema), events: z.array(GithubEventSchema),
  deliveries: z.array(PendingSchema), seen: z.record(z.string(), z.string()),
  ownComments: z.record(z.string(), z.object({ agentId: z.string(), at: z.string() })),
  commentRequests: z.record(z.string(), z.object({ status: z.enum(['pending', 'done', 'unknown']), url: z.string().nullable(), at: z.string() })),
  source: z.unknown().optional(),
});
export type State = z.infer<typeof StateSchema>;

export async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export class Storage {
  state: State = StateSchema.parse({ version: 1, preferences: {}, subscriptions: [], events: [], deliveries: [], seen: {}, ownComments: {}, commentRequests: {} });
  private tail: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.state = StateSchema.parse(JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('状态文件无法读取或格式无效，请保留状态文件后检查');
    }
  }

  mutate<Result>(change: (state: State) => Result): Promise<Result> {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      await atomicWrite(join(this.directory, 'state.json'), JSON.stringify(next));
      this.state = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async prune(now = Date.now()) {
    await this.mutate(state => {
      const horizon = now - 14 * 86400_000;
      state.events = state.events.filter(event => Date.parse(event.at) >= now - 7 * 86400_000).slice(-500);
      const pending = state.deliveries.filter(delivery => delivery.status === 'pending');
      const completed = state.deliveries.filter(delivery => delivery.status !== 'pending' && Date.parse(delivery.at) >= horizon).slice(-5000);
      state.deliveries = [...completed, ...pending];
      state.seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => Date.parse(at) >= horizon));
      state.ownComments = Object.fromEntries(Object.entries(state.ownComments).filter(([, value]) => Date.parse(value.at) >= horizon));
      state.commentRequests = Object.fromEntries(Object.entries(state.commentRequests).filter(([, value]) => Date.parse(value.at) >= horizon));
      state.subscriptions = state.subscriptions.filter(subscription =>
        (!subscription.expiresAt || Date.parse(subscription.expiresAt) > now) &&
        Date.parse(subscription.lastEventAt ?? subscription.createdAt) >= horizon);
    });
  }
}
