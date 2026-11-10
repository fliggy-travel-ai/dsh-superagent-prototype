import { join } from 'node:path';
import type { LoadedMachineConfig } from '../../core/machine-config.ts';
import type { EscalationSection } from '../answer-escalation/config.ts';
import { prefilter } from '../answer-escalation/prefilter.ts';
import { postNotice, webhookCredentials, webhookPayload } from '../answer-escalation/webhook.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { Engine } from '../../notify/engine.ts';
import { loadState, saveState } from '../../notify/store.ts';
import type { EventName } from '../../notify/protocol.ts';

export function pruneAutomationSeen(seen: Record<string, number>, now: number) {
  let changed = false;
  for (const [key, at] of Object.entries(seen)) {
    if ((key.startsWith('capacity:') || key.startsWith('lb_exception:') || key.startsWith('main_migrated:') || key.startsWith('main_migration_planned:')) && now - at >= 24 * 3600_000) { delete seen[key]; changed = true; }
  }
  return changed;
}

/** 独立持久队列，沿用升级通知的 webhook 和预筛配置。 */
export async function createNotifier(machine: LoadedMachineConfig, directory: string) {
  const section = machine.section<EscalationSection>('escalation');
  if (!section.ok) throw Error(section.error);
  const path = join(directory, 'notification-state.json');
  const writeAudit = createAuditWriter(join(directory, 'notification-events.jsonl'));
  const audit = (entry: Record<string, unknown>) => writeAudit({ phase: entry.phase, event: (entry.notice as { event?: string } | undefined)?.event });
  const state = await loadState(path);
  const abort = new AbortController();
  const engine = new Engine({ hostId: machine.machine ?? 'local', machine: machine.machine ?? 'local', delivery: 'live', mains: [], children: {}, coalesceWindowSeconds: 0 }, state, s => saveState(path, s), async notice => {
    if (await prefilter(section.value.prefilter, webhookPayload(notice))) return;
    await postNotice(notice, await webhookCredentials(section.value.webhook), abort.signal);
  }, async () => false, audit);
  const sweep = async () => { if (pruneAutomationSeen(engine.state.seen, Date.now())) await saveState(path, engine.state); };
  const tick = () => engine.serial(async () => { await sweep(); await engine.tick(); await sweep(); });
  const timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
  timer.unref?.();
  return {
    send: (event: EventName, data: unknown, key: string) => engine.serial(async () => { await sweep(); await engine.enqueue(event, '', data, key); const job = engine.state.outbox.find(item => item.notice.key === key); if (job) { job.notice.id = key; await saveState(path, engine.state); } await engine.tick(); await sweep(); }),
    stop: () => { clearInterval(timer); abort.abort(); },
  };
}
