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

export function createControlStore(client: Pick<PluginClientContext, 'rpc'>, listAgents: PluginClientContext['paseo']['agents']['list']) {
  let state: ControlState = { automation: null, browser: null, presence: null, stalled: null, stalledError: null, automationError: null, browserError: null, presenceError: null };
  let stalledInflight: Promise<void> | null = null;
  let liveInflight: Promise<void> | null = null;
  let liveIds: Set<string> | null = null;
  let liveError: string | null = null;
  let scanError: string | null = null;
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
  const visibleStalled = (value: StalledSnapshot | null) => {
    if (!value) return null;
    const sessions = value.sessions.filter(session => liveIds?.has(session.agentId));
    return sessions.length === value.sessions.length ? value : { ...value, sessions };
  };
  const refreshLive = () => {
    liveInflight ??= (async () => {
      try {
        const ids = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= 100) throw new Error('会话清单未完整返回');
          const result = await listAgents({ filter: { includeArchived: false, statuses: ['idle', 'error'] }, page: { limit: 100, cursor }, timeout: 5000 });
          for (const { agent } of result.entries) if (!agent.archivedAt && ['idle', 'error'].includes(agent.status)) ids.add(agent.id);
          if (!result.pageInfo.hasMore) break;
          if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) throw new Error('会话清单未完整返回');
          cursor = result.pageInfo.nextCursor;
        }
        liveIds = ids; liveError = null;
      } catch (error) {
        liveIds = null; liveError = `无法核对会话是否已归档，暂不显示停滞会话：${errorMessage(error)}`;
      }
      emit({ stalled: visibleStalled(state.stalled), stalledError: liveError || scanError });
    })().finally(() => { liveInflight = null; });
    return liveInflight;
  };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    const live = refreshLive();
    if (mutating) return live;
    inflight ??= Promise.allSettled([native(() => client.rpc(automationSnapshot, {})), browsing(() => client.rpc(browserSnapshot, {})), asking(() => client.rpc(presenceSnapshot, {}))])
      .then(() => {}).finally(() => { inflight = null; });
    stalledInflight ??= client.rpc(stalledSnapshot, {}).then(async value => {
      if (disposed) return;
      await refreshLive(); scanError = null;
      emit({ stalled: visibleStalled(value), stalledError: liveError });
    }).catch(error => { scanError = errorMessage(error); emit({ stalledError: liveError || scanError }); }).finally(() => { stalledInflight = null; });
    return Promise.allSettled([inflight, stalledInflight, live]).then(() => {});
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
