import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { EscalationSnapshot } from '../../../shared/escalation.ts';
import type { SharedDaemon } from '../../core/daemon.ts';
import { isMainSession, type RolesReader, type WorkspaceRoles, parseWorkspaceRoles } from '../../core/session-roles.ts';
import type { SettingsStore } from '../../core/settings-store.ts';
import { summarizeError } from '../../core/modules.ts';
import { Attempt } from '../../core/attempt.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import type { NotifyConfig } from '../../notify/config.ts';
import { Engine, expireOutbox, type Notice } from '../../notify/engine.ts';
import { duplicateWorkspaceIds, type AgentInfo, type WorkspaceInfo } from '../../notify/protocol.ts';
import { questionRequest } from '../../notify/routing.ts';
import { EscalationScheduleSchema, holdAsked } from '../../notify/schedule.ts';
import { loadState, saveState } from '../../notify/store.ts';
import type { RuntimeSettings, EscalationSection } from './config.ts';
import { createSender } from './deliver.ts';
import { prefilter } from './prefilter.ts';
import { QuotaAlerts, isQuotaError, postQuotaAlert, quotaWebhookConfigPath, quotaWebhookCredentials, quotaWebhookFileDir } from './quota.ts';
import { CLOSED_REASON_TEXT, EscalationRecords } from './records.ts';
import { EscalationReconciler, agentView } from './reconcile.ts';
import { credentialFingerprint, postNotice, storeWebhookCredentials, webhookCredentials, type WebhookCredentials } from './webhook.ts';

export interface EscalationOptions {
  server: PluginServerContext;
  daemon: SharedDaemon;
  roles: RolesReader;
  /** 本模块的状态目录：`<状态目录>/escalation`。 */
  directory: string;
  machineName: string;
  section: EscalationSection;
  settings: SettingsStore<RuntimeSettings>;
  /** 旧插件仍启用时不能发送，否则同一事件会发两次。给出原因就不启动，面板显示原因。 */
  blocked?: string;
  /** 测试用：替换额度报警凭据的读取。 */
  quotaCredentials?: () => Promise<{ url: string; auth: string } | null>;
  log?: (line: string) => void;
  /** 测试用：替换凭据读取和投递。 */
  credentials?: () => Promise<WebhookCredentials>;
}

const WEBHOOK_CACHE_MS = 60_000;
/** 定时对账间隔：补上漏掉的钩子和订阅推送（重载、连接中断、跨重启的存量记录）。 */
const RECONCILE_MS = 60_000;

/**
 * 升级通知运行时。主会话（置顶工作区中的会话）的提问和错误按时段规则送到 Grok webhook；
 * 新建项目和工作区也通知；另有额度报警。与代答（answer.presence）互不依赖。
 * 子会话事件转发由 answer.quietChildren 负责，不在这里。
 */
export class EscalationRuntime {
  health: 'starting' | 'ready' | 'failed' = 'starting';
  error: string | null = null;
  readonly records: EscalationRecords;
  private readonly options: EscalationOptions;
  private readonly lifetime = new AbortController();
  private attempt: Attempt | null = null;
  private engine: Engine | null = null;
  private readonly statePath: string;
  private quotaAlerts: QuotaAlerts | null = null;
  private roles: WorkspaceRoles = parseWorkspaceRoles(null);
  private rolesError: string | null = null;
  private webhookCache: { at: number; value: EscalationSnapshot['webhook'] } | null = null;
  private stopped = false;

  constructor(options: EscalationOptions) {
    this.options = options;
    this.records = new EscalationRecords(join(options.directory, 'records.json'));
    // 影子模式已删除：只用 state.json；旧的 state-shadow.json 不读不写。
    this.statePath = join(options.directory, 'state.json');
  }

  private log(line: string) { (this.options.log ?? console.error)(`[开发自动化·升级通知] ${line}`); }
  private settings(): RuntimeSettings {
    return this.options.settings.read();
  }
  private credentials(): Promise<WebhookCredentials> {
    return this.options.credentials ? this.options.credentials() : webhookCredentials(this.options.section.webhook);
  }

  /** 连接守护进程并开始监听。失败时清掉已注册的钩子和订阅再抛错，调用方稍后重试。 */
  async start(): Promise<void> {
    this.attempt?.cancel();
    const attempt = new Attempt();
    this.attempt = attempt;
    if (this.stopped) attempt.cancel();
    if (this.options.blocked) { attempt.cancel(); return; }
    try { await this.begin(attempt); }
    catch (error) { attempt.cancel(); throw error; }
  }

