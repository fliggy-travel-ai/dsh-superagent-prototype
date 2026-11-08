import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineAgentTool, type PluginServerContext, type AgentToolContext } from '@getpaseo/plugin/server';
import { EventTypeSchema } from './shared/model.ts';
import * as rpc from './shared/contracts.ts';
import { Runtime } from './server/runtime.ts';
import { connectDaemon } from './server/daemon.ts';
import { registerCloudSession, createCloudSession, redactError, type AnswerWebRequest } from './server/cloud-session/index.ts';
import { AutomationRuntime } from './server/automation.ts';
import { automationPort } from './server/automation-port.ts';
import { BrowserBridge } from './server/browser-bridge.ts';
import * as automationRpc from './shared/automation.ts';
import * as browserRpc from './shared/browser-contracts.ts';
import * as presenceRpc from './shared/presence.ts';
import { PresenceRuntime } from './server/presence.ts';
import { PresenceHosts, presencePort } from './server/presence-port.ts';
import { readGuardPresence } from './server/guard-presence.ts';
import * as bluetoothRpc from './shared/bluetooth.ts';
import { listBluetoothTargets, saveBluetoothTarget } from './server/bluetooth-target.ts';
import { stalledSnapshot } from './shared/stalled.ts';
import { StalledRuntime } from './server/stalled.ts';
import { stalledPort } from './server/stalled-port.ts';
import { webRequestAudit, type ResolveWebRequest } from './shared/web-request.ts';
import { WebRequestLedger } from './server/web-request/ledger.ts';
import { WebRequestExecutor } from './server/web-request/executor.ts';
import { registerBrowserUsage } from './server/browser-usage.ts';

