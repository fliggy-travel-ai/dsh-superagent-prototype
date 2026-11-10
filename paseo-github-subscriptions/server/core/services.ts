import { Runtime } from '../runtime.ts';
import { BrowserBridge } from '../browser-bridge.ts';
import { PresenceRuntime } from '../presence.ts';
import { PresenceHosts, presencePort } from '../presence-port.ts';
import { StalledRuntime, STALLED_SCAN_INTERVAL_MS } from '../stalled.ts';
import { stalledPort } from '../stalled-port.ts';
import { sessionRoles } from './session-roles.ts';
import type { StalledSnapshot } from '../../shared/stalled.ts';
import { WebRequestLedger } from '../web-request/ledger.ts';
import { WebRequestExecutor } from '../web-request/executor.ts';
import type { SharedDaemon } from './daemon.ts';
import type { ModuleHost } from './modules.ts';
import type { EscalationRuntime } from '../modules/answer-escalation/runtime.ts';
import type { QuietRuntime } from '../modules/answer-quiet-children/runtime.ts';

const STALLED_CACHE_MS = STALLED_SCAN_INTERVAL_MS;

/**
 * 主实例模块共用的运行时。每个运行时第一次使用时才初始化，失败后下次调用重试。
 * 逻辑原样搬自整合前的 index.server.ts，行为不变。
 */
export class MainServices {
  readonly webLedger = new WebRequestLedger();
  readonly webExecutor: WebRequestExecutor;
  host: ModuleHost | null = null;
  runtime: Runtime | null = null;
  browser: BrowserBridge | null = null;
  presence: PresenceRuntime | null = null;
  presenceHosts: PresenceHosts | null = null;
  escalation: EscalationRuntime | null = null;
  quiet: QuietRuntime | null = null;
  stalledPaused = false;
  private stalled: StalledRuntime | null = null;
  private stalledGeneration = 0;
  private readonly directory: string;
  private readonly daemon: SharedDaemon;
  private readonly home: string;
  private stopped = false;
  private initializing: Promise<Runtime> | null = null;
  private presenceInitializing: Promise<PresenceRuntime> | null = null;
  private hostsInitializing: Promise<PresenceHosts> | null = null;
  private browserInitializing: Promise<BrowserBridge> | null = null;

  constructor(directory: string, daemon: SharedDaemon, home?: string) {
    this.directory = directory;
    this.daemon = daemon;
    this.home = home ?? directory;
    this.webExecutor = new WebRequestExecutor(directory, {
      syncStatus: now => this.browser?.syncStatus(now) ?? { connected: false, hasFreshInstance: false, hasStaleInstance: false, freshSessions: [], activeSessions: [] },
      freshSessions: now => this.browser?.freshSessions(now) ?? [],
    }, {
      browserCandidates: (instanceId, sessionId) => this.presence?.browserCandidates(instanceId, sessionId) ?? [],
      isSessionObserved: (instanceId, sessionId) => this.presence?.isSessionObserved(instanceId, sessionId) ?? false,
      delegateBrowserAnswer: (id, answers, otherAnswers, source) => this.presence?.delegateBrowserAnswer(id, answers, otherAnswers, source) ?? false,
      cancelBrowserDecision: id => this.presence?.cancelBrowserDecision(id),
      browserState: id => this.presence?.browserState(id) ?? null,
      noteWebResult: input => this.presence?.noteWebResult(input),
      noteCloudConfirmed: input => this.presence?.noteCloudConfirmed(input),
    }, this.webLedger);
  }

  private guard() {
    return this.stopped ? Promise.reject(new Error('插件已停止')) : null;
  }

  /**
   * 检查模块是否处于运行状态：若有 `host`（`startModules` 已运行），严格检查 `host.status()` 中该模块 `state === 'running'`；
   * 仅当未通过 `startModules` 启动（`this.host === null`）时回退看 `machine.modules[id]`。
   */
  isModuleRunning(
    id: string,
    machine?: { modules?: Record<string, boolean> },
    defaultEnabled = true,
  ): boolean {
    if (this.host) {
      return this.host.status().modules.some(m => m.id === id && m.state === 'running');
    }
    const val = machine?.modules?.[id];
    return val === undefined ? defaultEnabled : val === true;
  }

  invalidateStalledCache(): void {
    this.stalledGeneration += 1;
    this.stalled?.stop();
    this.stalled?.invalidate();
  }

