import type { PluginClientContext } from '@getpaseo/plugin/client';
import { automationSnapshot, automationPause, automationPolicy, type AutomationSnapshot, type SessionPolicy } from '../shared/automation.ts';
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
  machineSettingsExportBackup,
  type MachineSettingsSnapshot,
} from '../shared/machine-settings.ts';
import { todoList, todoAct, type TodoMergedSnapshot, type TodoActionInput, type TodoActionOutput } from '../shared/todo.ts';
import { defaultsSnapshot, defaultsSave, type DefaultsSnapshot, type AgentDefaultRule } from '../shared/defaults.ts';
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
  antigravitySnapshot,
  antigravityAccountToggle,
  antigravityAccountAdd,
  type AntigravitySnapshot,
} from '../shared/antigravity.ts';
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
  automation: AutomationSnapshot | null;
  browser: BrowserSnapshot | null;
  presence: PresenceSnapshot | null;
  stalled: StalledSnapshot | null;
  stalledError: string | null;
  automationError: string | null;
  browserError: string | null;
  presenceError: string | null;
  modules: ModulesSnapshot | null;
  machineSettings: MachineSettingsSnapshot | null;
  machineSettingsError?: string | null;
  todo: TodoMergedSnapshot | null;
  todoError: string | null;
  defaults: DefaultsSnapshot | null;
  defaultsError?: string | null;
  providerInstance: ProvidersInstanceStatus | null;
  providerInstanceError?: string | null;
  cloudSession: CloudSessionStatus | null;
  cloudSessionError?: string | null;
  claudeAccounts: ClaudeAccountsSnapshot | null;
  claudeAccountsStatus: OptionalFeatureStatus;
  claudeAccountsError: string | null;
  antigravity: AntigravitySnapshot | null;
  antigravityStatus: OptionalFeatureStatus;
  antigravityError: string | null;
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

export function createControlStore(client: Pick<PluginClientContext, 'rpc'>, listAgents: PluginClientContext['paseo']['agents']['list']) {
  let state: ControlState = {
    automation: null,
    browser: null,
    presence: null,
    stalled: null,
    stalledError: null,
    automationError: null,
    browserError: null,
    presenceError: null,
    modules: null,
    machineSettings: null,
    machineSettingsError: null,
    todo: null,
    todoError: null,
    defaults: null,
    defaultsError: null,
    providerInstance: null,
    providerInstanceError: null,
    cloudSession: null,
    cloudSessionError: null,
    claudeAccounts: null,
    claudeAccountsStatus: 'loading',
    claudeAccountsError: null,
    antigravity: null,
    antigravityStatus: 'loading',
    antigravityError: null,
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
  const refreshUnify = () => {
    if (disposed) return Promise.resolve();
    const todoTask = refreshTodo();
    unifyInflight ??= (async () => {
      let mods = state.modules;
      await client.rpc(modulesStatus, {}).then(value => { mods = value; emit({ modules: value }); }).catch(() => {});
      await Promise.allSettled([
        client.rpc(machineSettingsSnapshot, {}).then(value => emit({ machineSettings: value, machineSettingsError: null })).catch(error => emit({ machineSettingsError: errorMessage(error) })),
        client.rpc(defaultsSnapshot, {}).then(value => emit({ defaults: value, defaultsError: null })).catch(error => emit({ defaultsError: errorMessage(error) })),
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
        client.rpc(antigravitySnapshot, {}).then(value => {
          emit({ antigravity: value, antigravityStatus: 'ready', antigravityError: null });
        }).catch(error => {
          if (isRpcDisabledError(error, 'providers.antigravity', mods)) {
            emit({ antigravityStatus: 'disabled', antigravityError: null });
          } else {
            emit({ antigravityStatus: 'error', antigravityError: errorMessage(error) });
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
    refreshUnify,
    pause: (paused: boolean) => write(() => native(() => client.rpc(automationPause, { paused }))),
    policy: (policy: SessionPolicy) => write(() => native(() => client.rpc(automationPolicy, policy))),
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
      const result = await client.rpc(todoAct, input);
      await Promise.allSettled([refreshUnify(), asking(() => client.rpc(presenceSnapshot, {}))]);
      return result;
    }),
    saveDefaults: (input: { enabled?: boolean; rules?: AgentDefaultRule[] }) => write(async () => {
      const result = await client.rpc(defaultsSave, input);
      emit({ defaults: result });
      return result;
    }),
    toggleModule: (id: string, enabled: boolean) => write(async () => {
      const result = await client.rpc(machineSettingsToggleModule, { id, enabled });
      emit({ machineSettings: result });
      return result;
    }),
    pauseAll: (paused: boolean) => write(async () => {
      const result = await client.rpc(machineSettingsPauseAll, { paused });
      if (state.machineSettings) emit({ machineSettings: { ...state.machineSettings, pausedAll: result.paused } });
      await Promise.allSettled([refresh(), refreshUnify()]);
      return result;
    }),
    exportBackup: () => write(() => client.rpc(machineSettingsExportBackup, {})),
    configureClaudeAccounts: (input: { autoResumeDefault?: boolean }) => write(async () => {
      const result = await client.rpc(claudeAccountsConfigure, input);
      emit({ claudeAccounts: result, claudeAccountsStatus: 'ready', claudeAccountsError: null });
      return result;
    }),
    toggleAntigravityAccount: (input: { providerId: string; enabled: boolean }) => write(async () => {
      const result = await client.rpc(antigravityAccountToggle, input);
      emit({ antigravity: result, antigravityStatus: 'ready', antigravityError: null });
      return result;
    }),
    addAntigravityAccount: (input: { providerId: string; label: string; homeDir?: string; proxy?: string }) => write(async () => {
      const result = await client.rpc(antigravityAccountAdd, input);
      emit({ antigravity: result, antigravityStatus: 'ready', antigravityError: null });
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
      delivery?: 'shadow' | 'live';
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
    dispose() { disposed = true; if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}

export type ControlStore = ReturnType<typeof createControlStore>;
