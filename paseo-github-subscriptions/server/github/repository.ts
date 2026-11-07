import { z } from 'zod';
import type { GithubEvent, Subscription } from '../../shared/model.ts';
import { CommentSchema, IssueSchema, UserSchema, githubPage } from '../vendor/dsh-superagent/github-trigger.ts';
import { advanceCi, parseRuns, readCiSnapshot, runSignature } from './ci.ts';
import { GithubClient, GithubError } from './client.ts';
import {
  ListedCommentSchema, ciEvent, commentEvent, openedEvent, pushEvent, stateEvent, type StateKind,
} from './events.ts';
import type { CatalogEntry, PullSnapshot, RepositoryState } from './state.ts';

export const POLL_HORIZON_MS = 14 * 24 * 3600_000;
const HOUR_MS = 3_600_000;
const CURSOR_OVERLAP_MS = 5000;
const MAX_REVIEW_IDS = 200;
export const PULL_RECONCILE_MS = 5 * 60_000;
export const CI_RECONCILE_MS = 10 * 60_000;

const IssueListSchema = IssueSchema.extend({
  closed_at: z.string().nullish(),
  closed_by: z.looseObject({ login: z.string() }).nullish(),
  pull_request: z.looseObject({ url: z.string(), merged_at: z.string().nullish() }).nullish(),
});
const PullSchema = z.looseObject({
  title: z.string(), state: z.string(), html_url: z.string(), user: UserSchema, updated_at: z.string().nullish(),
  head: z.looseObject({ sha: z.string() }),
});
const CommitSchema = z.looseObject({ sha: z.string() });

export const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
export const cursorAt = (value: string): string => iso(Date.parse(value) - CURSOR_OVERLAP_MS);

export interface PullWants { push: boolean; review: boolean; ci: boolean }

export function trackedPulls(repository: string, subscriptions: Subscription[]): Map<number, PullWants> {
  const tracked = new Map<number, PullWants>();
  for (const subscription of subscriptions) {
    if (subscription.scope !== 'thread' || subscription.number === null || subscription.isPr === false) continue;
    if (`${subscription.owner}/${subscription.repo}`.toLowerCase() !== repository.toLowerCase()) continue;
    const wants = tracked.get(subscription.number) ?? { push: false, review: false, ci: false };
    tracked.set(subscription.number, {
      push: wants.push || subscription.events.includes('push'),
      review: wants.review || subscription.events.includes('review'),
      ci: wants.ci || subscription.events.includes('ci'),
    });
  }
  for (const [number, wants] of tracked) if (!wants.push && !wants.review && !wants.ci) tracked.delete(number);
  return tracked;
}

export function wantsBranchCi(repository: string, subscriptions: Subscription[]): boolean {
  return subscriptions.some(subscription => subscription.scope === 'repo' && subscription.events.includes('ci')
    && `${subscription.owner}/${subscription.repo}`.toLowerCase() === repository.toLowerCase());
}

export interface RepositoryContext {
  client: GithubClient;
  entry: CatalogEntry;
  state: RepositoryState;
  subscriptions: Subscription[];
  now: () => number;
  emit: (event: GithubEvent) => void;
  signal?: AbortSignal | undefined;
}

const emptyPull = (head: string, title: string, closed: boolean, at: number): PullSnapshot => ({
  head, title, closed, reviews: null, ci: null, pullDirty: false, reviewsDirty: false, ciDirty: false, reconciledAt: at, ciReconciledAt: at,
});

export function closedThreads(repository: string, subscriptions: Subscription[]): Set<number> {
  const closed = new Set<number>();
  for (const subscription of subscriptions) {
    if (subscription.scope !== 'thread' || subscription.number === null || !subscription.expiresAt) continue;
    if (`${subscription.owner}/${subscription.repo}`.toLowerCase() === repository.toLowerCase()) closed.add(subscription.number);
  }
  return closed;
}

