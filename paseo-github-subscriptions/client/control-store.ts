import type { PluginClientContext } from '@getpaseo/plugin/client';
import { automationSnapshot, automationPause, automationPolicy, type AutomationSnapshot, type SessionPolicy } from '../shared/automation.ts';
import { browserSnapshot, browserConfigure, browserBind, browserPairing } from '../shared/browser-contracts.ts';
import type { BrowserSnapshot, BrowserSettings, BrowserBindingInput } from '../shared/browser.ts';
import { presenceSnapshot, presenceConfigure, presenceAnswer, presenceRead, type PresenceSnapshot, type PresenceSettings, type QuestionAnswer, type QuestionRead } from '../shared/presence.ts';
import { bluetoothList, bluetoothSelect, type BluetoothTarget } from '../shared/bluetooth.ts';
import { errorMessage, REFRESH_INTERVAL_MS } from './store.ts';
import { stalledSnapshot, type StalledSnapshot } from '../shared/stalled.ts';

export interface ControlState {
  automation: AutomationSnapshot | null;
  browser: BrowserSnapshot | null;
  presence: PresenceSnapshot | null;
  stalled: StalledSnapshot | null;
  stalledError: string | null;
  automationError: string | null;
  browserError: string | null;
  presenceError: string | null;
}

export function createControlStore(client: Pick<PluginClientContext, 'rpc'>) {
  let state: ControlState = { automation: null, browser: null, presence: null, stalled: null, stalledError: null, automationError: null, browserError: null, presenceError: null };
  let stalledInflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;
  let mutating = 0;
  const sequence = { automation: 0, browser: 0, presence: 0 };
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<ControlState>) => {
    if (disposed) return;
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const native = async (operation: () => Promise<AutomationSnapshot>) => {
    const version = ++sequence.automation;
    try { const value = await operation(); if (version === sequence.automation) emit({ automation: value, automationError: null }); }
    catch (error) { if (version === sequence.automation) emit({ automationError: errorMessage(error) }); throw error; }
  };
  const browsing = async (operation: () => Promise<BrowserSnapshot>) => {
    const version = ++sequence.browser;
    try { const value = await operation(); if (version === sequence.browser) emit({ browser: value, browserError: null }); }
    catch (error) { if (version === sequence.browser) emit({ browserError: errorMessage(error) }); throw error; }
  };
  const asking = async (operation: () => Promise<PresenceSnapshot>) => {
    const version = ++sequence.presence;
    try { const value = await operation(); if (version === sequence.presence) emit({ presence: value, presenceError: null }); }
    catch (error) { if (version === sequence.presence) emit({ presenceError: errorMessage(error) }); throw error; }
  };
  const refresh = () => {
    if (disposed || mutating) return Promise.resolve();
    inflight ??= Promise.allSettled([native(() => client.rpc(automationSnapshot, {})), browsing(() => client.rpc(browserSnapshot, {})), asking(() => client.rpc(presenceSnapshot, {}))])
      .then(() => {}).finally(() => { inflight = null; });
    stalledInflight ??= client.rpc(stalledSnapshot, {}).then(value => { emit({ stalled: value, stalledError: null }); })
      .catch(error => { emit({ stalledError: errorMessage(error) }); }).finally(() => { stalledInflight = null; });
    return Promise.allSettled([inflight, stalledInflight]).then(() => {});
  };
  const write = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    mutating += 1;
    try { return await operation(); } finally { mutating -= 1; }
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    pause: (paused: boolean) => write(() => native(() => client.rpc(automationPause, { paused }))),
    policy: (policy: SessionPolicy) => write(() => native(() => client.rpc(automationPolicy, policy))),
    configureBrowser: (settings: BrowserSettings) => write(() => browsing(() => client.rpc(browserConfigure, settings))),
    bind: (input: BrowserBindingInput) => write(() => browsing(() => client.rpc(browserBind, input))),
    pairing: () => client.rpc(browserPairing, {}),
    configurePresence: (settings: PresenceSettings) => write(() => asking(() => client.rpc(presenceConfigure, settings))),
    answerQuestion: (answer: QuestionAnswer) => write(() => asking(() => client.rpc(presenceAnswer, answer))),
    markQuestionRead: (question: QuestionRead) => write(() => asking(() => client.rpc(presenceRead, question))),
    bluetoothDevices: (hostId: string | null) => client.rpc(bluetoothList, { hostId }),
    selectBluetooth: (hostId: string | null, target: BluetoothTarget) => write(async () => {
      const result = await client.rpc(bluetoothSelect, { hostId, target });
      await asking(() => client.rpc(presenceSnapshot, {})).catch(() => {});
      return result;
    }),
    start() { if (!disposed && !timer) { void refresh(); timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS); } },
    dispose() { disposed = true; if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}

export type ControlStore = ReturnType<typeof createControlStore>;
