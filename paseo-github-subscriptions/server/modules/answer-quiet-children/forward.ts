import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { quietResolveMain } from '../../../shared/quiet.ts';
import type { SharedDaemon } from '../../core/daemon.ts';
import { findMainAncestor, isMainSession, parseWorkspaceRoles, type RoleAgent, type RolesReader, type WorkspaceRoles } from '../../core/session-roles.ts';
import { Attempt } from '../../core/attempt.ts';
import { summarizeError } from '../../core/modules.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import type { NotifyConfig } from '../../notify/config.ts';
import { shellCommandNotice } from '../../notify/commands.ts';
import { Engine, expireOutbox, type Notice } from '../../notify/engine.ts';
import { deliverToCurrentMain } from '../../notify/parent.ts';
import { connectRegisteredHost } from '../../notify/peer.ts';
import type { AgentInfo } from '../../notify/protocol.ts';
import { questionRequest } from '../../notify/routing.ts';
import { loadState, saveState } from '../../notify/store.ts';
import type { HandledRecords } from './handled.ts';
import type { MainResolution } from './resolver.ts';
import { TimelineWatchers } from './watchers.ts';

export interface ForwardOptions {
  server: PluginServerContext;
  daemon: SharedDaemon;
  roles: RolesReader;
  /** 本模块的状态目录：`<状态目录>/quiet-children`。 */
  directory: string;
  machineName: string;
  handled: HandledRecords;
  resolveLocal: (input: { parentId: string; parentWorkspaceId?: string | null; childId?: string }) => Promise<MainResolution>;
  log?: (line: string) => void;
}

/**
 * 子会话事件转发：子会话的提问，以及需要用户接续的事件（合并 master、复盘），发给所属主会话。
 * 普通的完成、出错、命令失败只记录，不叫醒主会话。谁是主会话由会话角色决定（置顶工作区）；
 * 父会话标签只用来找转发目标，接班后改发同工作区最近活动的会话。
 *
 * 与旧插件一致：订阅子会话的时间线检查 shell 命令失败（每个子会话一个订阅）。
 */
export class ForwardRuntime {
  private readonly options: ForwardOptions;
  private attempt: Attempt | null = null;
  private readonly watchers = new TimelineWatchers();
  private readonly lifetime = new AbortController();
  private engine: Engine | null = null;
  private roles: WorkspaceRoles = parseWorkspaceRoles(null);
  private rolesError: string | null = null;
  private localServerId: string | null = null;

  constructor(options: ForwardOptions) { this.options = options; }

  private log(line: string) { (this.options.log ?? console.error)(`[开发自动化·子会话转发] ${line}`); }

  async start(): Promise<void> {
    this.attempt?.cancel();
    const attempt = new Attempt();
    this.attempt = attempt;
    if (this.lifetime.signal.aborted) attempt.cancel();
    try { await this.begin(attempt); }
    catch (error) { attempt.cancel(); throw error; }
  }

  async stop() { this.lifetime.abort(); this.attempt?.cancel(); }

