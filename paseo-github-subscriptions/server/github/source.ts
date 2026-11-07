import { z } from 'zod';
import type { GithubEvent, Preferences, RepositoryStatus, Subscription } from '../../shared/model.ts';
import { readCiSnapshot, parseRuns } from './ci.ts';
import { loadCatalog } from './catalog.ts';
import { GithubClient, GithubError, RepositoryCommands } from './client.ts';
import { POLL_HORIZON_MS, RepositoryPoller, iso } from './repository.ts';
import { emptyRepositoryState, emptyState, loadState, type SourceState } from './state.ts';
import { readGithub } from '../vendor/dsh-superagent/github-read.ts';
import { ciCounts, ciSummary } from '../vendor/dsh-superagent/github-read.ts';

export interface GithubSourceOptions {
  getToken: () => Promise<string | null>;
  state?: unknown;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PollResult { events: GithubEvent[]; repositories: RepositoryStatus[] }
export type ReadResource = 'issue' | 'comments' | 'reviews' | 'actions' | 'checks';

const QUOTA_STEPS: Array<{ below: number; intervalMs: number }> = [
  { below: 100, intervalMs: Infinity },
  { below: 500, intervalMs: 300_000 },
  { below: 1500, intervalMs: 120_000 },
];
const NEW_REPOSITORY_LOOKBACK_MS = 3_600_000;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const RateLimitSchema = z.looseObject({
  resources: z.looseObject({ core: z.looseObject({ remaining: z.number(), limit: z.number(), reset: z.number() }) }),
});
const ThreadSchema = z.looseObject({ title: z.string(), state: z.string(), pull_request: z.unknown().optional() });
const HeadSchema = z.looseObject({ head: z.looseObject({ sha: z.string() }) });
const DefaultBranchSchema = z.looseObject({ default_branch: z.string() });
const CommitSchema = z.looseObject({ sha: z.string() });

export class GithubSource {
  private state: SourceState;
  private readonly getToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private statuses: RepositoryStatus[] = [];
  private pausedUntil = 0;
  private lastRoundAt = 0;
  private remaining: number | null = null;
  private resetAt: number | null = null;

  constructor(options: GithubSourceOptions) {
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.state = options.state === undefined ? emptyState() : loadState(options.state);
  }

  serialize(): unknown {
    return structuredClone(this.state);
  }

  private async client(): Promise<GithubClient> {
    const token = await this.getToken();
    if (!token) throw new Error('未配置 GitHub 令牌');
    const client = new GithubClient({ token, fetch: this.fetchImpl, now: this.now });
    client.pausedUntil = this.pausedUntil;
    return client;
  }

  private keep(client: GithubClient): void {
    this.pausedUntil = Math.max(this.pausedUntil, client.pausedUntil);
    if (client.rate.remaining !== null) this.remaining = client.rate.remaining;
    if (client.rate.resetAt !== null) this.resetAt = client.rate.resetAt;
  }

  private status(repo: string, error: string | null, polled: boolean): RepositoryStatus {
    const previous = this.statuses.find(item => item.repo === repo);
    return {
      repo, lastPollAt: polled ? iso(this.now()) : previous?.lastPollAt ?? null, error, remaining: this.remaining,
      resetAt: this.resetAt === null ? null : iso(this.resetAt),
    };
  }

  private async quotaInterval(client: GithubClient, signal?: AbortSignal): Promise<number> {
    try {
      const limits = await client.get(RateLimitSchema, 'rate_limit', signal);
      client.rate.remaining = limits.resources.core.remaining;
      client.rate.limit = limits.resources.core.limit;
      client.rate.resetAt = limits.resources.core.reset * 1000;
    } catch (error) {
      if (signal?.aborted || (error instanceof GithubError && error.status === 401)) throw error;
      return 0;
    }
    const remaining = client.rate.remaining ?? Infinity;
    const step = QUOTA_STEPS.find(item => remaining < item.below);
    if (!step) return 0;
    if (step.intervalMs === Infinity) client.pausedUntil = Math.max(client.pausedUntil, client.rate.resetAt ?? this.now());
    return step.intervalMs;
  }

