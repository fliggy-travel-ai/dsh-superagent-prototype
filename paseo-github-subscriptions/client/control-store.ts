import type { PluginClientContext } from '@getpaseo/plugin/client';
import { browserSnapshot, browserConfigure, browserBind, browserPairing, browserUsageSnapshot, browserUsageSaveApiKey, browserUsageRemoveApiKey } from '../shared/browser-contracts.ts';
import type { BrowserSnapshot, BrowserSettings, BrowserBindingInput } from '../shared/browser.ts';
import { presenceSnapshot, presenceConfigure, presenceAnswer, presenceRead, type PresenceSnapshot, type PresenceSettings, type QuestionAnswer, type QuestionRead } from '../shared/presence.ts';
import { bluetoothList, bluetoothSelect, type BluetoothTarget } from '../shared/bluetooth.ts';
import { errorMessage, REFRESH_INTERVAL_MS } from './store.ts';
import { stalledSnapshot, type StalledSnapshot } from '../shared/stalled.ts';
import { modulesStatus, type ModulesSnapshot } from '../shared/modules.ts';
import {
  machineSettingsSnapshot,
  machineSettingsToggleModule,
  machineSettingsPauseAll,
  type MachineSettingsSnapshot,
} from '../shared/machine-settings.ts';
import { todoList, todoAct, type TodoMergedSnapshot, type TodoActionInput, type TodoActionOutput } from '../shared/todo.ts';
import {
  providersInstanceStatus,
  cloudSessionStatus,
  type ProvidersInstanceStatus,
  type CloudSessionStatus,
} from '../shared/provider-instance.ts';
import {
  claudeAccountsSnapshot,
  claudeAccountsConfigure,
  type ClaudeAccountsSnapshot,
} from '../shared/claude-accounts.ts';
import {
  providerQuotasSnapshot,
  providerQuotasConfigure,
  type ProviderQuotasConfigureInput,
  type ProviderQuotasSnapshot,
} from '../shared/provider-quotas.ts';
import { syncHideBuiltinUsage } from './paseo-internal.ts';
import {
  escalationSnapshot,
  escalationConfigure,
  escalationTestWebhook,
  escalationWebhookConfigure,
  escalationAcknowledge,
  type EscalationSnapshot,
} from '../shared/escalation.ts';
import { quietSnapshot, quietConfigure, type QuietSnapshot } from '../shared/quiet.ts';

export type EscalationWebhookStatus = EscalationSnapshot['webhook'];
export type EscalationWindow = EscalationSnapshot['immediate'][number];

export type OptionalFeatureStatus = 'loading' | 'ready' | 'disabled' | 'error';

export interface ControlState {
  browser: BrowserSnapshot | null;
  paseoSessions: Array<{ id: string; title: string }>;
  presence: PresenceSnapshot | null;
  stalled: StalledSnapshot | null;
  stalledError: string | null;
  browserError: string | null;
  presenceError: string | null;
  modules: ModulesSnapshot | null;
  machineSettings: MachineSettingsSnapshot | null;
  machineSettingsError?: string | null;
  moduleReloading: boolean;
  moduleReloadingId: string | null;
  moduleReloadUnverified: string | null;
  todo: TodoMergedSnapshot | null;
  todoError: string | null;
  providerInstance: ProvidersInstanceStatus | null;
  providerInstanceError?: string | null;
  cloudSession: CloudSessionStatus | null;
  cloudSessionError?: string | null;
  claudeAccounts: ClaudeAccountsSnapshot | null;
  claudeAccountsStatus: OptionalFeatureStatus;
  claudeAccountsError: string | null;
  providerQuotas: ProviderQuotasSnapshot | null;
  providerQuotasStatus: OptionalFeatureStatus;
  escalation: EscalationSnapshot | null;
  escalationStatus: OptionalFeatureStatus;
  escalationError: string | null;
  quiet: QuietSnapshot | null;
  quietStatus: OptionalFeatureStatus;
  quietError: string | null;
}

export function isRpcDisabledError(error: unknown, moduleId?: string, modules?: ModulesSnapshot | null): boolean {
  if (moduleId && modules) {
    const found = modules.modules.find(item => item.id === moduleId);
    if (!found || found.state === 'off') return true;
  }
  const msg = errorMessage(error);
  return /未知调用|未知接口|unknown|not found|unregistered|no handler|method not found|未注册|未启用|未实现/i.test(msg);
}

/** 待办操作的等待上限：超过就提示失败并恢复按钮；操作后刷新列表最多再等这么久。 */
const ACT_TIMEOUT_MS = 15_000;
const ACT_REFRESH_WAIT_MS = 3_000;