  /** 每次 await 之后检查 attempt，停止或失败清理后不再注册任何东西；清理后才登记的清理函数立即执行。 */
  private async begin(attempt: Attempt): Promise<void> {
    attempt.add(() => this.watchers.releaseAll());
    const { paseo, client } = await this.options.daemon.ready();
    attempt.check();
    const { directory, machineName, server } = this.options;
    const statePath = join(directory, 'forward-state.json');
    const state = await loadState(statePath);
    attempt.check();
    const audit = createAuditWriter(join(directory, 'forward-events.jsonl'));
    const config: NotifyConfig = { hostId: machineName, machine: machineName, delivery: 'live', mains: [], children: {}, coalesceWindowSeconds: 60 };
    const bootDrops = expireOutbox(state, Date.now(), Date.now());
    for (const drop of bootDrops) await audit({ phase: 'outbox-expired', mode: config.delivery, ...drop });
    if (bootDrops.length) await saveState(statePath, state);
    attempt.check();
    this.localServerId = client.getLastServerInfoMessage()?.serverId ?? null;

    const titleOf = (id: string) => engine.state.agents![id]?.title || id;
    const send = async (notice: Notice) => {
      await audit({ phase: 'delivery-attempt', mode: 'live', notice });
      // 没有所属主会话的事件只记录；子会话完结由 Paseo MCP 通知。
      if (!notice.target) throw Object.assign(Error('没有所属主会话，仅记录'), { suppressed: true });
      const originTarget = { ...notice.target };
      const peer = originTarget.serverId ? await connectRegisteredHost(client, originTarget.serverId) : undefined;
      try {
        const host = peer ? createPaseoApi(peer) : paseo;
        const parentWorkspace = engine.state.agents![originTarget.agentId]?.workspaceId ?? null;
        const result = await deliverToCurrentMain(notice, {
          resolve: async id => peer
            ? await peer.invokePluginRpc('github-subscriptions', quietResolveMain.name, { parentAgentId: id, parentWorkspaceId: parentWorkspace }) as MainResolution
            : this.options.resolveLocal({ parentId: id, parentWorkspaceId: parentWorkspace, childId: notice.agentId }),
          pending: async id => {
            const ref = host.agents.ref(id);
            await ref.refresh();
            const snapshot = ref.current();
            return snapshot ? !!(ref.pendingPermissions?.length || (snapshot as { pendingPermissions?: unknown[] }).pendingPermissions?.length) : null;
          },
          send: async id => { await host.agents.ref(id).send(`【会话事件通知】\n${JSON.stringify(notice)}`, { activeTurnBehavior: 'steer', messageId: notice.id }); },
        });
        if (result === 'orphan') {
          this.record(notice, null, 'target-missing', titleOf);
          throw Object.assign(Error('没有现任主会话，仅记录'), { suppressed: true });
        }
        await audit({ phase: 'delivered', mode: 'live', channel: 'paseo', notice });
        this.record(notice, notice.target!.agentId, 'forwarded', titleOf);
      } finally { await peer?.close(); }
    };
    const engine = new Engine(config, state, next => saveState(statePath, next), send, async (id, request) => {
      const ref = paseo.agents.ref(id);
      const snapshot = await ref.refresh();
      if (!snapshot) return false;
      return ref.pendingPermissions?.some(p => p.id === request) ?? false;
    }, audit);
    this.engine = engine;

    const refreshRoles = async () => {
      try { this.roles = await this.options.roles.read(); this.rolesError = null; }
      catch (error) {
        const message = summarizeError(error);
        if (this.rolesError !== message) this.log(`读取置顶工作区失败：${message}`);
        this.rolesError = message;
      }
    };
    const updateAgent = (agent: AgentInfo) => {
      const previous = engine.state.agents![agent.id];
      const labels = agent.labels || previous?.labels;
      const info: AgentInfo = { id: agent.id, workspaceId: agent.workspaceId ?? previous?.workspaceId, title: agent.title ?? previous?.title, provider: agent.provider ?? previous?.provider, labels, parentAgentId: agent.parentAgentId ?? previous?.parentAgentId };
      engine.metadata(info);
      const main = isMainSession(info, this.roles);
      const at = config.mains.indexOf(agent.id);
      if (main && at < 0) config.mains.push(agent.id);
      else if (!main && at >= 0) config.mains.splice(at, 1);
      // 主会话不转发；其余会话沿父会话标签逐层向上，事件转给置顶工作区中的主会话（多层子会话也一样）。
      const ancestor = main ? null : findMainAncestor({ agentId: agent.id, lookup: id => engine.state.agents![id] as RoleAgent | undefined, roles: this.roles, localServerId: this.localServerId });
      if (!ancestor) delete config.children[agent.id];
      else config.children[agent.id] = ancestor.serverId ? { agentId: ancestor.agentId, serverId: ancestor.serverId } : { agentId: ancestor.agentId };
    };
    const refreshClassification = () => {
      for (const agent of Object.values(engine.state.agents!)) updateAgent(agent);
      // 不再是子会话（成了主会话或没有可转发的上层）的，释放它的时间线订阅。
      for (const id of this.watchers.ids()) if (!config.children[id]) this.watchers.release(id);
    };
    const run = (fn: () => Promise<unknown>) => {
      void engine.serial(async () => { await refreshRoles(); refreshClassification(); return fn(); }).catch(error => this.log(`通知处理失败，保留待处理状态：${summarizeError(error)}`));
    };
    const childQuestion = async (agent: { id: string }, request: { id: string }) => {
      const target = config.children[agent.id];
      if (target && questionRequest(request)) await engine.enqueue('asked', agent.id, request, `child-permission:${agent.id}:${request.id}`, target, request.id);
    };

    attempt.add(server.addHook('agent.permission.before', async e => {
      await engine.serial(async () => { await refreshRoles(); updateAgent(e.agent as never); await childQuestion(e.agent, e.request as never); await engine.tick(); });
    }));
    attempt.add(server.addHook('agent.permission.after', async e => {
      await engine.serial(async () => {
        await refreshRoles(); updateAgent(e.agent as never);
        if (config.children[e.agent.id]) await engine.resolved(e.agent.id, e.requestId, e.resolution, false);
        await engine.tick();
      });
    }));
    attempt.add(server.addHook('agent.turn.after', async e => {
      await engine.serial(async () => {
        await refreshRoles(); updateAgent(e.agent as never);
        const target = config.children[e.agent.id];
        if (target) await engine.turnEnded(e.agent.id, e.turnId, e.outcome, target);
        await engine.tick();
      });
    }));
    // 子会话的 shell 命令失败：订阅该子会话的时间线（与旧插件一致）。普通失败只记录，
    // 命令文字含合并 master 或复盘时才转给主会话。
    const observe = (id: string) => this.watchers.watch(id, () => {
      const subscription = paseo.agents.ref(id).timeline.subscribe(message => {
        if (!config.children[id] || message.event.type !== 'timeline') return;
        const notice = shellCommandNotice(id, message.event.item);
        if (!notice) return;
        run(async () => {
          const target = config.children[id];
          if (!target) return;
          await engine.enqueue(notice.event, id, notice.data, notice.key, target);
          await engine.tick();
        });
      });
      return { ready: subscription.ready, stop: () => { void subscription.ready.then(() => subscription(), () => {}); } };
    });
    const watch = (agent: { id: string; archivedAt?: string | null; status?: string }) => {
      // 归档或关闭的会话不会再有新命令：释放订阅。
      if (agent.archivedAt || agent.status === 'closed') { this.watchers.release(agent.id); return; }
      if (!config.children[agent.id] || attempt.cancelled) return;
      void observe(agent.id).catch(() => this.log('子会话时间线订阅失败，稍后重试'));
    };
    const { subscription } = await paseo.agents.list({ subscribe: {}, signal: this.lifetime.signal });
    attempt.add(() => { void subscription.release().catch(() => {}); });
    attempt.check();
    attempt.add(subscription.subscribe({
      snapshot: ({ entries }) => {
        run(async () => {
          for (const { agent } of entries) {
            updateAgent(agent as never);
            watch(agent);
            for (const request of agent.pendingPermissions ?? []) await childQuestion(agent, request as never);
          }
          await engine.tick();
        });
      },
      update: message => {
        if (message.type !== 'agent_update' || message.payload.kind !== 'upsert') return;
        const agent = message.payload.agent;
        run(async () => {
          updateAgent(agent as never);
          watch(agent);
          for (const request of agent.pendingPermissions ?? []) await childQuestion(agent, request as never);
          await engine.tick();
        });
      },
    }));
    const timer = setInterval(() => run(async () => { await engine.tick(); }), 1000);
    attempt.add(() => clearInterval(timer));
    this.log('已启动');
  }

  private record(notice: Notice, forwardedTo: string | null, status: 'forwarded' | 'target-missing', titleOf: (id: string) => string) {
    this.options.handled.add({
      id: notice.id, agentId: notice.agentId, sessionTitle: titleOf(notice.agentId),
      eventKind: notice.event === 'error' ? 'failed' : 'completed', clearedAttention: false,
      forwardedTo: forwardedTo ? titleOf(forwardedTo) : null, forwardStatus: status, at: new Date().toISOString(),
    });
  }

  get error(): string | null { return this.rolesError; }
}