  /** 每次 await 之后检查 attempt，停止或失败清理后不再注册任何东西；清理后才登记的清理函数立即执行。 */
  private async begin(attempt: Attempt): Promise<void> {
    const { paseo, client } = await this.options.daemon.ready();
    attempt.check();
    const { directory, machineName, section, server } = this.options;
    const state = await loadState(this.statePath);
    attempt.check();
    const auditPath = join(directory, 'events.jsonl');
    const audit = createAuditWriter(auditPath);
    const reconciler = new EscalationReconciler({
      records: this.records,
      audit,
      lookup: async id => {
        const ref = paseo.agents.ref(id);
        if (!(await ref.refresh())) return null;
        const current = ref.current();
        return current ? agentView(current) : null;
      },
      log: line => this.log(line),
    });
    const config: NotifyConfig = {
      hostId: machineName, machine: machineName, delivery: 'live', mains: [], children: {}, coalesceWindowSeconds: 60,
      hold: (first, now) => holdAsked(EscalationScheduleSchema.parse(this.schedule()))(first, now),
    };
    // 重载不补发旧事件：清掉早于本次启动的积压；仍待答的问题由 pending 重建后正常投递。
    const bootDrops = expireOutbox(state, Date.now(), Date.now());
    for (const drop of bootDrops) await audit({ phase: 'outbox-expired', mode: config.delivery, ...drop });
    if (bootDrops.length) await saveState(this.statePath, state);
    attempt.check();

    const send = createSender({
      audit,
      isMain: id => config.mains.includes(id),
      prefilter: payload => prefilter(section.prefilter, payload),
      credentials: () => this.credentials(),
      post: (notice, credentials) => postNotice(notice, credentials, this.lifetime.signal),
      records: this.records,
      log: line => console.log(line),
    });
    const engine = new Engine(config, state, next => saveState(this.statePath, next), send, async (id, request) => {
      const ref = paseo.agents.ref(id);
      const snapshot = await ref.refresh();
      if (!snapshot) return false;
      return ref.pendingPermissions?.some(p => p.id === request) ?? false;
    }, audit);
    engine.onResolved = (agentId, requestId) => reconciler.closeRequest(agentId, requestId).then(() => {});
    this.engine = engine;

    const workspaces = new Map<string, WorkspaceInfo>();
    const refreshRoles = async () => {
      try { this.roles = await this.options.roles.read(); this.rolesError = null; }
      catch (error) {
        const message = summarizeError(error);
        // 读不到置顶状态时保留上次结果，不把所有会话当作没有主会话。
        if (this.rolesError !== message) this.log(`读取置顶工作区失败：${message}`);
        this.rolesError = message;
      }
    };
    const updateAgent = (agent: AgentInfo & { status?: string }) => {
      const previous = engine.state.agents![agent.id];
      const labels = agent.labels || previous?.labels;
      const parentAgentId = agent.parentAgentId === undefined ? labels?.['paseo.parent-agent-id'] || previous?.parentAgentId : agent.parentAgentId;
      const info: AgentInfo = { id: agent.id, workspaceId: agent.workspaceId ?? previous?.workspaceId, title: agent.title ?? previous?.title, provider: agent.provider ?? previous?.provider, labels, parentAgentId };
      engine.metadata(info);
      const at = config.mains.indexOf(agent.id);
      const main = isMainSession(info, this.roles);
      if (main && at < 0) config.mains.push(agent.id);
      else if (!main && at >= 0) config.mains.splice(at, 1);
    };
    const refreshClassification = () => { for (const agent of Object.values(engine.state.agents!)) updateAgent(agent); };
    const tick = async () => { if (this.settings().enabled) await engine.tick(); };
    const run = (fn: () => Promise<unknown>) => {
      void engine.serial(async () => { await refreshRoles(); refreshClassification(); return fn(); }).catch(error => this.log(`通知处理失败，保留待处理状态：${summarizeError(error)}`));
    };
    const asked = async (agent: { id: string }, request: { id: string; kind?: string; name?: string }) => {
      if (config.mains.includes(agent.id) && questionRequest(request)) await engine.asked(agent.id, request.id, request);
    };

    attempt.add(server.addHook('agent.permission.before', async e => {
      await engine.serial(async () => { await refreshRoles(); updateAgent(e.agent as never); await asked(e.agent, e.request as never); await tick(); });
    }));
    attempt.add(server.addHook('agent.permission.after', async e => {
      await engine.serial(async () => {
        await refreshRoles(); updateAgent(e.agent as never);
        if (config.mains.includes(e.agent.id)) await engine.resolved(e.agent.id, e.requestId, e.resolution, true);
        // 已不再是主会话（置顶取消）的旧升级事件同样结束。
        else await reconciler.closeRequest(e.agent.id, e.requestId);
        await tick();
      });
    }));
    attempt.add(server.addHook('agent.turn.after', async e => {
      await engine.serial(async () => {
        await refreshRoles(); updateAgent(e.agent as never);
        if (config.mains.includes(e.agent.id) && e.outcome.kind === 'failed') await engine.turnEnded(e.agent.id, e.turnId, e.outcome);
        await tick();
      });
      // 主会话因限额失败的轮次立即触发额度报警，其余交给周期巡检。
      if (e.outcome.kind === 'failed' && isQuotaError(e.outcome.error?.message) && config.mains.includes(e.agent.id))
        void this.quotaAlerts?.onSessionQuotaError(e.agent.id, e.outcome.error.message).catch(() => this.log('额度报警检查失败'));
    }));

    const { subscription } = await paseo.agents.list({ subscribe: {}, signal: this.lifetime.signal });
    attempt.add(() => { void subscription.release().catch(() => {}); });
    attempt.check();
    const statuses = new Map<string, string>();
    const settle = async (agent: Parameters<typeof agentView>[0] & { id: string }) => {
      if (this.records.agentsWithOpen().includes(agent.id)) await reconciler.settle(agent.id, agentView(agent));
    };
    attempt.add(subscription.subscribe({
      snapshot: ({ entries }) => {
        run(async () => {
          for (const { agent } of entries) {
            updateAgent(agent as never);
            statuses.set(agent.id, agent.status);
            await settle(agent);
            if (config.mains.includes(agent.id)) for (const request of agent.pendingPermissions ?? []) await asked(agent, request as never);
          }
          await tick();
        });
      },
      update: message => {
        if (message.type !== 'agent_update') return;
        // 移出列表（例如归档）时逐个查询现状，不凭移出本身结束。
        if (message.payload.kind !== 'upsert') { run(() => reconciler.sweep()); return; }
        const agent = message.payload.agent;
        run(async () => {
          updateAgent(agent as never);
          await settle(agent);
          const previous = statuses.get(agent.id);
          statuses.set(agent.id, agent.status);
          if (previous && previous !== agent.status && agent.status === 'error' && config.mains.includes(agent.id))
            await engine.enqueue('error', agent.id, { previous, status: agent.status }, `state:${randomUUID()}`);
          for (const request of agent.pendingPermissions ?? []) await asked(agent, request as never);
          await tick();
        });
      },
    }));

    if (section.newObjects) await this.watchNewObjects(attempt, paseo, engine, workspaces, run, refreshRoles);
    attempt.check();
    const timer = setInterval(() => run(async () => { await tick(); }), 1000);
    attempt.add(() => clearInterval(timer));
    // 存量记录：回填请求编号后立即对账一次（只结束已归档或不存在的），之后定时对账。
    // 引擎对账同样按等待列表判断，启动宽限期内不做。
    const reconcile = async () => { await reconciler.sweep(); if (reconciler.trusted()) await engine.reconcilePending(); };
    run(async () => { await reconciler.backfill(auditPath); await reconcile(); });
    const reconcileTimer = setInterval(() => run(reconcile), RECONCILE_MS);
    attempt.add(() => clearInterval(reconcileTimer));
    if (section.quotaAlerts.enabled) {
      this.quotaAlerts = new QuotaAlerts({
        listReports: () => client.listUsageReports(),
        listAgentReports: agentId => client.listUsageReports({ agentId }),
        credentials: () => this.quotaCredentials(),
        post: (payload, credentials) => postQuotaAlert(payload, credentials, this.lifetime.signal),
        audit,
        mains: () => config.mains.map(id => engine.state.agents![id]).filter(Boolean).map(a => ({ agentId: a!.id, workspaceId: a!.workspaceId || null, title: a!.title || null, provider: a!.provider || null })),
        machine: machineName,
        hostId: machineName,
        statePath: join(directory, 'quota-alerts.json'),
      });
      const alerts = this.quotaAlerts;
      attempt.add(() => { alerts.stop(); if (this.quotaAlerts === alerts) this.quotaAlerts = null; });
      await alerts.start();
      attempt.check();
    }
    this.health = 'ready';
    this.error = null;
    this.log('已启动');
  }

