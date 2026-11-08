import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { QuietSnapshot } from '../../../shared/quiet.ts';
import type { SharedDaemon } from '../../core/daemon.ts';
import { summarizeError } from '../../core/modules.ts';
import { parentLink, type RolesReader } from '../../core/session-roles.ts';
import type { SettingsStore } from '../../core/settings-store.ts';
import { startWithRetry } from '../../core/start-retry.ts';
import { AttentionClearer } from './clearer.ts';
import type { QuietSettings } from './config.ts';
import { ForwardRuntime } from './forward.ts';
import { HandledRecords } from './handled.ts';
import { attentionClearScope, type AgentState } from './policy.ts';
import type { MainResolution } from './resolver.ts';

export interface QuietOptions {
  server: PluginServerContext;
  daemon: SharedDaemon;
  roles: RolesReader;
  /** 本模块的状态目录：`<状态目录>/quiet-children`。 */
  directory: string;
  machineName: string;
  settings: SettingsStore<QuietSettings>;
  resolveLocal: (input: { parentId: string; parentWorkspaceId?: string | null; childId?: string }) => Promise<MainResolution>;
  /** 给出原因时不转发事件（旧插件仍启用）。 */
  forwardBlocked?: string;
  log?: (line: string) => void;
}

type ClearableAgent = AgentState & { id: string; title?: string | null; labels?: Record<string, string> };
const TITLE_CACHE_MS = 30_000;

/**
 * 子会话免提醒：子会话结束、出错或提问后清除“待查看”，侧栏不留未读；等待工具授权的会话保留提醒。
 * 事件转发由 ForwardRuntime 负责，可在页面上随时开关。
 */
export class QuietRuntime {
  readonly handled: HandledRecords;
  private readonly options: QuietOptions;
  private readonly lifetime = new AbortController();
  private readonly titles = new Map<string, string>();
  private clearer: AttentionClearer | null = null;
  private forward: ForwardRuntime | null = null;
  private forwardLifetime: AbortController | null = null;
  private connected = false;
  private error: string | null = null;
  private workspaceTitles: { at: number; value: Map<string, string> } | null = null;
  private rolesFailure: string | null = null;

  constructor(options: QuietOptions) {
    this.options = options;
    this.handled = new HandledRecords(join(options.directory, 'handled.json'));
  }

  private log(line: string) { (this.options.log ?? console.error)(`[开发自动化·子会话免提醒] ${line}`); }
  private settings(): QuietSettings {
    const value = this.options.settings.read();
    return this.options.forwardBlocked ? { ...value, forwardEvents: false } : value;
  }

  start() {
    void startWithRetry(() => this.connect(), {
      delayMs: 60_000, signal: this.lifetime.signal,
      onError: error => { this.error = summarizeError(error); this.log(`连接守护进程失败，60 秒后重试：${this.error}`); },
    });
    this.syncForwarding();
  }

  private async connect() {
    const { client, paseo } = await this.options.daemon.ready();
    const clearer = new AttentionClearer({ clearAgents: ids => client.clearAgentAttention(ids), clearWorkspaces: ids => client.clearWorkspaceAttention(ids), log: line => this.log(line), signal: this.lifetime.signal });
    const { subscription } = await paseo.agents.list({ subscribe: {}, signal: this.lifetime.signal });
    this.clearer = clearer;
    subscription.subscribe({
      snapshot: ({ entries }) => { for (const { agent } of entries) void this.consider(agent as never); },
      update: message => {
        if (message.type !== 'agent_update' || message.payload.kind !== 'upsert') return;
        void this.consider(message.payload.agent as never);
      },
    });
    this.connected = true;
    this.error = null;
    this.log('已连接守护进程');
  }