  /**
   * `todo.stalled` 与 `todo` 模块共用的停滞会话扫描实例（后台定时刷新 + 每次调用过滤已运行会话）。
   */
  async stalledSnapshot(
    machine?: { modules?: Record<string, boolean> },
    homeOverride?: string,
  ): Promise<StalledSnapshot> {
    if (this.stopped || this.stalledPaused || !this.isModuleRunning('todo.stalled', machine, true)) {
      this.stalled?.stop();
      return { sessions: [], error: null };
    }
    const generation = this.stalledGeneration;
    const githubRunning = this.isModuleRunning('github', machine, true);
    const [hosts, connection] = await Promise.all([
      this.readyHosts(),
      this.daemon.ready(),
      ...(githubRunning ? [this.github().catch(() => null)] : []),
    ]);
    if (
      this.stopped ||
      this.stalledPaused ||
      !this.isModuleRunning('todo.stalled', machine, true) ||
      generation !== this.stalledGeneration
    ) {
      this.stalled?.stop();
      return { sessions: [], error: null };
    }
    if (!this.stalled) {
      this.stalled = new StalledRuntime(
        stalledPort(
          connection.client,
          hosts,
          () =>
            this.isModuleRunning('github', machine, true) &&
            this.runtime?.storage.state.preferences.enabled &&
            !this.runtime.storage.state.preferences.shadow
              ? this.runtime.storage.state.subscriptions
                  .filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now())
                  .map(subscription => subscription.agentId)
              : [],
          sessionRoles(homeOverride ?? this.home),
        ),
        { cacheTtlMs: STALLED_CACHE_MS, scanIntervalMs: STALLED_SCAN_INTERVAL_MS },
      );
    }
    this.stalled.start();
    const snapshot = await this.stalled.snapshot();
    if (this.stopped || this.stalledPaused || !this.isModuleRunning('todo.stalled', machine, true)) {
      this.stalled.stop();
      return { sessions: [], error: null };
    }
    return snapshot;
  }

  /** GitHub 订阅运行时。 */
  github(): Promise<Runtime> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.initializing ??= (async () => {
      const active = await this.daemon.ready();
      this.runtime = new Runtime(this.directory, active.paseo);
      await this.runtime.start();
      if (this.stopped) await this.runtime.stop();
      return this.runtime;
    })().catch(async error => {
      await this.runtime?.stop();
      this.initializing = null;
      console.error('GitHub 订阅插件初始化失败：', this.runtime?.vault.redact(error) ?? (error instanceof Error ? error.message : '本机连接未就绪，后续操作会重试'));
      throw error;
    });
    return this.initializing;
  }

  readyHosts(): Promise<PresenceHosts> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.hostsInitializing ??= (async () => {
      const connection = await this.daemon.ready();
      this.presenceHosts = new PresenceHosts(connection.client);
      if (this.stopped) await this.presenceHosts.stop();
      return this.presenceHosts;
    })().catch(async error => {
      await this.presenceHosts?.stop();
      this.presenceHosts = null;
      this.hostsInitializing = null;
      throw error;
    });
    return this.hostsInitializing;
  }

  readyPresence(): Promise<PresenceRuntime> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.presenceInitializing ??= (async () => {
      const [connection, hosts] = await Promise.all([this.daemon.ready(), this.readyHosts()]);
      this.presence = new PresenceRuntime(this.directory, presencePort(connection, hosts), Date.now, this.webLedger);
      await this.presence.start();
      if (this.stopped) await this.presence.stop();
      return this.presence;
    })().catch(async error => { await this.presence?.stop(); this.presenceInitializing = null; throw error; });
    return this.presenceInitializing;
  }

  readyBrowser(): Promise<BrowserBridge> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.browserInitializing ??= (async () => {
      this.browser = new BrowserBridge(this.directory, async agentId => {
        const connection = await this.daemon.ready();
        const agent = (await connection.paseo.agents.ref(agentId).refresh())?.agent;
        return agent && !agent.archivedAt ? { id: agent.id, title: agent.title || '未命名 Paseo 会话' } : null;
      }, async (...input) => this.isModuleRunning('answer.presence') ? (await this.readyPresence()).browserSync(...input) : [], async request => {
        await this.readyPresence();
        return this.webExecutor.answerWebRequest(request);
      }, () => this.isModuleRunning('answer.browser'));
      await this.browser.start();
      if (this.stopped) await this.browser.stop();
      return this.browser;
    })().catch(async error => { await this.browser?.stop(); this.browserInitializing = null; throw error; });
    return this.browserInitializing;
  }

  /** 先停模块，再停运行时；顺序与整合前一致。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stalled?.stop();
    try { await this.initializing; } catch {}
    await Promise.allSettled([this.browserInitializing, this.presenceInitializing, this.hostsInitializing]);
    await Promise.allSettled([this.browser?.stop(), this.presence?.stop()]);
    await this.presenceHosts?.stop();
    await this.runtime?.stop();
  }
}