  async poll(preferences: Preferences, subscriptions: Subscription[], signal?: AbortSignal): Promise<PollResult> {
    const client = await this.client();
    const started = this.now();
    const events: GithubEvent[] = [];
    if (client.pausedUntil > started) {
      return { events, repositories: this.limited(client.pausedUntil) };
    }
    const interval = await this.quotaInterval(client, signal);
    this.keep(client);
    if (client.pausedUntil > started) return { events, repositories: this.limited(client.pausedUntil) };
    if (interval > 0 && started - this.lastRoundAt < interval) {
      return { events, repositories: this.statuses.map(item => ({ ...item, remaining: this.remaining, resetAt: this.resetAt === null ? null : iso(this.resetAt) })) };
    }
    this.lastRoundAt = started;
    let catalog: Awaited<ReturnType<typeof loadCatalog>>;
    try {
      catalog = await loadCatalog(client, preferences, this.state.directory, started, signal);
    } catch (error) {
      this.keep(client);
      if (error instanceof GithubError && error.rateLimited) return { events, repositories: this.limited(error.retryAt ?? this.pausedUntil) };
      if (error instanceof GithubError) throw new Error(client.scrub(error.message));
      throw error;
    }
    this.state.directory = catalog.directory;
    const known = new Set(Object.keys(this.state.repos));
    const names = new Set(catalog.repositories.map(entry => entry.name));
    for (const name of known) if (!names.has(name)) delete this.state.repos[name];
    const lookback = Math.max(catalog.previousFetchedAt ?? started, started - NEW_REPOSITORY_LOOKBACK_MS);
    const statuses: RepositoryStatus[] = [];
    if (catalog.error) statuses.push(this.status(preferences.organization, catalog.error, true));
    let halted = false;
    for (const entry of catalog.repositories) {
      if (halted) {
        statuses.push(this.status(entry.name, this.statuses.find(item => item.repo === entry.name)?.error ?? null, false));
        continue;
      }
      const state = this.state.repos[entry.name] ?? emptyRepositoryState(iso(known.size ? lookback : started));
      this.state.repos[entry.name] = state;
      const poller = new RepositoryPoller({
        client, entry, state, subscriptions, now: this.now, signal,
        emit: event => {
          if (this.state.seen[event.id] !== undefined) return;
          this.state.seen[event.id] = started;
          events.push(event);
        },
      });
      try {
        const errors = await poller.run();
        this.keep(client);
        statuses.push(this.status(entry.name, errors.length ? errors.slice(0, 3).join('；') : null, true));
      } catch (error) {
        this.keep(client);
        if (signal?.aborted) throw error;
        if (error instanceof GithubError && error.status === 401) throw new Error(client.scrub(error.message));
        const message = error instanceof GithubError ? client.scrub(error.message) : '读取失败';
        statuses.push(this.status(entry.name, message, true));
        if (error instanceof GithubError && error.rateLimited) halted = true;
      }
    }
    this.prune(started);
    this.statuses = statuses;
    return { events, repositories: statuses };
  }

  private limited(until: number): RepositoryStatus[] {
    const message = `GitHub 限流，约 ${iso(until)} 后恢复`;
    const names = Object.keys(this.state.repos);
    const base = this.statuses.length ? this.statuses.map(item => item.repo) : names;
    return base.map(repo => ({ ...this.status(repo, message, false), resetAt: iso(until) }));
  }

  private prune(now: number): void {
    const cutoff = now - POLL_HORIZON_MS;
    for (const [id, at] of Object.entries(this.state.seen)) if (at < cutoff) delete this.state.seen[id];
    for (const repository of Object.values(this.state.repos)) {
      for (const [number, thread] of Object.entries(repository.threads)) {
        if (Date.parse(thread.updatedAt) < cutoff) delete repository.threads[number];
      }
    }
  }

  async readThread(target: { owner: string; repo: string; number: number }): Promise<{ title: string; isPr: boolean; closed: boolean }> {
    const client = await this.client();
    try {
      const thread = await client.get(ThreadSchema, `repos/${target.owner}/${target.repo}/issues/${target.number}`);
      return { title: thread.title, isPr: !!thread.pull_request, closed: thread.state === 'closed' };
    } catch (error) {
      if (error instanceof GithubError && (error.status === 404 || error.status === 410)) {
        throw new Error('编号不存在、已删除，或令牌无权访问');
      }
      throw error;
    } finally {
      this.keep(client);
    }
  }

  async readResource(repo: string, number: number | null, resource: ReadResource, page = 1): Promise<unknown> {
    if (!REPOSITORY_PATTERN.test(repo)) throw new Error('仓库格式应为 owner/repo');
    const client = await this.client();
    try {
      const commands = new RepositoryCommands(client, repo);
      const need = (): number => {
        if (number === null) throw new Error('需要 Issue 或 PR 编号');
        return number;
      };
      if (resource === 'issue') {
        const thread = await client.get(ThreadSchema, `repos/${repo}/issues/${need()}`);
        return readGithub(commands, `github/${thread.pull_request ? 'pulls' : 'issues'}/${number}`);
      }
      if (resource === 'comments') return readGithub(commands, `github/issues/${need()}/comments/${page}`);
      if (resource === 'reviews') return readGithub(commands, `github/pulls/${need()}/reviews/${page}`);
      if (resource === 'actions') {
        const head = number === null ? null : (await client.get(HeadSchema, `repos/${repo}/pulls/${number}`)).head.sha;
        const response = await client.request(`repos/${repo}/actions/runs?per_page=20${head ? `&head_sha=${head}` : ''}`);
        return {
          runs: parseRuns(response.json()).map(run => ({
            id: run.id, name: run.name ?? null, status: run.status ?? null, conclusion: run.conclusion ?? null, branch: run.head_branch ?? null,
            sha: run.head_sha ?? null, updatedAt: run.updated_at ?? null,
            url: (run as { html_url?: unknown }).html_url ?? null,
          })),
        };
      }
      const head = number === null
        ? (await client.get(CommitSchema, `repos/${repo}/commits/${encodeURIComponent((await client.get(DefaultBranchSchema, `repos/${repo}`)).default_branch)}`)).sha
        : (await client.get(HeadSchema, `repos/${repo}/pulls/${number}`)).head.sha;
      const snapshot = await readCiSnapshot(client, repo, head);
      return { ...snapshot, ...ciCounts(snapshot), summary: ciSummary(snapshot, number === null ? '默认分支' : `PR #${number}`, `commits/${head}/checks`) };
    } finally {
      this.keep(client);
    }
  }
}