export class RepositoryPoller {
  private readonly context: RepositoryContext;
  private readonly repo: string;
  private readonly errors: string[] = [];

  constructor(context: RepositoryContext) {
    this.context = context;
    this.repo = context.entry.name;
  }

  async run(): Promise<string[]> {
    await this.guard('Issue 与 PR', () => this.pollIssues());
    await this.guard('对话评论', () => this.pollComments('comments', 'issues/comments?', 'conversation'));
    await this.guard('代码评论', () => this.pollComments('reviewComments', 'pulls/comments?', 'inline'));
    await this.guard('Actions 运行', () => this.pollRuns());
    await this.pollTracked();
    await this.guard('默认分支 CI', () => this.pollBranch());
    return this.errors;
  }

  private async guard(label: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (this.context.signal?.aborted) throw error;
      if (error instanceof GithubError && (error.rateLimited || error.status === 401)) throw error;
      this.errors.push(`${label}：${error instanceof GithubError ? error.message : '读取失败'}`);
    }
  }

  private get floor(): number {
    return Math.max(Date.parse(this.context.state.started), this.horizon);
  }

  private get horizon(): number {
    return Math.floor((this.context.now() - POLL_HORIZON_MS) / HOUR_MS) * HOUR_MS;
  }

  private async readStream(id: string, path: string): Promise<{ items: unknown[]; commit: () => void } | null> {
    const { client, state } = this.context;
    const stored = state.streams[id];
    const since = iso(Math.max(Date.parse(stored?.since ?? state.started), this.horizon));
    const conditional = stored?.etag && stored.since === since ? stored.etag : null;
    const listed = await client.list(
      `repos/${this.repo}/${path}${path.endsWith('?') ? '' : '&'}sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
      { etag: conditional, signal: this.context.signal },
    );
    if (listed.status === 304) return null;
    const newest = Math.max(...listed.items.map(item => Date.parse(String((item as { updated_at?: unknown }).updated_at ?? ''))).filter(Number.isFinite));
    const moved = Number.isFinite(newest) ? cursorAt(iso(newest)) : since;
    const next = Date.parse(moved) > Date.parse(since) ? moved : since;
    const etag = !listed.truncated && next === since ? listed.etag : null;
    return { items: listed.items, commit: () => { state.streams[id] = { since: next, etag }; } };
  }

  private async pollIssues(): Promise<void> {
    const { state, emit, now, subscriptions } = this.context;
    const closedHints = closedThreads(this.repo, subscriptions);
    const read = await this.readStream('issues', 'issues?state=all');
    if (!read) return;
    for (const item of read.items) {
      const parsed = IssueListSchema.safeParse(item);
      if (!parsed.success) continue;
      const issue = parsed.data;
      const isPr = !!issue.pull_request;
      const stateKind: StateKind = issue.pull_request?.merged_at ? 'merged' : issue.state === 'closed' ? 'closed' : 'open';
      const snapshot = state.threads[String(issue.number)];
      const createdFresh = Date.parse(issue.created_at) >= this.floor;
      if (createdFresh) emit(openedEvent(this.repo, issue, isPr));
      const closedAt = issue.pull_request?.merged_at ?? issue.closed_at;
      const previous = snapshot?.state ?? (createdFresh ? 'open' : closedHints.has(issue.number) ? 'closed' : null);
      const changed = previous === null
        ? stateKind !== 'open' && !!closedAt && Date.parse(closedAt) >= this.floor
        : previous !== stateKind;
      if (changed) {
        const subject = { repo: this.repo, number: issue.number, isPr, title: issue.title };
        emit(stateEvent(subject, stateKind, issue.updated_at ?? iso(now()), issue.closed_by?.login ?? ''));
      }
      state.threads[String(issue.number)] = { state: stateKind, title: issue.title, isPr, updatedAt: issue.updated_at ?? iso(now()) };
      const pull = state.pulls[String(issue.number)];
      if (pull) {
        pull.pullDirty = true;
        pull.reviewsDirty = true;
        pull.closed = stateKind !== 'open';
      }
    }
    read.commit();
  }

  private async pollComments(id: 'comments' | 'reviewComments', path: string, kind: 'conversation' | 'inline'): Promise<void> {
    const { state, emit } = this.context;
    const read = await this.readStream(id, path);
    if (!read) return;
    for (const item of read.items) {
      const parsed = ListedCommentSchema.safeParse(item);
      if (!parsed.success) continue;
      const comment = parsed.data;
      const address = kind === 'conversation' ? comment.issue_url : comment.pull_request_url;
      const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec(address ?? '')?.[1]);
      if (!number || Date.parse(comment.updated_at ?? comment.created_at ?? '') < this.floor) continue;
      const isPr = kind === 'inline' || /\/pull\//.test(comment.html_url ?? '');
      const title = state.threads[String(number)]?.title ?? null;
      const event = commentEvent({ repo: this.repo, number, isPr, title }, comment, kind);
      if (event) emit(event);
    }
    read.commit();
  }

  private async pollRuns(): Promise<void> {
    const { client, state } = this.context;
    const listed = await client.list(`repos/${this.repo}/actions/runs?per_page=100`, {
      etag: state.runs?.etag, signal: this.context.signal, maxPages: 1,
      pick: body => (body && typeof body === 'object' && Array.isArray((body as { workflow_runs?: unknown }).workflow_runs))
        ? (body as { workflow_runs: unknown[] }).workflow_runs : [],
    });
    if (listed.status === 304) return;
    const runs = parseRuns({ workflow_runs: listed.items });
    const previous = state.runs?.signatures;
    const signatures: Record<string, string> = {};
    for (const run of runs) {
      signatures[String(run.id)] = runSignature(run);
      if (!previous || previous[String(run.id)] === signatures[String(run.id)]) continue;
      for (const [number, pull] of Object.entries(state.pulls)) {
        if (run.pull_requests?.some(item => String(item.number) === number) || run.head_sha === pull.head) pull.ciDirty = true;
      }
      if (state.branch && run.head_branch === state.branch.name) state.branch.dirty = true;
    }
    state.runs = { etag: listed.etag, signatures };
  }

  private async pollTracked(): Promise<void> {
    const { state, subscriptions, now } = this.context;
    const tracked = trackedPulls(this.repo, subscriptions);
    for (const number of Object.keys(state.pulls)) if (!tracked.has(Number(number))) delete state.pulls[number];
    for (const [number, wants] of [...tracked].sort((left, right) => left[0] - right[0])) {
      const label = `PR #${number}`;
      if (!state.pulls[String(number)]) await this.guard(label, () => this.baselinePull(number));
      const snapshot = state.pulls[String(number)];
      if (!snapshot) continue;
      if (now() - snapshot.reconciledAt >= PULL_RECONCILE_MS) {
        snapshot.pullDirty = true;
        snapshot.reviewsDirty = true;
        snapshot.reconciledAt = now();
      }
      if (now() - snapshot.ciReconciledAt >= CI_RECONCILE_MS) {
        snapshot.ciDirty = true;
        snapshot.ciReconciledAt = now();
      }
      if (snapshot.pullDirty) await this.guard(`${label} 详情`, () => this.readPull(number));
      if (snapshot.closed) continue;
      if (wants.review && (snapshot.reviews === null || snapshot.reviewsDirty)) await this.guard(`${label} Review`, () => this.readReviews(number));
      if (wants.ci && (snapshot.ci === null || snapshot.ciDirty)) await this.guard(`${label} CI`, () => this.readPullCi(number));
    }
  }

  private async baselinePull(number: number): Promise<void> {
    const { client, state, signal, now } = this.context;
    const pull = await client.get(PullSchema, `repos/${this.repo}/pulls/${number}`, signal);
    state.pulls[String(number)] = emptyPull(pull.head.sha, pull.title, pull.state !== 'open', now());
    const thread = state.threads[String(number)];
    if (thread) thread.title = pull.title;
  }

  private async readPull(number: number): Promise<void> {
    const { client, state, emit, now, signal } = this.context;
    const pull = await client.get(PullSchema, `repos/${this.repo}/pulls/${number}`, signal);
    const snapshot = state.pulls[String(number)];
    if (!snapshot) return;
    if (snapshot.head !== pull.head.sha) {
      const subject = { repo: this.repo, number, isPr: true, title: pull.title };
      emit(pushEvent(subject, pull.head.sha, pull.user.login, pull.updated_at ?? iso(now())));
      snapshot.head = pull.head.sha;
      snapshot.ciDirty = true;
    }
    if (snapshot.closed && pull.state === 'open') {
      snapshot.reviewsDirty = true;
      snapshot.ciDirty = true;
    }
    snapshot.title = pull.title;
    snapshot.closed = pull.state !== 'open';
    snapshot.pullDirty = false;
  }

  private async readReviews(number: number): Promise<void> {
    const { client, state, emit, signal } = this.context;
    const listed = await client.list(`repos/${this.repo}/pulls/${number}/reviews?per_page=100`, { signal });
    const snapshot = state.pulls[String(number)];
    if (!snapshot) return;
    const known = new Set(snapshot.reviews ?? []);
    const submitted = listed.items.flatMap(item => {
      const parsed = CommentSchema.safeParse(item);
      return parsed.success && parsed.data.submitted_at ? [parsed.data] : [];
    });
    if (snapshot.reviews !== null) {
      for (const review of submitted.filter(item => !known.has(item.id)).sort((left, right) => (left.submitted_at ?? '').localeCompare(right.submitted_at ?? ''))) {
        const event = commentEvent({ repo: this.repo, number, isPr: true, title: snapshot.title }, review, 'review');
        if (event) emit(event);
      }
    }
    snapshot.reviews = [...new Set([...known, ...submitted.map(item => item.id)])].sort((left, right) => left - right).slice(-MAX_REVIEW_IDS);
    snapshot.reviewsDirty = false;
  }

  private async readPullCi(number: number): Promise<void> {
    const { client, state, emit, now, signal } = this.context;
    const snapshot = state.pulls[String(number)];
    if (!snapshot) return;
    const ci = await readCiSnapshot(client, this.repo, snapshot.head, signal);
    const next = advanceCi(snapshot.ci, ci, true, now());
    if (next.emit) {
      const pull = { number, title: snapshot.title, url: githubPage(this.repo, number, true), author: '' };
      emit(ciEvent({ repo: this.repo, snapshot: ci, emit: next.emit, revision: next.state.revision, epoch: next.state.epoch, at: iso(now()), pull }));
    }
    snapshot.ci = next.state;
    snapshot.ciDirty = false;
  }

  private async pollBranch(): Promise<void> {
    const { client, state, entry, subscriptions, emit, now, signal } = this.context;
    if (!wantsBranchCi(this.repo, subscriptions)) {
      state.branch = null;
      return;
    }
    if (!state.branch || state.branch.name !== entry.defaultBranch) {
      state.branch = { name: entry.defaultBranch, ci: null, dirty: false, reconciledAt: now() };
    }
    const branch = state.branch;
    if (now() - branch.reconciledAt >= CI_RECONCILE_MS) {
      branch.dirty = true;
      branch.reconciledAt = now();
    }
    if (branch.ci !== null && !branch.dirty) return;
    const commit = await client.get(CommitSchema, `repos/${this.repo}/commits/${encodeURIComponent(branch.name)}`, signal);
    const ci = await readCiSnapshot(client, this.repo, commit.sha, signal);
    const next = advanceCi(branch.ci, ci, false, now());
    if (next.emit) emit(ciEvent({ repo: this.repo, snapshot: ci, emit: next.emit, revision: next.state.revision, epoch: next.state.epoch, at: iso(now()), branch: branch.name }));
    branch.ci = next.state;
    branch.dirty = false;
  }
}