  private async watchNewObjects(attempt: Attempt, paseo: Awaited<ReturnType<SharedDaemon['ready']>>['paseo'], engine: Engine, workspaces: Map<string, WorkspaceInfo>, run: (fn: () => Promise<unknown>) => void, refreshRoles: () => Promise<void>) {
    const pathOf = async (path: string) => { try { return await realpath(path); } catch { return path.replace(/\/$/, ''); } };
    const announce = async (workspace: { id: string; name: string | null }, path: string, duplicates: string[]) => {
      await engine.enqueue('new_workspace', '', { workspaceId: workspace.id, title: workspace.name ?? '', path, duplicateWorkspaceIds: duplicates }, `workspace:${workspace.id}`);
      const job = engine.state.outbox.find(item => item.notice.key === `workspace:${workspace.id}`);
      if (job) { job.notice.workspaceId = workspace.id; job.notice.title = workspace.name ?? null; }
      if (this.settings().enabled) await engine.tick();
    };
    const baseline = await paseo.workspaces.list({ subscribe: {} });
    if (baseline.subscription) { const owned = baseline.subscription; attempt.add(() => { void owned.release().catch(() => {}); }); }
    attempt.check();
    for (const w of baseline.entries) workspaces.set(w.id, { id: w.id, name: w.name, labels: w.labels, path: await pathOf(w.workspaceDirectory || w.projectRootPath) });
    const stopWorkspaces = baseline.subscription?.subscribe({
      snapshot: ({ entries }) => {
        void (async () => {
          workspaces.clear();
          for (const w of entries) workspaces.set(w.id, { id: w.id, name: w.name, labels: w.labels, path: await pathOf(w.workspaceDirectory || w.projectRootPath) });
        })().catch(() => this.log('工作区快照处理失败'));
      },
      update: message => {
        if (message.type !== 'workspace_update') return;
        const update = message.payload;
        if (update.kind === 'remove') { workspaces.delete(update.id); return; }
        run(async () => {
          const w = update.workspace;
          const known = workspaces.has(w.id);
          const path = await pathOf(w.workspaceDirectory || w.projectRootPath);
          const duplicates = duplicateWorkspaceIds(workspaces, w.id, path);
          workspaces.set(w.id, { id: w.id, name: w.name, labels: w.labels, path });
          if (!known) await announce(w, path, duplicates);
        });
      },
    });
    if (stopWorkspaces) attempt.add(stopWorkspaces);
    // 创建钩子覆盖创建瞬间；订阅用于补漏。相同工作区共用去重键。
    attempt.add(this.options.server.addHook('workspace.create.after', async e => {
      await engine.serial(async () => {
        await refreshRoles();
        const w = e.workspace;
        const path = await pathOf(w.cwd);
        await announce(w, path, duplicateWorkspaceIds(workspaces, w.id, path));
      });
    }));
    const projects = await paseo.projects.list();
    attempt.check();
    const known = new Set(projects.projects.map(p => p.projectId));
    attempt.add(paseo.projects.subscribe(update => {
      if (update.kind !== 'upsert' || known.has(update.project.projectId)) return;
      known.add(update.project.projectId);
      run(async () => {
        await engine.enqueue('new_project', '', update.project, `project:${update.project.projectId}`);
        const job = engine.state.outbox.find(item => item.notice.key === `project:${update.project.projectId}`);
        if (job) job.notice.title = update.project.projectDisplayName;
        if (this.settings().enabled) await engine.tick();
      });
    }));
  }

