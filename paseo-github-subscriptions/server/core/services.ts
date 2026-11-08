import { Runtime } from '../runtime.ts';
import { AutomationRuntime } from '../automation.ts';
import { automationPort } from '../automation-port.ts';
import { BrowserBridge } from '../browser-bridge.ts';
import { PresenceRuntime } from '../presence.ts';
import { PresenceHosts, presencePort } from '../presence-port.ts';
import { WebRequestLedger } from '../web-request/ledger.ts';
import { WebRequestExecutor } from '../web-request/executor.ts';
import type { SharedDaemon } from './daemon.ts';

/**
 * 主实例模块共用的运行时。每个运行时第一次使用时才初始化，失败后下次调用重试。
 * 逻辑原样搬自整合前的 index.server.ts，行为不变。
 */
export class MainServices {
  readonly webLedger = new WebRequestLedger();
  readonly webExecutor: WebRequestExecutor;
  runtime: Runtime | null = null;
  automation: AutomationRuntime | null = null;
  browser: BrowserBridge | null = null;
  presence: PresenceRuntime | null = null;
  presenceHosts: PresenceHosts | null = null;
  private readonly directory: string;
  private readonly daemon: SharedDaemon;
  private stopped = false;
  private initializing: Promise<Runtime> | null = null;
  private automationInitializing: Promise<AutomationRuntime> | null = null;
  private presenceInitializing: Promise<PresenceRuntime> | null = null;
  private browserInitializing: Promise<BrowserBridge> | null = null;

  constructor(directory: string, daemon: SharedDaemon) {
    this.directory = directory;
    this.daemon = daemon;
    this.webExecutor = new WebRequestExecutor(directory, {
      syncStatus: now => this.browser?.syncStatus(now) ?? { connected: false, hasFreshInstance: false, hasStaleInstance: false, freshSessions: [], activeSessions: [] },
      freshSessions: now => this.browser?.freshSessions(now) ?? [],
    }, {
      browserCandidates: (instanceId, sessionId) => this.presence?.browserCandidates(instanceId, sessionId) ?? [],
      isSessionObserved: (instanceId, sessionId) => this.presence?.isSessionObserved(instanceId, sessionId) ?? false,
      delegateBrowserAnswer: (id, answers, otherAnswers, source) => this.presence?.delegateBrowserAnswer(id, answers, otherAnswers, source) ?? false,
      cancelBrowserDecision: id => this.presence?.cancelBrowserDecision(id),
      browserState: id => this.presence?.browserState(id) ?? null,
    }, this.webLedger);
  }

  private guard() {
    return this.stopped ? Promise.reject(new Error('插件已停止')) : null;
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

  readyAutomation(): Promise<AutomationRuntime> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.automationInitializing ??= (async () => {
      const connection = await this.daemon.ready();
      this.automation = new AutomationRuntime(this.directory, automationPort(connection.paseo, connection.approve));
      await this.automation.start();
      if (this.stopped) await this.automation.stop();
      return this.automation;
    })().catch(async error => { await this.automation?.stop(); this.automationInitializing = null; throw error; });
    return this.automationInitializing;
  }

  readyPresence(): Promise<PresenceRuntime> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.presenceInitializing ??= (async () => {
      const connection = await this.daemon.ready();
      this.presenceHosts = new PresenceHosts(connection.client);
      this.presence = new PresenceRuntime(this.directory, presencePort(connection, this.presenceHosts), Date.now, this.webLedger);
      await this.presence.start();
      if (this.stopped) await this.presence.stop();
      return this.presence;
    })().catch(async error => { await this.presence?.stop(); await this.presenceHosts?.stop(); this.presenceInitializing = null; throw error; });
    return this.presenceInitializing;
  }

  readyBrowser(): Promise<BrowserBridge> {
    const stopped = this.guard(); if (stopped) return stopped;
    this.browserInitializing ??= (async () => {
      const connection = await this.daemon.ready();
      this.browser = new BrowserBridge(this.directory, async agentId => {
        const agent = (await connection.paseo.agents.ref(agentId).refresh())?.agent;
        return agent && !agent.archivedAt ? { id: agent.id, title: agent.title || '未命名 Paseo 会话' } : null;
      }, async (...input) => (await this.readyPresence()).browserSync(...input), async request => {
        await this.readyPresence();
        return this.webExecutor.answerWebRequest(request);
      });
      await this.browser.start();
      if (this.stopped) await this.browser.stop();
      return this.browser;
    })().catch(async error => { await this.browser?.stop(); this.browserInitializing = null; throw error; });
    return this.browserInitializing;
  }

  /** 先停模块，再停运行时；顺序与整合前一致。 */
  async stop(): Promise<void> {
    this.stopped = true;
    try { await this.initializing; } catch {}
    await Promise.allSettled([this.automationInitializing, this.browserInitializing, this.presenceInitializing]);
    await Promise.allSettled([this.automation?.stop(), this.browser?.stop(), this.presence?.stop()]);
    await this.presenceHosts?.stop();
    await this.runtime?.stop();
  }
}