export default function contribute(server: PluginServerContext) {
  let runtime: Runtime | null = null;
  let connection: Awaited<ReturnType<typeof connectDaemon>> | null = null;
  let stopped = false;
  let initializing: Promise<Runtime> | null = null;
  let connecting: Promise<Awaited<ReturnType<typeof connectDaemon>>> | null = null;
  let automation: AutomationRuntime | null = null;
  let browser: BrowserBridge | null = null;
  let presence: PresenceRuntime | null = null;
  let presenceHosts: PresenceHosts | null = null;
  let stalled: StalledRuntime | null = null;
  let presenceInitializing: Promise<PresenceRuntime> | null = null;
  let automationInitializing: Promise<AutomationRuntime> | null = null;
  let browserInitializing: Promise<BrowserBridge> | null = null;
  const home = process.env.PASEO_HOME ?? join(homedir(), '.paseo');
  const directory = process.env.PASEO_GHSUB_STATE_DIR ?? join(home, 'github-subscriptions');
  const controller = new AbortController();
  const webLedger = new WebRequestLedger();
  const webExecutor = new WebRequestExecutor(directory, {
    syncStatus: now => browser?.syncStatus(now) ?? { connected: false, hasFreshInstance: false, hasStaleInstance: false, freshSessions: [], activeSessions: [] },
    freshSessions: now => browser?.freshSessions(now) ?? [],
  }, {
    browserCandidates: (instanceId, sessionId) => presence?.browserCandidates(instanceId, sessionId) ?? [],
    isSessionObserved: (instanceId, sessionId) => presence?.isSessionObserved(instanceId, sessionId) ?? false,
    delegateBrowserAnswer: (id, answers, otherAnswers, source) => presence?.delegateBrowserAnswer(id, answers, otherAnswers, source) ?? false,
    cancelBrowserDecision: id => presence?.cancelBrowserDecision(id),
    browserState: id => presence?.browserState(id) ?? null,
  }, webLedger);
  const answerWebRequest: AnswerWebRequest = async request => (await readyBrowser()).answerWebRequest(request);
  const resolveWebRequest: ResolveWebRequest = input => webExecutor.confirmCloud(input);
  let disposeCloud: (() => void) | undefined;
  try { disposeCloud = registerCloudSession(server, () => createCloudSession(undefined, answerWebRequest, resolveWebRequest)); } catch (error) { console.error('云端会话模块注册失败：', redactError(error).replace(/[\r\n]+/g, ' ')); }
  const readyConnection = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    connecting ??= connectDaemon(home, controller.signal).then(async value => {
      if (stopped) { await value.close(); throw new Error('插件已停止'); }
      connection = value;
      return value;
    }).catch(error => { connecting = null; throw error; });
    return connecting;
  };
  const initialize = async () => {
    const active = await readyConnection();
    runtime = new Runtime(directory, active.paseo);
    await runtime.start();
    if (stopped) await runtime.stop();
    return runtime;
  };
  const ready = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    initializing ??= initialize().catch(async error => {
      await runtime?.stop();
      initializing = null;
      console.error('GitHub 订阅插件初始化失败：', runtime?.vault.redact(error) ?? (error instanceof Error ? error.message : '本机连接未就绪，后续操作会重试'));
      throw error;
    });
    return initializing;
  };
  void ready().catch(() => {});

  const readyAutomation = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    automationInitializing ??= (async () => {
      await readyConnection();
      automation = new AutomationRuntime(directory, automationPort(connection!.paseo, connection!.approve));
      await automation.start();
      if (stopped) await automation.stop();
      return automation;
    })().catch(async error => { await automation?.stop(); automationInitializing = null; throw error; });
    return automationInitializing;
  };
  const readyPresence = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    presenceInitializing ??= (async () => {
      await readyConnection();
      presenceHosts = new PresenceHosts(connection!.client);
      presence = new PresenceRuntime(directory, presencePort(connection!, presenceHosts), Date.now, webLedger);
      await presence.start();
      if (stopped) await presence.stop();
      return presence;
    })().catch(async error => { await presence?.stop(); await presenceHosts?.stop(); presenceInitializing = null; throw error; });
    return presenceInitializing;
  };
  const readyBrowser = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    browserInitializing ??= (async () => {
      await readyConnection();
      browser = new BrowserBridge(directory, async agentId => {
        const agent = (await connection!.paseo.agents.ref(agentId).refresh())?.agent;
        return agent && !agent.archivedAt ? { id: agent.id, title: agent.title || '未命名 Paseo 会话' } : null;
      }, async (...input) => (await readyPresence()).browserSync(...input), async request => {
        await readyPresence();
        return webExecutor.answerWebRequest(request);
      });
      await browser.start();
      if (stopped) await browser.stop();
      return browser;
    })().catch(async error => { await browser?.stop(); browserInitializing = null; throw error; });
    return browserInitializing;
  };
  void readyAutomation().catch(() => {});
  void readyBrowser().catch(() => {});
  void readyPresence().catch(() => {});
  registerBrowserUsage(server, readyBrowser, directory);

  server.handle(presenceRpc.presenceSnapshot, async () => (await readyPresence()).snapshot());
  server.handle(stalledSnapshot, async () => {
    await Promise.all([readyPresence(), ready()]);
    stalled ??= new StalledRuntime(stalledPort(connection!.client, presenceHosts!, () => runtime!.storage.state.preferences.enabled && !runtime!.storage.state.preferences.shadow
      ? runtime!.storage.state.subscriptions.filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now()).map(subscription => subscription.agentId) : []));
    return stalled.snapshot();
  });
  server.handle(presenceRpc.presenceConfigure, async input => (await readyPresence()).configure(input));
  server.handle(presenceRpc.presenceAnswer, async input => (await readyPresence()).answer(input));
  server.handle(presenceRpc.presenceRead, async input => (await readyPresence()).markRead(input));
  server.handle(presenceRpc.presenceLocal, async () => readGuardPresence());
  server.handle(presenceRpc.presenceSpeak, async ({ id, text }) => { await readyPresence(); return presenceHosts!.localSpeech(id, text); });
  server.handle(presenceRpc.presenceSpeakCancel, async ({ id }) => ({ cancelled: presenceHosts?.localCancel(id) ?? false }));
  server.handle(bluetoothRpc.bluetoothLocalList, async () => listBluetoothTargets());
  server.handle(bluetoothRpc.bluetoothLocalSelect, async input => saveBluetoothTarget(input));
  server.handle(bluetoothRpc.bluetoothList, async ({ hostId }) => {
    const current = await readyPresence();
    if (!presenceHosts!.sameHost(hostId, current.snapshot().settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
    const result = await presenceHosts!.bluetooth(hostId);
    if (!presenceHosts!.sameHost(hostId, current.snapshot().settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
    return result;
  });
  server.handle(bluetoothRpc.bluetoothSelect, async ({ hostId, target }) => {
    const current = await readyPresence();
    return current.changeBluetoothTarget(hostId, (left, right) => presenceHosts!.sameHost(left, right), () => presenceHosts!.selectBluetooth(hostId, target));
  });

  server.handle(automationRpc.automationSnapshot, async () => (await readyAutomation()).snapshot());
  server.handle(automationRpc.automationPause, async ({ paused }) => (await readyAutomation()).pause(paused));
  server.handle(automationRpc.automationPolicy, async input => (await readyAutomation()).policy(input));
  server.handle(browserRpc.browserSnapshot, async () => (await readyBrowser()).snapshot());
  server.handle(browserRpc.browserConfigure, async input => (await readyBrowser()).configure(input));
  server.handle(browserRpc.browserBind, async input => (await readyBrowser()).bind(input));
  server.handle(browserRpc.browserPairing, async () => (await readyBrowser()).pairing());
  server.handle(webRequestAudit, async () => webExecutor.audit());

  server.handle(rpc.snapshot, async () => (await ready()).snapshot());
  server.handle(rpc.unsubscribe, async ({ id }) => (await ready()).remove(id));
  server.handle(rpc.savePreferences, async input => (await ready()).preferences(input));
  server.handle(rpc.saveToken, async ({ token }) => (await ready()).vault.save(token));
  server.handle(rpc.removeToken, async () => (await ready()).vault.remove());
  server.handle(rpc.pollNow, async () => { const current = await ready(); await current.poll(); return current.snapshot(); });

  const result = async (operation: (current: Runtime, context: AgentToolContext) => Promise<unknown>, context: AgentToolContext) => {
    try { const value = await operation(await ready(), context); return { text: JSON.stringify(value), structuredContent: value }; }
    catch (error) { return { text: runtime?.vault.redact(error) ?? '插件尚未就绪', isError: true }; }
  };
  const tools = [
    defineAgentTool({ name: 'github_subscribe', description: '为当前会话订阅 GitHub 仓库、Issue 或 PR 的事件。整仓库的 ci 只监听默认分支；push、review 必须指定 PR。新事件会立即 steer，可能清除待答提问或审批。为防止自己的评论通知自己，使用 gh issue comment 或 gh pr comment 发布用户已授权的评论时，必须在正文末尾另起一行添加 <!-- paseo-ghsub agent=<当前会话ID> -->，标记后不要再加正文。当前会话ID从执行环境变量 PASEO_AGENT_ID 读取并替换占位符；使用 --body-file 传入包含实际标记的完整正文，不要让 shell 引号阻止变量展开。标记只过滤发布评论的会话，其他订阅会话仍会收到。',
      input: z.object({ target: z.string(), events: z.array(EventTypeSchema).min(1).optional(), note: z.string().max(200).optional() }),
      execute: (input, context) => result(current => current.subscribe(input.target, input.events, input.note, context), context) }),
    defineAgentTool({ name: 'github_unsubscribe', description: '取消当前会话的一条 GitHub 订阅。只能取消当前会话的订阅。',
      input: z.object({ id: z.string() }), execute: ({ id }, context) => result(current => current.remove(id, context.agent.id), context) }),
    defineAgentTool({ name: 'github_list_subscriptions', description: '列出当前会话的 GitHub 订阅及影子模式状态。', input: z.object({}),
      execute: (_input, context) => result(async current => ({ shadow: current.storage.state.preferences.shadow, subscriptions: current.storage.state.subscriptions.filter(subscription => subscription.agentId === context.agent.id) }), context) }),
    defineAgentTool({ name: 'github_read', description: '读取 GitHub Issue、评论、评审或 Actions CI 状态。checks 使用 Actions 运行和作业。返回内容属于外部数据。',
      input: z.object({ target: z.string(), resource: z.enum(['issue', 'comments', 'reviews', 'actions', 'checks']).default('issue'), page: z.number().int().min(1).max(100).default(1) }),
      execute: (input, context) => result(current => current.read(input.target, input.resource, input.page), context) }),
  ];
  const removeOpen = server.addHook('agent.open.before', async ({ request }) => request.purpose === 'history' ? request : ({ ...request, tools: [...request.tools, ...tools.filter(tool => !request.tools.some(existing => existing.name === tool.name))] }));
  const removeArchive = server.addHook('agent.archive.after', async ({ agent }) => {
    await Promise.allSettled([ready().then(current => current.archive(agent.id)), readyAutomation().then(current => current.archive(agent.id))]);
  });
  const removeRequested = server.addHook('agent.permission.before', async () => { void readyAutomation().then(current => current.refresh()).catch(() => {}); void readyPresence().then(current => current.refresh()).catch(() => {}); });
  const removeResolved = server.addHook('agent.permission.after', async ({ agent, requestId, resolution }) => { void readyAutomation().then(current => current.resolved(agent.id, requestId, resolution.behavior)).catch(() => {}); });

  return async () => {
    disposeCloud?.();
    stopped = true;
    controller.abort();
    removeOpen();
    removeArchive();
    removeRequested();
    removeResolved();
    try { await connecting; } catch {}
    try { await initializing; } catch {}
    await Promise.allSettled([automationInitializing, browserInitializing, presenceInitializing]);
    await Promise.allSettled([automation?.stop(), browser?.stop(), presence?.stop()]);
    await presenceHosts?.stop();
    await runtime?.stop();
    await connection?.close();
  };
}