  private quotaCredentials() {
    return this.options.quotaCredentials ? this.options.quotaCredentials() : quotaWebhookCredentials(process.env, quotaWebhookConfigPath(), quotaWebhookFileDir(process.env, this.options.section.quotaAlerts.fileDirectory));
  }

  /** 额度报警开了但没有凭据时的警告，页面显示；60 秒内只查一次。 */
  private quotaWarning: { at: number; value: string | null } | null = null;
  private async quotaCredentialWarning(): Promise<string | null> {
    if (!this.options.section.quotaAlerts.enabled) return null;
    if (this.quotaWarning && Date.now() - this.quotaWarning.at < WEBHOOK_CACHE_MS) return this.quotaWarning.value;
    let value: string | null = null;
    try {
      if (!(await this.quotaCredentials())) value = '额度报警已开启，但没有找到凭据：报警只记录、不会发送。在 machine.json 的 escalation.quotaAlerts.fileDirectory 写凭据目录，或设置 QUOTA_WEBHOOK_URL 和 QUOTA_WEBHOOK_KEY。';
    } catch (error) { value = `额度报警凭据无法读取：${summarizeError(error)}`; }
    if (value && this.quotaWarning?.value !== value) this.log(value);
    this.quotaWarning = { at: Date.now(), value };
    return value;
  }

