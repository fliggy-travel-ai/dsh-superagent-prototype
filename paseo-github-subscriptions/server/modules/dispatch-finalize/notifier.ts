import { join } from 'node:path';
import type { LoadedMachineConfig } from '../../core/machine-config.ts';
import type { EscalationSection } from '../answer-escalation/config.ts';
import { prefilter } from '../answer-escalation/prefilter.ts';
import { postNotice, webhookCredentials, webhookPayload } from '../answer-escalation/webhook.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { Engine } from '../../notify/engine.ts';
import { loadState, saveState } from '../../notify/store.ts';
import type { EventName } from '../../notify/protocol.ts';

/** 独立持久队列，沿用升级通知的 webhook 和预筛配置。 */
export async function createNotifier(machine: LoadedMachineConfig, directory: string) {
  const section = machine.section<EscalationSection>('escalation');
  if (!section.ok) throw Error(section.error);
  const path = join(directory, 'notification-state.json');
  const audit = createAuditWriter(join(directory, 'notification-events.jsonl'));
  const state = await loadState(path);
  const abort = new AbortController();
  const engine = new Engine({ hostId: machine.machine ?? 'local', machine: machine.machine ?? 'local', delivery: 'live', mains: [], children: {}, coalesceWindowSeconds: 0 }, state, s => saveState(path, s), async notice => {
    if (await prefilter(section.value.prefilter, webhookPayload(notice))) return;
    await postNotice(notice, await webhookCredentials(section.value.webhook), abort.signal);
  }, async () => false, audit);
  const tick = () => engine.serial(() => engine.tick());
  const timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
  timer.unref?.();
  return {
    send: (event: EventName, data: unknown, key: string) => engine.serial(async () => { await engine.enqueue(event, '', data, key); await engine.tick(); }),
    stop: () => { clearInterval(timer); abort.abort(); },
  };
}