  private async consider(agent: ClearableAgent) {
    if (agent.title) this.titles.set(agent.id, agent.title);
    if (!this.settings().enabled || !agent.requiresAttention) return;
    let roles;
    try { roles = await this.options.roles.read(); this.rolesFailure = null; }
    catch (error) {
      // 读不到置顶状态就什么都不清除，宁可多留提醒。
      const message = summarizeError(error);
      if (this.rolesFailure !== message) this.log(`读取置顶工作区失败，暂不清除：${message}`);
      this.rolesFailure = message;
      return;
    }
    const scope = attentionClearScope(agent, roles);
    if (!scope) return;
    this.clearer?.enqueue(scope, agent.id, agent.workspaceId);
    const forwarding = await this.forwardStatus(agent);
    this.handled.add({
      id: `${agent.id}:${Date.now()}`, agentId: agent.id, sessionTitle: agent.title || this.titles.get(agent.id) || '未命名会话',
      eventKind: agent.attentionReason === 'error' ? 'failed' : 'completed', clearedAttention: true,
      forwardedTo: forwarding.to, forwardStatus: forwarding.status, at: new Date().toISOString(),
    });
  }

  /** 该子会话的“需要接续的事件”会发给谁。普通的完成和出错只记录，不叫醒主会话。 */
  private async forwardStatus(agent: ClearableAgent): Promise<{ status: QuietSnapshot['recentHandled'][number]['forwardStatus']; to: string | null }> {
    if (!this.settings().forwardEvents) return { status: 'disabled', to: null };
    const link = parentLink(agent);
    if (!link) return { status: 'no-parent', to: null };
    if (link.serverId) return { status: 'forwarded', to: null };
    try {
      const target = await this.options.resolveLocal({ parentId: link.agentId, childId: agent.id });
      return target.agentId ? { status: 'forwarded', to: this.titles.get(target.agentId) ?? target.agentId } : { status: 'target-missing', to: null };
    } catch { return { status: 'target-missing', to: null }; }
  }

  /** 按设置启停事件转发。 */
  private syncForwarding() {
    const want = this.settings().forwardEvents;
    if (want && !this.forward) {
      const forward = new ForwardRuntime({ ...this.options, directory: this.options.directory, handled: this.handled, resolveLocal: this.options.resolveLocal });
      const lifetime = new AbortController();
      this.forward = forward; this.forwardLifetime = lifetime;
      void startWithRetry(() => forward.start(), { delayMs: 60_000, signal: lifetime.signal, onError: error => this.log(`事件转发启动失败，60 秒后重试：${summarizeError(error)}`) });
    } else if (!want && this.forward) {
      this.forwardLifetime?.abort();
      void this.forward.stop();
      this.forward = null; this.forwardLifetime = null;
    }
  }

  async configure(patch: Partial<QuietSettings>) {
    if (patch.forwardEvents && this.options.forwardBlocked) throw new Error(this.options.forwardBlocked);
    this.options.settings.update(patch);
    this.syncForwarding();
    return this.snapshot();
  }

  private async pinnedTitles(): Promise<Map<string, string>> {
    if (this.workspaceTitles && Date.now() - this.workspaceTitles.at < TITLE_CACHE_MS) return this.workspaceTitles.value;
    const value = new Map<string, string>();
    try {
      const connection = this.options.daemon.current();
      if (connection) for (const workspace of (await connection.paseo.workspaces.list()).entries) value.set(workspace.id, workspace.name ?? workspace.id);
    } catch { /* 读不到名称时用编号 */ }
    this.workspaceTitles = { at: Date.now(), value };
    return value;
  }

  async snapshot(): Promise<QuietSnapshot> {
    const settings = this.settings();
    let pinned: string[] = [];
    let rolesError: string | null = null;
    try { pinned = [...(await this.options.roles.read()).pinned]; } catch (error) { rolesError = `读取置顶工作区失败：${summarizeError(error)}`; }
    const titles = await this.pinnedTitles();
    const error = this.error ?? rolesError ?? this.options.forwardBlocked ?? this.forward?.error ?? this.options.settings.error();
    return {
      enabled: settings.enabled,
      forwardEvents: settings.forwardEvents,
      pinnedWorkspaceCount: pinned.length,
      pinnedWorkspaces: pinned.map(id => ({ id, title: titles.get(id) ?? id })),
      recentHandled: this.handled.recent(),
      error: this.connected || !this.settings().enabled ? error : error ?? '正在连接守护进程',
    };
  }

  async stop() {
    this.lifetime.abort();
    this.forwardLifetime?.abort();
    await this.forward?.stop();
  }
}