export function createControlStore(client: Pick<PluginClientContext, 'rpc'>, listAgents: PluginClientContext['paseo']['agents']['list'], options: { actTimeoutMs?: number; reloadDelayMs?: number; reloadPollMs?: number } = {}) {
  const actTimeoutMs = options.actTimeoutMs ?? ACT_TIMEOUT_MS;
  let state: ControlState = {
    browser: null,
    paseoSessions: [],
    presence: null,
    stalled: null,
    stalledError: null,
    browserError: null,
    presenceError: null,
    modules: null,
    machineSettings: null,
    machineSettingsError: null,
    moduleReloading: false,
    moduleReloadingId: null,
    moduleReloadUnverified: null,
    todo: null,
    todoError: null,
    providerInstance: null,
    providerInstanceError: null,
    cloudSession: null,
    cloudSessionError: null,
    claudeAccounts: null,
    claudeAccountsStatus: 'loading',
    claudeAccountsError: null,
    providerQuotas: null,
    providerQuotasStatus: 'loading',
    escalation: null,
    escalationStatus: 'loading',
    escalationError: null,
    quiet: null,
    quietStatus: 'loading',
    quietError: null,
  };
  let stalledInflight: Promise<void> | null = null;
  let liveInflight: Promise<void> | null = null;
  let unifyInflight: Promise<void> | null = null;
  let todoInflight: Promise<void> | null = null;
  let hiddenTickCount = 0;
  let liveIds: Set<string> | null = null;
  let liveError: string | null = null;
  let scanError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;
  let mutating = 0;
  const sequence = { browser: 0, presence: 0, machine: 0 };
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<ControlState>) => {
    if (disposed) return;
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of listeners) listener();
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
  const callListAgents: PluginClientContext['paseo']['agents']['list'] =
    typeof listAgents === 'function' ? listAgents : (listAgents as { list: PluginClientContext['paseo']['agents']['list'] }).list;
  const refreshLive = () => {
    liveInflight ??= (async () => {
      let nextSessions = state.paseoSessions;
      try {
        const ids = new Set<string>();
        const sessions: Array<{ id: string; title: string }> = [];
        let cursor: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= 100) throw new Error('会话清单未完整返回');
          const result = await callListAgents({ filter: { includeArchived: false, statuses: ['idle', 'error'] }, page: { limit: 100, cursor }, timeout: 5000 });
          for (const { agent } of result.entries) {
            if (!agent.archivedAt && ['idle', 'error'].includes(agent.status)) ids.add(agent.id);
            if (!agent.archivedAt && agent.status !== 'closed') {
              sessions.push({ id: agent.id, title: (agent as { title?: string | null }).title?.trim() || '未命名 Paseo 会话' });
            }
          }
          if (!result.pageInfo.hasMore) break;
          if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) throw new Error('会话清单未完整返回');
          cursor = result.pageInfo.nextCursor;
        }
        liveIds = ids; liveError = null;
        nextSessions = sessions;
      } catch (error) {
        liveIds = null; liveError = `无法核对会话是否已归档，暂不显示停滞会话：${errorMessage(error)}`;
      }
      emit({ stalled: visibleStalled(state.stalled), stalledError: liveError || scanError, paseoSessions: nextSessions });
    })().finally(() => { liveInflight = null; });
    return liveInflight;
  };
  const refreshTodo = () => {
    if (disposed) return Promise.resolve();
    todoInflight ??= client.rpc(todoList, {}).then(value => {
      emit({ todo: value, todoError: null });
    }).catch(error => {
      if (!isRpcDisabledError(error, 'todo', state.modules)) emit({ todoError: errorMessage(error) });
    }).finally(() => {
      todoInflight = null;
    });
    return todoInflight;
  };
  const fetchMachineSettings = async () => {
    const version = ++sequence.machine;
    try {
      const value = await client.rpc(machineSettingsSnapshot, {});
      if (version === sequence.machine) {
        const tracked = value.modules.find(m => m.id === state.moduleReloadUnverified);
        emit({ machineSettings: value, machineSettingsError: null,
          ...(tracked && tracked.state === (tracked.enabled ? 'running' : 'off') ? { moduleReloadUnverified: null } : {}) });
      }
      return value;
    } catch (error) {
      if (version === sequence.machine) emit({ machineSettingsError: errorMessage(error) });
      throw error;
    }
  };
  const refreshUnify = () => {
    if (disposed) return Promise.resolve();
    const todoTask = refreshTodo();
    unifyInflight ??= (async () => {
      let mods = state.modules;
      await client.rpc(modulesStatus, {}).then(value => { mods = value; emit({ modules: value }); }).catch(() => {});
      await Promise.allSettled([
        fetchMachineSettings(),
        client.rpc(providersInstanceStatus, {}).then(value => emit({ providerInstance: value, providerInstanceError: null })).catch(error => emit({ providerInstanceError: errorMessage(error) })),
        client.rpc(cloudSessionStatus, {}).then(value => emit({ cloudSession: value, cloudSessionError: null })).catch(error => emit({ cloudSessionError: errorMessage(error) })),
        client.rpc(claudeAccountsSnapshot, {}).then(value => {
          emit({ claudeAccounts: value, claudeAccountsStatus: 'ready', claudeAccountsError: null });
        }).catch(error => {
          if (isRpcDisabledError(error, 'usage.claudeAccounts', mods)) {
            emit({ claudeAccountsStatus: 'disabled', claudeAccountsError: null });
          } else {
            emit({ claudeAccountsStatus: 'error', claudeAccountsError: errorMessage(error) });
          }
        }),
        client.rpc(providerQuotasSnapshot, {}).then(value => {
          const { applied } = syncHideBuiltinUsage(value.hideBuiltin);
          emit({ providerQuotas: { ...value, hideBuiltinApplied: applied }, providerQuotasStatus: 'ready' });
        }).catch(error => {
          emit({ providerQuotasStatus: isRpcDisabledError(error, 'usage.providerQuotas', mods) ? 'disabled' : 'error' });
        }),
        client.rpc(escalationSnapshot, {}).then(value => {
          emit({ escalation: value, escalationStatus: 'ready', escalationError: null });
        }).catch(error => {
          if (isRpcDisabledError(error, 'answer.escalation', mods)) {
            emit({ escalationStatus: 'disabled', escalationError: null });
          } else {
            emit({ escalationStatus: 'error', escalationError: errorMessage(error) });
          }
        }),
        client.rpc(quietSnapshot, {}).then(value => {
          emit({ quiet: value, quietStatus: 'ready', quietError: null });
        }).catch(error => {
          if (isRpcDisabledError(error, 'answer.quietChildren', mods)) {
            emit({ quietStatus: 'disabled', quietError: null });
          } else {
            emit({ quietStatus: 'error', quietError: errorMessage(error) });
          }
        }),
      ]);
    })().finally(() => { unifyInflight = null; });
    return Promise.allSettled([todoTask, unifyInflight]).then(() => {});
  };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    const live = refreshLive();
    if (mutating) return live;
    inflight ??= Promise.allSettled([browsing(() => client.rpc(browserSnapshot, {})), asking(() => client.rpc(presenceSnapshot, {}))])
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
    refreshUnify,
    configureBrowser: (settings: BrowserSettings) => write(() => browsing(() => client.rpc(browserConfigure, settings))),
    bind: (input: BrowserBindingInput) => write(() => browsing(() => client.rpc(browserBind, input))),
    pairing: () => client.rpc(browserPairing, {}),
    usageSettings: () => client.rpc(browserUsageSnapshot, {}),
    saveAdsPowerApiKey: (apiKey: string) => write(() => client.rpc(browserUsageSaveApiKey, { apiKey })),
    removeAdsPowerApiKey: () => write(() => client.rpc(browserUsageRemoveApiKey, {})),
    configurePresence: (settings: PresenceSettings) => write(() => asking(() => client.rpc(presenceConfigure, settings))),
    answerQuestion: (answer: QuestionAnswer) => write(() => asking(() => client.rpc(presenceAnswer, answer))),
    markQuestionRead: (question: QuestionRead) => write(() => asking(() => client.rpc(presenceRead, question))),
    bluetoothDevices: (hostId: string | null) => client.rpc(bluetoothList, { hostId }),
    selectBluetooth: (hostId: string | null, target: BluetoothTarget) => write(async () => {
      const result = await client.rpc(bluetoothSelect, { hostId, target });
      await asking(() => client.rpc(presenceSnapshot, {})).catch(() => {});
      return result;
    }),
    actTodo: (input: TodoActionInput): Promise<TodoActionOutput> => write(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<TodoActionOutput>(done => {
        timer = setTimeout(() => done({ ok: false, message: `处理超时（${Math.round(actTimeoutMs / 1000)} 秒没有响应），列表已重新读取；仍在列表中可以再试` }), actTimeoutMs);
      });
      try {
        return await Promise.race([client.rpc(todoAct, input), timeout]);
      } finally {
        clearTimeout(timer);
        // 操作前发出的列表请求可能还带着这条待办：等它结束后重新读取。只短暂等待刷新，不让按钮跟着慢请求卡住。
        const refreshed = Promise.allSettled([
          Promise.resolve(todoInflight).then(() => refreshUnify()),
          asking(() => client.rpc(presenceSnapshot, {})),
        ]);
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([refreshed, new Promise(done => { wait = setTimeout(done, ACT_REFRESH_WAIT_MS); })]);
        clearTimeout(wait);
      }
    }),
    toggleModule: (id: string, enabled: boolean) => write(async () => {
      if (state.moduleReloading) throw new Error('插件正在重新加载，请稍后再试');
      emit({ moduleReloading: true, moduleReloadingId: id, moduleReloadUnverified: null });
      try {
        const result = await client.rpc(machineSettingsToggleModule, { id, enabled });
        emit({ machineSettings: result });
        const checkReload = async () => {
          if (disposed) return;
          reloadTimer = null;
          void refresh();
          let timedOut = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const value = await Promise.race([
            fetchMachineSettings().catch(() => null),
            new Promise<null>(resolve => { timeout = setTimeout(() => { timedOut = true; resolve(null); }, 3000); }),
          ]);
          clearTimeout(timeout);
          if (disposed) return;
          if (value?.reloadInProgress) {
            reloadTimer = setTimeout(() => { void checkReload(); }, options.reloadPollMs ?? 1000);
            return;
          }
          emit({ moduleReloading: false, moduleReloadingId: null, moduleReloadUnverified: timedOut || !value ? id : null });
          void refreshUnify();
        };
        reloadTimer = setTimeout(() => { void checkReload(); }, options.reloadDelayMs ?? 5000);
        return result;
      } catch (error) {
        emit({ moduleReloading: false, moduleReloadingId: null });
        void fetchMachineSettings().catch(() => {});
        throw error;
      }
    }),
    pauseAll: (paused: boolean) => write(async () => {
      const result = await client.rpc(machineSettingsPauseAll, { paused });
      if (state.machineSettings) emit({ machineSettings: { ...state.machineSettings, pausedAll: result.paused } });
      await Promise.allSettled([refresh(), refreshUnify()]);
      return result;
    }),
    configureClaudeAccounts: (input: { autoResumeDefault?: boolean }) => write(async () => {
      const result = await client.rpc(claudeAccountsConfigure, input);
      emit({ claudeAccounts: result, claudeAccountsStatus: 'ready', claudeAccountsError: null });
      return result;
    }),
    configureProviderQuotas: (input: ProviderQuotasConfigureInput) => write(async () => {
      const result = await client.rpc(providerQuotasConfigure, input);
      const { applied } = syncHideBuiltinUsage(result.hideBuiltin);
      emit({ providerQuotas: { ...result, hideBuiltinApplied: applied }, providerQuotasStatus: 'ready' });
      return result;
    }),
    configureEscalation: (input: {
      enabled?: boolean;
      timezone?: string;
      immediate?: EscalationWindow[];
      delayMinutes?: number;
    }) => write(async () => {
      const result = await client.rpc(escalationConfigure, input);
      emit({ escalation: result, escalationStatus: 'ready', escalationError: null });
      return result;
    }),
    testEscalationWebhook: () => write(() => client.rpc(escalationTestWebhook, {})),
    configureEscalationWebhook: (input: { url: string; auth?: string }): Promise<EscalationWebhookStatus> =>
      write(async () => {
        const result = await client.rpc(escalationWebhookConfigure, input);
        if (state.escalation) emit({ escalation: { ...state.escalation, webhook: result } });
        return result;
      }),
    acknowledgeEscalation: (input: { id: string; agentId?: string }) => write(async () => {
      const result = await client.rpc(escalationAcknowledge, input);
      await refreshUnify();
      return result;
    }),
    configureQuiet: (input: { enabled?: boolean; forwardEvents?: boolean }) => write(async () => {
      const result = await client.rpc(quietConfigure, input);
      emit({ quiet: result, quietStatus: 'ready', quietError: null });
      return result;
    }),
    start() {
      if (!disposed && !timer) {
        void refresh();
        void refreshUnify();
        timer = setInterval(() => {
          const isHidden =
            (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden';
          if (isHidden) {
            hiddenTickCount += 1;
            if (hiddenTickCount % 4 !== 0) return;
          } else {
            hiddenTickCount = 0;
          }
          void refresh();
          void refreshUnify();
        }, REFRESH_INTERVAL_MS);
      }
    },
    dispose() { disposed = true; if (reloadTimer) clearTimeout(reloadTimer); if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}

export type ControlStore = ReturnType<typeof createControlStore>;
