import type { PluginRpcContract } from '@getpaseo/plugin';
import { pollNow, removeToken, saveToken, savePreferences, snapshot, unsubscribe } from '../../shared/contracts.ts';
import type { Snapshot } from '../../shared/model.ts';
import { makeSnapshot, type Scene } from './fixtures.ts';
import { makeBrowser, makePresence } from './control-fixtures.ts';
import type { BrowserBindingInput, BrowserSettings } from '../../shared/browser.ts';
import type { PresenceSettings } from '../../shared/presence.ts';
import type { AgentDefaultRule, DefaultsSnapshot } from '../../shared/defaults.ts';
import type { ClaudeAccountsSnapshot } from '../../shared/claude-accounts.ts';
import type { EscalationSnapshot } from '../../shared/escalation.ts';
import type { EscalationWindow } from '../../client/control-store.ts';
import type { QuietSnapshot } from '../../shared/quiet.ts';
import type { TodoMergedSnapshot } from '../../shared/todo.ts';
import type { MachineSettingsSnapshot } from '../../shared/machine-settings.ts';

export interface RpcLogEntry {
  name: string;
  at: number;
  /** 令牌只记录长度，不记录内容。 */
  summary: string;
}

/** 内存里的假守护进程：用真实合约的 Zod 校验输入和输出。 */
export class FakeDaemon {
  browser = {
    ...makeBrowser(),
    settings: { enabled: true, port: 17373 },
    connected: true,
    extensionPath: '/Users/demo/.paseo/local-plugins/github-subscriptions/browser-extension',
    instances: [
      { instanceId: 'env-27', instanceName: '环境 27（主力）', connected: true, lastSeenAt: new Date().toISOString() },
      { instanceId: 'env-29', instanceName: '环境 29（备用）', connected: true, lastSeenAt: new Date().toISOString() },
    ],
  };
  paseoSessions = [
    { id: 'agent-refund', title: '【订单退款】联调' },
    { id: 'agent-search', title: '【搜索排序】实验' },
  ];
  presence = makePresence();
  adspowerApiKeyConfigured = false;
  state: Snapshot;
  defaults: DefaultsSnapshot = {
    enabled: false,
    error: null,
    rules: [
      { provider: 'claude*', apply: 'missing', modeId: 'bypassPermissions', features: { effort: 'xhigh' }, enabled: true },
      { provider: 'codex', apply: 'always', modeId: 'auto', features: { serviceTier: 'fast' }, enabled: true },
      { provider: 'opencode', apply: 'missing', features: { autoApprove: true }, enabled: true },
      { provider: 'glm', apply: 'missing', features: { autoApprove: true }, enabled: true },
      { provider: 'qoder', apply: 'missing', modeId: 'yolo', features: { autoApprove: true }, enabled: true },
    ],
  };
  claudeAccounts: ClaudeAccountsSnapshot = {
    enabled: true,
    accounts: [
      {
        providerId: 'claude-1',
        label: 'Claude 1',
        email: 'lin@example.com',
        appleLogin: false,
        configDir: '~/.claude-1',
        needsRelogin: false,
        remainingPct: 64,
      },
      {
        providerId: 'claude-2',
        label: 'Claude 2',
        email: 'work@example.com',
        appleLogin: false,
        configDir: '~/.claude-2',
        needsRelogin: true,
        remainingPct: null,
      },
      {
        providerId: 'claude-3',
        label: 'Claude 3',
        email: 'team@example.com',
        appleLogin: false,
        configDir: '~/.claude-3',
        needsRelogin: false,
        remainingPct: 48,
      },
    ],
    quotaName: {
      enabled: true,
      lowestRemainingPct: 48,
      autoResumeDefault: true,
      hiddenBuiltinSources: ['claude'],
    },
    error: null,
  };
  bluetoothTarget: { name: string; address: string | null; revision: string } = { name: '随身手机', address: 'AA:BB:CC:DD:EE:01', revision: 'rev-1' };
  escalation: EscalationSnapshot = {
    enabled: false,
    status: 'stopped',
    error: null,
    blockedReason: null,
    timezone: 'Asia/Singapore',
    immediate: [
      { days: 'daily', from: '01:00', to: '09:30' },
      { days: 'weekdays', from: '12:00', to: '14:00' },
    ],
    delayMinutes: 0,
    webhook: {
      configured: true,
      hostname: 'hooks.example.net',
      fingerprint: 'a3f19c07',
    },
    pendingEvents: [
      {
        id: 'esc-1',
        agentId: 'agent-main',
        sessionTitle: '插件整合主会话',
        workspaceId: 'ws-main',
        questionText: '是否删除旧的 usage-monitor 插件目录？',
        notifiedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
        delivery: 'live',
      },
    ],
    recentDeliveries: [
      {
        id: 'del-1',
        agentId: 'agent-main',
        sessionTitle: '插件整合主会话',
        summary: '必须本人确认 → 已发送 Webhook',
        at: new Date(Date.now() - 480_000).toISOString(),
        delivery: 'live',
        status: 'delivered',
      },
    ],
  };
  quiet: QuietSnapshot = {
    enabled: false,
    forwardEvents: true,
    pinnedWorkspaceCount: 3,
    pinnedWorkspaces: [
      { id: 'ws-1', title: 'dsh-superagent-prototype' },
      { id: 'ws-2', title: 'deepseek-harness' },
      { id: 'ws-3', title: 'paseo-core' },
    ],
    recentHandled: [
      {
        id: 'qh-1',
        agentId: 'agent-child',
        sessionTitle: 'p2p: #1737 子任务',
        eventKind: 'failed',
        clearedAttention: true,
        forwardedTo: 'agent-main',
        forwardStatus: 'forwarded',
        at: new Date(Date.now() - 1800_000).toISOString(),
      },
    ],
    error: null,
  };
  machineSettings: MachineSettingsSnapshot = {
    configPath: '~/.paseo/github-subscriptions/machine.json',
    source: 'file',
    machine: 'macbook',
    errors: [],
    pausedAll: false,
    reloadInProgress: false,
    modules: [
      { id: 'providers.defaults', label: '新建会话默认设置', enabled: false, state: 'off', reloadRequired: true },
      { id: 'answer.presence', label: '问答模式与蓝牙', enabled: true, state: 'running', reloadRequired: true },
      { id: 'answer.browser', label: '网页版 claude.ai', enabled: true, state: 'running', reloadRequired: true },
      { id: 'answer.escalation', label: '升级通知', enabled: false, state: 'off', reloadRequired: true },
      { id: 'answer.quietChildren', label: '子会话免提醒', enabled: false, state: 'off', reloadRequired: true },
      { id: 'usage.claudeAccounts', label: 'Claude 账号与额度', enabled: true, state: 'running', reloadRequired: true },
      { id: 'usage.providerQuotas', label: '其他 Provider 额度', enabled: false, state: 'off', reloadRequired: true },
      { id: 'providers.antigravity', label: 'Antigravity 多账号', enabled: false, state: 'off', reloadRequired: true },
      { id: 'github', label: 'GitHub 订阅', enabled: true, state: 'running', reloadRequired: true },
      { id: 'todo.stalled', label: '停滞会话检查', enabled: true, state: 'running', reloadRequired: true },
    ],
  };
  todo: TodoMergedSnapshot = {
    items: [
      {
        id: 'ask:wq-1',
        type: 'ask',
        label: '网页提问',
        hostId: 'local',
        hostName: 'Mac mini',
        sourceLabel: '网页版 claude.ai · 环境 27',
        sessionTitle: '订单服务开发',
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
        ageText: '等待 2 分钟',
        text: '整合后的插件是否保留独立设置页？',
        url: 'https://claude.ai/code/session_demo',
        question: {
          questionId: 'wq-1',
          fingerprint: 'fp-wq-1',
          prompts: [
            {
              question: '整合后的插件是否保留独立设置页？',
              header: '设置页',
              multiSelect: false,
              allowOther: true,
              options: [
                { label: '不保留（Recommended）', description: '合入 Paseo 设置', recommended: true },
                { label: '保留', description: '单独顶层页面', recommended: false },
              ],
            },
          ],
        },
      },
      {
        id: 'esc:esc-1',
        type: 'esc',
        label: '升级事件',
        hostId: 'local',
        hostName: 'MacBook',
        sourceLabel: '主会话 #1737',
        sessionTitle: '插件整合主会话',
        at: new Date(Date.now() - 8 * 60_000).toISOString(),
        ageText: '已升级 8 分钟',
        text: '是否删除旧的 usage-monitor 插件目录？',
        agentId: 'agent-main',
        escalationId: 'esc-1',
      },
      {
        id: 'web:ww-1',
        type: 'web',
        label: '网页等待',
        hostId: 'local',
        hostName: 'Mac mini',
        sourceLabel: '网页版 claude.ai · 环境 29',
        sessionTitle: '架构整理会话',
        at: new Date(Date.now() - 14 * 60_000).toISOString(),
        ageText: '等待 14 分钟',
        text: '网页权限卡仍显示（已点 Allow once 4 次未消失）',
        url: 'https://claude.ai/code/session_wait',
      },
      {
        id: 'stall:st-1',
        type: 'stall',
        label: '停滞会话',
        hostId: 'local',
        hostName: 'Mac mini',
        sourceLabel: '主会话',
        sessionTitle: '第二期接口对齐',
        at: new Date(Date.now() - 32 * 60_000).toISOString(),
        ageText: '停滞 32 分钟',
        text: '已完成契约检查，等待下一步。',
        agentId: 'agent-main',
      },
      {
        id: 'read:ar-1',
        type: 'read',
        label: '代答未读',
        hostId: 'local',
        hostName: 'Mac mini',
        sourceLabel: '主会话 #1737',
        sessionTitle: '插件整合主会话',
        at: new Date(Date.now() - 60 * 60_000).toISOString(),
        ageText: '1 小时前',
        text: '已自动选择：使用 TypeScript 严格模式（Recommended）',
        readReceipt: {
          questionId: 'ar-1',
          fingerprint: 'fp-ar-1',
        },
      },
    ],
    logs: [
      { id: 'log-1', kind: 'web-approval', label: '网页权限点击', detail: '环境 27 · Allow once（mcp__github__get_issue，820ms 后点击）', hostId: 'local', hostName: 'Mac mini', at: new Date(Date.now() - 120_000).toISOString() },
      { id: 'log-2', kind: 'auto-answer', label: '离线代答', detail: '主会话 #1737 · 选择“使用 TypeScript 严格模式（Recommended）”', hostId: 'local', hostName: 'Mac mini', at: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'log-3', kind: 'escalation', label: '升级投递', detail: '主会话 #1737 · 必须本人确认 → 已发送 Webhook', hostId: 'local', hostName: 'MacBook', at: new Date(Date.now() - 480_000).toISOString() },
      { id: 'log-4', kind: 'quiet-merge', label: '子会话归并', detail: 'p2p 子任务异常 → 已归并到主会话 #1737，未单独播报', hostId: 'local', hostName: 'Mac mini', at: new Date(Date.now() - 1800_000).toISOString() },
    ],
    hosts: [
      { hostId: 'local', hostName: 'Mac mini', online: true, responded: true, error: null, accountsNeedingAttention: 0 },
      { hostId: 'macbook', hostName: 'MacBook', online: true, responded: true, error: null, accountsNeedingAttention: 0 },
    ],
    warning: null,
  };
  readonly log: RpcLogEntry[] = [];
  latencyMs = 30;
  /** 为 true 时所有调用失败，模拟插件服务不可用。 */
  down = false;
  constructor(scene: Scene) {
    this.state = makeSnapshot(scene);
    this.down = scene === 'offline';
  }

