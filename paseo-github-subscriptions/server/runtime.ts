import { createHash } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import type { AgentToolContext } from '@getpaseo/plugin/server';
import { PreferencesSchema, type EventType, type Preferences, type RepositoryStatus, type Snapshot } from '../shared/model.ts';
import { parseTarget } from '../shared/target.ts';
import { acceptBatch, Dispatcher } from './delivery.ts';
import { GithubSource, type ReadResource } from './github/source.ts';
import { Storage } from './storage.ts';
import { TokenVault } from './token.ts';

export class Runtime {
  readonly storage: Storage;
  readonly vault: TokenVault;
  private source!: GithubSource;
  private dispatcher: Dispatcher;
  private controller = new AbortController();
  private interval: ReturnType<typeof setInterval> | null = null;
  private cycle: Promise<void> | null = null;
  private repositories: RepositoryStatus[] = [];
  private error: string | null = null;
  private lastPollAt: string | null = null;
  private toolInjection = false;
  private paseo: PaseoApi;

  constructor(directory: string, paseo: PaseoApi) {
    this.paseo = paseo;
    this.storage = new Storage(directory);
    this.vault = new TokenVault(directory);
    this.dispatcher = new Dispatcher(this.storage, paseo, error => this.vault.redact(error));
  }

  async start() {
    await this.storage.load();
    await this.vault.load();
    this.source = new GithubSource({ getToken: this.vault.read, state: this.storage.state.source });
    await this.refreshConfig();
    this.interval = setInterval(() => { void this.poll(); }, 60_000);
    this.interval.unref();
    void this.poll();
  }

  private async refreshConfig() {
    try { this.toolInjection = (await this.paseo.config.get()).config.mcp.injectIntoAgents; }
    catch { this.toolInjection = false; }
  }

  snapshot(): Snapshot {
    return {
      preferences: this.storage.state.preferences, subscriptions: this.storage.state.subscriptions,
      events: this.storage.state.events, deliveries: this.storage.state.deliveries.slice(-500).map(({ text: _text, events: _events, attempts: _attempts, retryAt: _retryAt, ...delivery }) => delivery),
      repositories: this.repositories, token: this.vault.status, polling: !!this.cycle,
      lastPollAt: this.lastPollAt, toolInjection: this.toolInjection, error: this.error, intervalSeconds: 60,
    };
  }

  poll() {
    if (this.cycle) return this.cycle;
    if (this.controller.signal.aborted || !this.storage.state.preferences.enabled || !this.vault.status.configured) return Promise.resolve();
    this.cycle = (async () => {
      try {
        await this.dispatcher.flush();
        const result = await this.source.poll(this.storage.state.preferences, this.storage.state.subscriptions, this.controller.signal);
        if (this.controller.signal.aborted) return;
        await acceptBatch(this.storage, result.events, this.source.serialize());
        this.repositories = result.repositories;
        this.lastPollAt = new Date().toISOString();
        this.error = null;
        const rate = result.repositories.find(repository => repository.remaining !== null);
        if (rate) this.vault.status = { ...this.vault.status, remaining: rate.remaining, resetAt: rate.resetAt };
        await this.dispatcher.flush();
        await this.storage.prune();
        await this.refreshConfig();
      } catch (error) {
        this.error = this.vault.redact(error);
        if (/GitHub 401/.test(this.error)) this.vault.status = { ...this.vault.status, error: 'GitHub 令牌已失效，请重新保存令牌' };
        this.source = new GithubSource({ getToken: this.vault.read, state: this.storage.state.source });
      } finally { this.cycle = null; }
    })();
    return this.cycle;
  }

  async preferences(value: Preferences) {
    const parsed = PreferencesSchema.parse(value);
    await this.storage.mutate(state => {
      if (parsed.shadow) for (const delivery of state.deliveries) if (delivery.status === 'pending') delivery.status = 'shadow';
      state.preferences = parsed;
    });
    return parsed;
  }

  async subscribe(targetValue: string, events: EventType[] | undefined, note: string | undefined, context: AgentToolContext) {
    const target = parseTarget(targetValue);
    const agent = context.agent;
    const preferences = this.storage.state.preferences;
    const repository = `${target.owner}/${target.repo}`;
    const excluded = preferences.excludedRepos.some(value => value.toLowerCase() === target.repo || value.toLowerCase() === repository);
    const extra = preferences.extraRepos.some(value => value.toLowerCase() === repository);
    if (!extra && (target.owner !== preferences.organization.toLowerCase() || excluded)) throw new Error('仓库未纳入监听。请在插件设置页调整排除仓库或额外仓库。');
    const detail = target.number ? await this.source.readThread({ ...target, number: target.number }) : null;
    const now = new Date().toISOString();
    const selected = events?.length ? events : target.number ? ['opened', 'comment', 'review', 'review_comment', 'push', 'ci', 'state'] as EventType[] : ['opened', 'state', 'ci'] as EventType[];
    if (target.scope === 'repo' && selected.some(type => type === 'push' || type === 'review')) throw new Error('新提交和评审事件需要指定 PR，例如 owner/repo#123。整仓库 CI 仅监听默认分支。');
    return this.storage.mutate(state => {
      const existing = state.subscriptions.find(subscription => subscription.agentId === agent.id && subscription.key === target.key);
      if (existing) {
        existing.events = [...new Set([...existing.events, ...selected])];
        existing.updatedAt = now;
        existing.expiresAt = detail?.closed ? new Date(Date.now() + 3 * 86400_000).toISOString() : null;
        if (note !== undefined) existing.note = note;
        return existing;
      }
      const owned = state.subscriptions.filter(subscription => subscription.agentId === agent.id && subscription.scope === target.scope);
      const limit = target.scope === 'thread' ? 50 : 5;
      if (owned.length >= limit) throw new Error(`当前会话的${target.scope === 'thread' ? 'Issue/PR' : '整仓库'}订阅已达到 ${limit} 条，请先取消其他订阅`);
      if (state.subscriptions.length >= 1000) throw new Error('本机订阅已达到 1000 条，请先取消其他订阅');
      const subscription = {
        ...target, id: `sub_${createHash('sha256').update(`${agent.id}:${target.key}`).digest('hex').slice(0, 20)}`,
        agentId: agent.id, workspaceId: agent.workspaceId, agentTitle: agent.title,
        parentAgentId: agent.parentAgentId, isPr: detail?.isPr ?? null, title: detail?.title ?? null,
        events: selected, note: note ?? null, createdAt: now, updatedAt: now,
        expiresAt: detail?.closed ? new Date(Date.now() + 3 * 86400_000).toISOString() : null,
        lastEventAt: null, lastEventId: null, delivered: 0, lastDelivery: null,
      };
      state.subscriptions.push(subscription);
      return subscription;
    });
  }

  async remove(id: string, agentId?: string) {
    return this.storage.mutate(state => {
      const before = state.subscriptions.length;
      state.subscriptions = state.subscriptions.filter(subscription => !(subscription.id === id && (!agentId || subscription.agentId === agentId)));
      return { removed: before !== state.subscriptions.length };
    });
  }

  async archive(agentId: string) {
    await this.storage.mutate(state => { state.subscriptions = state.subscriptions.filter(subscription => subscription.agentId !== agentId); });
  }

  async read(targetValue: string, resource: ReadResource, page = 1) {
    const target = parseTarget(targetValue);
    return this.source.readResource(`${target.owner}/${target.repo}`, target.number, resource, page);
  }

  async stop() {
    this.controller.abort();
    if (this.interval) clearInterval(this.interval);
    await this.cycle;
  }
}
