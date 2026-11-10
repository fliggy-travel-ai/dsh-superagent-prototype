import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { dispatchFinalize } from '../../../shared/dispatch.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { isMainInstance, type Module } from '../types.ts';
import { finalize, issueOf, type FinalizePort } from './finalize.ts';
import { capacityChanged } from '../capacity/changes.ts';
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
    const baselinePath = join(directory, 'baseline.json');
    const pinsPath = join(directory, 'pins.json');
    const createdDuringStartup = new Set<string>();
    let initializing = true;
    const audit = createAuditWriter(join(directory, 'events.jsonl'));
    const abort = new AbortController();
    const running = new Map<string, Promise<{ ok: boolean; reason: string | null }>>();
    let queue: Promise<unknown> = Promise.resolve();
    const retries = new Map<string, { attempts: number; next: number }>();
    let notifier: Awaited<ReturnType<typeof createNotifier>> | null = null;
    let done: Record<string, boolean> = {};
    let pins: Record<string, boolean> = {};
    let baseline: Record<string, boolean> = {};
    let baselineWrite: Promise<void> = Promise.resolve();
    let subscription: { release(): Promise<unknown> } | null = null;
    const start = (async () => {
      try { done = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try { pins = JSON.parse(await readFile(pinsPath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      let needsBaseline = false;
      try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; needsBaseline = true; }
      notifier = await createNotifier(context.machine, directory);
      if (abort.signal.aborted) throw Error('模块已停止');
      const { client, paseo } = await context.services.daemon.ready();
      if (abort.signal.aborted) throw Error('模块已停止');
      const port = finalizePort(client);
      const saveBaseline = () => { baselineWrite = baselineWrite.then(async () => { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(`${baselinePath}.tmp`, JSON.stringify(baseline), { mode: 0o600 }); await rename(`${baselinePath}.tmp`, baselinePath); }); return baselineWrite; };
      const run = (id: string, manual = false, created = false) => {
        const existing = running.get(id); if (existing) return existing;
        const promise = queue.then(async () => {
          if (abort.signal.aborted) return { ok: false, reason: '模块已停止' };
          const agent = await port.agent(id); const issue = agent && issueOf(agent);
          if (!agent || !issue || agent.labels?.role !== 'main') return { ok: false, reason: '会话不符合收尾条件' };
          const key = JSON.stringify([id, issue]);
          if (created && baseline[id]) { delete baseline[id]; await saveBaseline(); }
          if (baseline[id] && !manual) return { ok: true, reason: null };
          if (done[key] && !manual) return { ok: true, reason: null };
          const retry = retries.get(id);
          if (!manual && retry && (retry.attempts >= 4 || Date.now() < retry.next)) return { ok: false, reason: '等待重试' };
          if (manual) retries.delete(id);
          const result = await finalize(port, id, { pinHandled: !!pins[key], onPinHandled: async () => {
            const next = { ...pins, [key]: true };
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(`${pinsPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
            await rename(`${pinsPath}.tmp`, pinsPath); pins = next;
          } });
          await audit({ agentId: id, ...result });
          if (result.ok) {
            const next = { ...done, [key]: true };
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
            await rename(`${path}.tmp`, path);
            done = next;
            retries.delete(id);
            capacityChanged();
          }
          else {
            const attempts = (retries.get(id)?.attempts ?? 0) + 1;
            const delay = [30_000, 120_000, 600_000][attempts - 1];
            retries.set(id, { attempts, next: Date.now() + (delay ?? 0) });
            if (delay) { const timer = setTimeout(() => { if (!abort.signal.aborted) void run(id).catch(() => {}); }, delay); timer.unref?.(); abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true }); }
          }
          await notifier?.send('main_finalized', { agentId: id, ...result }, `finalize:${id}:${issue}:${result.ok ? 'ok' : randomUUID()}`);
          return { ok: result.ok, reason: result.reason };
        }).finally(() => running.delete(id));
        queue = promise.catch(() => {});
        running.set(id, promise); return promise;
      };
      const schedule = (id: string) => { void run(id).catch(() => {}); };
      const observe = (agent: { id: string; labels?: Record<string, string> }) => {
        if (baseline[agent.id] && agent.labels?.role !== 'main') { delete baseline[agent.id]; void saveBaseline().catch(error => context.fail(error)); }
        if (!baseline[agent.id] && agent.labels?.role === 'main' && issueOf(agent)) schedule(agent.id);
      };
      const scan = async () => {
        let cursor: string | undefined;
        do {
          const page = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
          for (const { agent } of page.entries) {
            if (needsBaseline) { if (agent.labels?.role === 'main' && !createdDuringStartup.has(agent.id)) baseline[agent.id] = true; }
            else observe(agent);
          }
          if (!page.pageInfo.hasMore) break;
          if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('会话列表不完整');
          cursor = page.pageInfo.nextCursor;
        } while (true);
      };
      if (needsBaseline) { await scan(); for (const id of createdDuringStartup) delete baseline[id]; await saveBaseline(); needsBaseline = false; }
      const list = await paseo.agents.list({ subscribe: {}, signal: abort.signal });
      subscription = list.subscription;
      if (abort.signal.aborted) throw Error('模块已停止');
      list.subscription.subscribe({ snapshot: ({ entries }) => { for (const { agent } of entries) observe(agent); }, update: message => { if (message.type === 'agent_update' && message.payload.kind === 'upsert') observe(message.payload.agent); } });
      await scan();
      if (abort.signal.aborted) throw Error('模块已停止');
      const timer = setInterval(() => { void scan().catch(() => {}); }, 300_000); timer.unref?.();
      abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
      initializing = false; createdDuringStartup.clear();
      return run;
    })();
    context.server.handle(dispatchFinalize, async ({ agentId }) => (await start)(agentId, true));
    const removeHook = context.server.addHook('agent.create.after', async e => { if (initializing) createdDuringStartup.add(e.agent.id); void start.then(run => run(e.agent.id, false, true)).catch(() => {}); });
    void start.catch(error => context.fail(error));
    return async () => { removeHook(); abort.abort(); await start.catch(() => null); await subscription?.release(); await Promise.allSettled(running.values()); await baselineWrite; notifier?.stop(); };
  },
};