  async rpc<I, O>(contract: PluginRpcContract, input: I): Promise<O> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const parsed = contract.input.parse(input) as Record<string, unknown>;
    const summary = contract.name === saveToken.name
      ? `token(${String((parsed as { token: string }).token.length)} 字符)`
      : contract.name === 'browser.usage.save_api_key'
        ? `apiKey(${String((parsed as { apiKey: string }).apiKey.length)} 字符)`
        : JSON.stringify(parsed).slice(0, 120);
    this.log.push({ name: contract.name, at: Date.now(), summary });
    if (this.down) throw new Error('插件服务未响应（fixture：模拟离线）');
    return contract.output.parse(this.handle(contract.name, parsed)) as O;
  }

  private setModuleState(id: string, enabled: boolean): void {
    this.machineSettings = {
      ...this.machineSettings,
      modules: this.machineSettings.modules.map(m =>
        m.id === id ? { ...m, enabled, state: enabled ? 'running' : 'off' } : m,
      ),
    };
  }

  private handle(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
      case 'modules.status':
        return {
          instance: { role: 'main', legacy: false },
          config: { path: this.machineSettings.configPath, source: 'file', errors: [] },
          modules: this.machineSettings.modules.map(m => ({ id: m.id, label: m.label, state: m.state })),
        };
      case 'machine.settings.snapshot':
        return this.machineSettings;
      case 'machine.settings.toggle-module': {
        const id = String(input.id);
        const enabled = Boolean(input.enabled);
        this.setModuleState(id, enabled);
        if (id === 'answer.escalation') this.escalation = { ...this.escalation, enabled };
        if (id === 'answer.quietChildren') this.quiet = { ...this.quiet, enabled };
        if (id === 'answer.browser') this.browser = { ...this.browser, settings: { ...this.browser.settings, enabled } };
        return this.machineSettings;
      }
      case 'machine.settings.pause-all':
        this.machineSettings = { ...this.machineSettings, pausedAll: Boolean(input.paused) };
        return { paused: this.machineSettings.pausedAll };
      case 'machine.settings.export-backup':
        return {
          backupPath: '~/.paseo/github-subscriptions/backups/backup-demo',
          createdAt: new Date().toISOString(),
          files: ['machine.json', 'state.json'],
        };
      case 'todo.list':
        return this.todo;
      case 'todo.act': {
        const action = input.action as { type: string; questionId?: string; escalationId?: string };
        if (action.type === 'answer' || action.type === 'read') {
          this.todo = {
            ...this.todo,
            items: this.todo.items.filter(
              item => item.question?.questionId !== action.questionId && item.readReceipt?.questionId !== action.questionId,
            ),
          };
        } else if (action.type === 'ack-escalation') {
          this.todo = {
            ...this.todo,
            items: this.todo.items.filter(item => item.escalationId !== action.escalationId),
          };
        }
        return { ok: true, message: '已处理' };
      }
      case 'defaults.snapshot':
        return this.defaults;
      case 'defaults.save':
        if (input.enabled !== undefined) this.defaults = { ...this.defaults, enabled: Boolean(input.enabled) };
        if (Array.isArray(input.rules)) this.defaults = { ...this.defaults, rules: input.rules as AgentDefaultRule[] };
        return this.defaults;
      case 'providers.instance.status':
        return {
          instanceState: 'running',
          instanceError: null,
          runningSessionsCount: 2,
          providers: [
            { id: 'cloud-session', label: '云端会话', available: true, runningSessions: 1 },
            { id: 'antigravity', label: 'Antigravity', available: true, runningSessions: 1 },
          ],
          cloudSession: {
            enabled: true,
            onlineSessions: 1,
            unackedMessages: 0,
          },
        };
      case 'cloud-session.status':
        return {
          enabled: true,
          onlineSessions: 1,
          unackedMessages: 0,
        };
      case 'claude-accounts.snapshot':
        return this.claudeAccounts;
      case 'claude-accounts.configure':
        this.claudeAccounts = {
          ...this.claudeAccounts,
          quotaName: {
            ...this.claudeAccounts.quotaName,
            enabled: true,
            ...(input.autoResumeDefault !== undefined ? { autoResumeDefault: Boolean(input.autoResumeDefault) } : {}),
          },
        };
        return this.claudeAccounts;
      case 'claude-accounts.rename':
        this.claudeAccounts = {
          ...this.claudeAccounts,
          accounts: this.claudeAccounts.accounts.map(acc =>
            acc.providerId === input.providerId
              ? {
                  ...acc,
                  ...(input.label !== undefined ? { label: String(input.label) } : {}),
                  ...(input.realEmail !== undefined ? { email: String(input.realEmail) } : {}),
                }
              : acc,
          ),
        };
        return this.claudeAccounts;
      case 'provider-quotas.snapshot':
        return {
          enabled: Boolean(this.machineSettings.modules.find(m => m.id === 'usage.providerQuotas')?.enabled),
          enabledSources: ['antigravity', 'codex-multi', 'qoder', 'glm'],
          hideBuiltin: ['codex', 'grok', 'cursor', 'kimi', 'zai'],
          hideBuiltinApplied: false,
          skippedConflicts: [],
          reloadRequired: false,
          error: null,
        };
      case 'provider-quotas.configure':
        return {
          enabled: input.enabled !== undefined ? Boolean(input.enabled) : true,
          enabledSources: Array.isArray(input.enabledSources) ? (input.enabledSources as string[]) : ['antigravity', 'codex-multi', 'qoder', 'glm'],
          hideBuiltin: Array.isArray(input.hideBuiltin) ? (input.hideBuiltin as string[]) : ['codex', 'grok', 'cursor', 'kimi', 'zai'],
          hideBuiltinApplied: false,
          skippedConflicts: [],
          reloadRequired: true,
          error: null,
        };
      case 'escalation.snapshot':
        return this.escalation;
      case 'escalation.configure':
        this.escalation = {
          ...this.escalation,
          ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled), status: input.enabled ? 'running' : 'stopped' } : {}),
          ...(input.timezone !== undefined ? { timezone: String(input.timezone) } : {}),
          ...(Array.isArray(input.immediate) ? { immediate: input.immediate as EscalationWindow[] } : {}),
          ...(input.delayMinutes !== undefined ? { delayMinutes: Number(input.delayMinutes) } : {}),
        };
        return this.escalation;
      case 'escalation.test-webhook':
        return { sent: true, message: 'Grok 端点已确认收到测试消息' };
      case 'escalation.webhook.configure':
        this.escalation = {
          ...this.escalation,
          webhook: {
            configured: true,
            hostname: 'hooks.example.net',
            fingerprint: 'hooks.example.net/…9f2a',
          },
        };
        return this.escalation.webhook;
      case 'escalation.acknowledge':
        this.escalation = {
          ...this.escalation,
          pendingEvents: this.escalation.pendingEvents.filter(ev => ev.id !== input.id),
        };
        return { ok: true };
      case 'quiet.snapshot':
        return this.quiet;
      case 'quiet.configure':
        this.quiet = {
          ...this.quiet,
          ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
          ...(input.forwardEvents !== undefined ? { forwardEvents: Boolean(input.forwardEvents) } : {}),
        };
        return this.quiet;
      case 'presence.snapshot':
        return this.presence;
      case 'presence.local-speech':
        return { enabled: Boolean(this.presence.localSpeechEnabled), configured: true };
      case 'presence.configure-local-speech': {
        const enabled = Boolean(input.enabled);
        this.presence = { ...this.presence, localSpeechEnabled: enabled, hasSpeechTarget: enabled };
        return this.presence;
      }
      case 'presence.configure':
        this.presence = { ...this.presence, settings: input as unknown as PresenceSettings };
        return this.presence;
      case 'presence.answer':
      case 'presence.read':
        return this.presence;
      case 'bluetooth.list':
        return {
          target: this.bluetoothTarget,
          devices: [
            { name: '随身手机', address: 'AA:BB:CC:DD:EE:01', connected: true, rssi: -52 },
            { name: '降噪耳机', address: 'AA:BB:CC:DD:EE:02', connected: false, rssi: null },
          ],
          error: null,
        };
      case 'bluetooth.select': {
        const target = input.target as { name?: string; address?: string | null } | undefined;
        this.bluetoothTarget = { name: String(target?.name ?? '随身手机'), address: target?.address ?? null, revision: `rev-${Number(this.bluetoothTarget.revision.slice(4)) + 1}` };
        return this.bluetoothTarget;
      }
      case 'todos.stalled':
        return { sessions: [], error: null };
      case 'browser.snapshot':
        return this.browser;
      case 'browser.configure':
        this.browser = { ...this.browser, settings: input as unknown as BrowserSettings, connected: Boolean(input.enabled) };
        return this.browser;
      case 'browser.pairing':
        return { url: `http://127.0.0.1:${this.browser.settings.port}/sync`, token: '演示配对令牌，无实际权限' };
      case 'browser.usage.snapshot':
        return { adspowerApiKeyConfigured: this.adspowerApiKeyConfigured, adspowerApiKeySource: this.adspowerApiKeyConfigured ? 'plugin' : 'none' };
      case 'browser.usage.save_api_key':
        this.adspowerApiKeyConfigured = Boolean(String(input.apiKey ?? '').trim());
        return { adspowerApiKeyConfigured: this.adspowerApiKeyConfigured, adspowerApiKeySource: this.adspowerApiKeyConfigured ? 'plugin' : 'none' };
      case 'browser.usage.remove_api_key':
        this.adspowerApiKeyConfigured = false;
        return { adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' };
      case 'browser.bind': {
        const binding = input as unknown as BrowserBindingInput;
        this.browser = { ...this.browser, bindings: this.browser.bindings.filter(item => item.instanceId !== binding.instanceId || item.sessionId !== binding.sessionId),
          sessions: this.browser.sessions.map(session => session.instanceId === binding.instanceId && session.sessionId === binding.sessionId
            ? { ...session, agentId: binding.agentId, groupTitle: this.paseoSessions.find(item => item.id === binding.agentId)?.title ?? session.title } : session) };
        if (binding.agentId) this.browser.bindings.push({ ...binding, agentId: binding.agentId });
        return this.browser;
      }
      case snapshot.name:
      case pollNow.name:
        return this.state;
      case unsubscribe.name: {
        const before = this.state.subscriptions.length;
        this.state = { ...this.state, subscriptions: this.state.subscriptions.filter((item) => item.id !== input.id) };
        return { removed: this.state.subscriptions.length < before };
      }
      case savePreferences.name:
        this.state = { ...this.state, preferences: input as Snapshot['preferences'] };
        return this.state.preferences;
      case saveToken.name: {
        const token = String(input.token);
        if (token.startsWith('bad')) throw new Error(`GitHub 拒绝了令牌 ${token}（401）`);
        this.state = { ...this.state, token: { ...this.state.token, configured: true, prefix: `${token.slice(0, 5)}…`, login: 'demo-user', error: null } };
        return this.state.token;
      }
      case removeToken.name:
        this.state = { ...this.state, token: { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null } };
        return this.state.token;
      default:
        throw new Error(`未知调用 ${name}`);
    }
  }
}
