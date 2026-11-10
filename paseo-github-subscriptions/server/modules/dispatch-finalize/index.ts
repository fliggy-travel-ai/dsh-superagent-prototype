import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { dispatchFinalize } from '../../../shared/dispatch.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { isMainInstance, type Module } from '../types.ts';
import { finalize, issueOf, type FinalizePort } from './finalize.ts';
import { createNotifier } from './notifier.ts';

export async function workspaceById(client: DaemonClient, id: string) {
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ includeBackground: true, page: { limit: 100, cursor } });
    const found = page.entries.find(w => w.id === id);
    if (found) return found;
    if (!page.pageInfo.hasMore) return null;
    if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('工作区列表不完整');
    cursor = page.pageInfo.nextCursor;
  } while (true);
}
export function finalizePort(client: DaemonClient): FinalizePort {
  return {
    agent: async id => (await client.fetchAgent(id))?.agent ?? null,
    workspace: id => workspaceById(client, id),
    detach: id => client.detachAgent(id),
    pin: async id => { await client.setWorkspacePinned(id, true); },
    label: async id => { await client.setWorkspaceLabel({ workspaceId: id, label: { name: '主会话', color: 'emerald' }, assigned: true }); },
  };
}
export const dispatchFinalizeModule: Module = {
  id: 'dispatch.finalize', label: '主会话收尾', defaultEnabled: false, appliesTo: isMainInstance,
  register(context) {
    const directory = join(context.stateDirectory, 'finalize');
    const path = join(directory, 'state.json');
    const audit = createAuditWriter(join(directory, 'events.jsonl'));
    const abort = new AbortController();
    const running = new Map<string, Promise<{ ok: boolean; reason: string | null }>>();
    let saveChain = Promise.resolve();
    const retries = new Map<string, { attempts: number; next: number }>();
    let notifier: Awaited<ReturnType<typeof createNotifier>> | null = null;
    let done: Record<string, boolean> = {};
    let subscription: { release(): Promise<unknown> } | null = null;
    const start = (async () => {
      try { done = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      notifier = await createNotifier(context.machine, directory);
      const { client, paseo } = await context.services.daemon.ready();
      const port = finalizePort(client);
      const run = (id: string, manual = false) => {
        const existing = running.get(id); if (existing) return existing;
        const promise = (async () => {
          const agent = await port.agent(id); const issue = agent && issueOf(agent);
          if (!agent || !issue || agent.labels?.role !== 'main') return { ok: false, reason: '会话不符合收尾条件' };
          const key = JSON.stringify([id, issue]);
          if (done[key] && !manual) return { ok: true, reason: null };
          const retry = retries.get(id);
          if (!manual && retry && (retry.attempts >= 4 || Date.now() < retry.next)) return { ok: false, reason: '等待重试' };
          if (manual) retries.delete(id);
          const result = await finalize(port, id);
          await audit({ agentId: id, ...result });
          if (result.ok) {
            saveChain = saveChain.then(async () => {
              done[key] = true;
              await mkdir(directory, { recursive: true, mode: 0o700 });
              await writeFile(`${path}.tmp`, JSON.stringify(done), { mode: 0o600 });
              await rename(`${path}.tmp`, path);
            });
            await saveChain;
            retries.delete(id);
          }
          else {
            const attempts = (retries.get(id)?.attempts ?? 0) + 1;
            const delay = [30_000, 120_000, 600_000][attempts - 1];
            retries.set(id, { attempts, next: Date.now() + (delay ?? 0) });
            if (delay) { const timer = setTimeout(() => { if (!abort.signal.aborted) void run(id).catch(() => {}); }, delay); timer.unref?.(); abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true }); }
          }
          await notifier?.send('main_finalized', { agentId: id, ...result }, `finalize:${id}:${issue}:${result.ok ? 'ok' : randomUUID()}`);
          return { ok: result.ok, reason: result.reason };
        })().finally(() => running.delete(id));
        running.set(id, promise); return promise;
      };
      const schedule = (id: string) => { void run(id).catch(() => {}); };
      const scan = async () => {
        let cursor: string | undefined;
        do {
          const page = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
          for (const { agent } of page.entries) if (agent.labels?.role === 'main' && issueOf(agent)) schedule(agent.id);
          if (!page.pageInfo.hasMore) break;
          if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('会话列表不完整');
          cursor = page.pageInfo.nextCursor;
        } while (true);
      };
      const list = await paseo.agents.list({ subscribe: {}, signal: abort.signal });
      subscription = list.subscription;
      list.subscription.subscribe({ snapshot: ({ entries }) => { for (const { agent } of entries) if (agent.labels?.role === 'main' && issueOf(agent)) schedule(agent.id); }, update: message => { if (message.type === 'agent_update' && message.payload.kind === 'upsert') { const a = message.payload.agent; if (a.labels?.role === 'main' && issueOf(a)) schedule(a.id); } } });
      await scan();
      const timer = setInterval(() => { void scan().catch(() => {}); }, 300_000); timer.unref?.();
      abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
      return run;
    })();
    context.server.handle(dispatchFinalize, async ({ agentId }) => (await start)(agentId, true));
    const removeHook = context.server.addHook('agent.create.after', async e => { void start.then(run => run(e.agent.id)).catch(() => {}); });
    void start.catch(error => context.fail(error));
    return async () => { removeHook(); abort.abort(); await subscription?.release(); notifier?.stop(); };
  },
};