  private schedule() {
    const { timezone, immediate, delayMinutes } = this.settings();
    return { timezone, immediate, delayMinutes };
  }

  async stop() {
    this.stopped = true;
    this.lifetime.abort();
    this.attempt?.cancel();
  }

  markFailed(error: unknown) {
    this.health = 'failed';
    this.error = summarizeError(error);
  }

  async configure(patch: { enabled?: boolean; timezone?: string; immediate?: RuntimeSettings['immediate']; delayMinutes?: number }) {
    const before = this.settings();
    // 时段规则合并后整体校验，不合法就整个拒绝。
    EscalationScheduleSchema.parse({ timezone: patch.timezone ?? before.timezone, immediate: patch.immediate ?? before.immediate, delayMinutes: patch.delayMinutes ?? before.delayMinutes });
    this.options.settings.update(patch);
    return this.snapshot();
  }

  private async webhookStatus(force = false): Promise<EscalationSnapshot['webhook']> {
    if (!force && this.webhookCache && Date.now() - this.webhookCache.at < WEBHOOK_CACHE_MS) return this.webhookCache.value;
    let value: EscalationSnapshot['webhook'];
    try {
      const { hostname, fingerprint } = credentialFingerprint(await this.credentials());
      value = { configured: true, hostname, fingerprint };
    } catch { value = { configured: false, hostname: null, fingerprint: null }; }
    this.webhookCache = { at: Date.now(), value };
    return value;
  }

  async configureWebhook(input: { url: string; auth?: string }) {
    const { section } = this.options;
    const auth = input.auth ?? (await webhookCredentials(section.webhook).then(item => item.auth, () => { throw new Error('没有已保存的鉴权头，请同时填写鉴权头'); }));
    await storeWebhookCredentials(section.webhook, { url: input.url, auth });
    this.webhookCache = null;
    return this.webhookStatus(true);
  }

  async testWebhook(): Promise<{ sent: boolean; message: string }> {
    if (this.options.blocked) return { sent: false, message: this.options.blocked };
    const notice = {
      id: randomUUID(), key: `test:${randomUUID()}`, event: 'test', agentId: '', hostId: this.options.machineName, machine: this.options.machineName,
      workspaceId: null, title: '测试通知', provider: null, permissionId: null, firstSeenAt: new Date().toISOString(), answeredBy: null,
      provenance: 'not_applicable', questionSummary: { text: '', questions: [], options: [], recommended: [] }, needsUser: false, wake: 'none',
      coalesceWindowSeconds: 60, at: Date.now(), data: { test: true },
    } as Notice;
    try {
      await postNotice(notice, await this.credentials(), this.lifetime.signal);
      return { sent: true, message: '测试通知已发送，结果未确认' };
    } catch (error) { return { sent: false, message: `测试通知发送失败：${summarizeError(error)}` }; }
  }

  acknowledge(id: string) { return this.records.acknowledge(id); }

  async snapshot(): Promise<EscalationSnapshot> {
    const settings = this.settings();
    const blocked = this.options.blocked ?? null;
    const failed = this.health === 'failed' || blocked !== null;
    return {
      enabled: settings.enabled,
      status: failed ? 'error' : settings.enabled ? 'running' : 'stopped',
      error: this.error ?? blocked ?? this.options.settings.error() ?? this.rolesError ?? await this.quotaCredentialWarning(),
      blockedReason: blocked,
      timezone: settings.timezone,
      immediate: settings.immediate,
      delayMinutes: settings.delayMinutes,
      webhook: await this.webhookStatus(),
      pendingEvents: this.records.pending().map(item => ({ id: item.id, agentId: item.agentId, sessionTitle: item.sessionTitle, workspaceId: item.workspaceId, questionText: item.questionText, notifiedAt: item.at, delivery: item.delivery })),
      recentDeliveries: this.records.recent().map(item => ({ id: item.id, agentId: item.agentId, sessionTitle: item.sessionTitle, summary: item.summary, at: item.at, delivery: item.delivery, status: item.status })),
      recentClosures: this.records.closures().map(item => ({ id: item.id, agentId: item.agentId, sessionTitle: item.sessionTitle, summary: item.summary, at: item.closedAt!, reason: CLOSED_REASON_TEXT[item.closedReason!] ?? '来源已不再等待' })),
    };
  }
}
