import { createHash } from 'node:crypto';
import { PreferencesSchema, type Preferences, type Subscription } from '../shared/model.ts';

export interface Call { path: string; search: string; headers: Record<string, string> }
export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }

type Item = Record<string, unknown>;

export interface World {
  organization: Item[];
  repositories: Record<string, Item>;
  issues: Record<string, Item[]>;
  comments: Record<string, Item[]>;
  reviewComments: Record<string, Item[]>;
  runs: Record<string, Item[]>;
  jobs: Record<string, Item[]>;
  pulls: Record<string, Item>;
  reviews: Record<string, Item[]>;
  statuses: Record<string, Item[]>;
  commits: Record<string, string>;
  failures: Record<string, Reply[]>;
  rateRemaining: number;
  honorSince: boolean;
  pageSize: number;
}

export const newWorld = (): World => ({
  organization: [], repositories: {}, issues: {}, comments: {}, reviewComments: {}, runs: {}, jobs: {}, pulls: {}, reviews: {},
  statuses: {}, commits: {}, failures: {}, rateRemaining: 5000, honorSince: true, pageSize: 100,
});

export const repository = (name: string, defaultBranch = 'main'): Item => ({
  full_name: `org/${name}`, name, default_branch: defaultBranch, archived: false, disabled: false,
});

const etagOf = (value: unknown): string => `"${createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12)}"`;

export interface Fixture { fetch: typeof fetch; calls: Call[]; world: World; count(pattern: RegExp): number }

export function createFixture(world: World = newWorld()): Fixture {
  const calls: Call[] = [];
  const respond = (reply: Reply): Response => {
    const status = reply.status ?? 200;
    const body = status === 304 || status === 204 ? null : JSON.stringify(reply.body ?? {});
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': String(world.rateRemaining), ...reply.headers } });
  };
  const list = (url: URL, request: Record<string, string>, items: Item[], field = 'updated_at', wrap?: string): Reply => {
    const since = url.searchParams.get('since');
    const visible = world.honorSince && since ? items.filter(item => String(item[field] ?? '') >= since) : items;
    const ordered = [...visible].sort((left, right) => String(left[field] ?? '').localeCompare(String(right[field] ?? '')));
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = ordered.slice((page - 1) * world.pageSize, page * world.pageSize);
    const nextUrl = new URL(url);
    nextUrl.searchParams.set('page', String(page + 1));
    const next: Record<string, string> = page * world.pageSize < ordered.length ? { link: `<https://api.github.com${nextUrl.pathname}${nextUrl.search}>; rel="next"` } : {};
    const tag = etagOf(ordered);
    if (page === 1 && request['if-none-match'] === tag) return { status: 304, headers: { etag: tag } };
    return { body: wrap ? { [wrap]: slice, total_count: ordered.length } : slice, headers: { etag: tag, ...next } };
  };
  const route = (url: URL, request: Record<string, string>): Reply | undefined => {
    const path = url.pathname;
    if (path === '/rate_limit') return { body: { resources: { core: { remaining: world.rateRemaining, limit: 5000, reset: 2_000_000_000 } } } };
    if (path === '/orgs/org/repos') return list(url, request, world.organization, 'name');
    let match = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
    if (match) return world.repositories[match[1]!] ? { body: world.repositories[match[1]!] } : undefined;
    match = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
    if (match) return list(url, request, world.issues[match[1]!] ?? []);
    match = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(path);
    if (match) return list(url, request, world.comments[match[1]!] ?? []);
    match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/comments$/.exec(path);
    if (match) return list(url, request, world.reviewComments[match[1]!] ?? []);
    match = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/.exec(path);
    if (match) {
      const head = url.searchParams.get('head_sha');
      const runs = (world.runs[match[1]!] ?? []).filter(run => !head || run.head_sha === head);
      return list(url, request, runs, 'updated_at', 'workflow_runs');
    }
    match = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (match) return { body: { jobs: world.jobs[`${match[1]}#${match[2]}`] ?? [] } };
    match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (match) return world.pulls[`${match[1]}#${match[2]}`] ? { body: world.pulls[`${match[1]}#${match[2]}`] } : undefined;
    match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(path);
    if (match) return list(url, request, world.reviews[`${match[1]}#${match[2]}`] ?? [], 'submitted_at');
    match = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/status$/.exec(path);
    if (match) return { body: { statuses: world.statuses[`${match[1]}@${match[2]}`] ?? [] } };
    match = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/.exec(path);
    if (match) return world.commits[`${match[1]}@${decodeURIComponent(match[2]!)}`] ? { body: { sha: world.commits[`${match[1]}@${decodeURIComponent(match[2]!)}`] } } : undefined;
    match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path);
    if (match) {
      const found = (world.issues[match[1]!] ?? []).find(item => String(item.number) === match![2]);
      return found ? { body: found } : { status: 404, body: { message: 'Not Found' } };
    }
    return undefined;
  };
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const request: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { request[name.toLowerCase()] = value; });
    calls.push({ path: url.pathname, search: url.search, headers: request });
    const queued = world.failures[url.pathname]?.shift();
    if (queued) return respond(queued);
    return respond(route(url, request) ?? { status: 404, body: { message: 'Not Found' } });
  };
  return {
    fetch: impl as typeof fetch, calls, world, count: pattern => calls.filter(call => pattern.test(call.path)).length,
  };
}

export const preferences = (overrides: Partial<Preferences> = {}): Preferences =>
  PreferencesSchema.parse({ organization: 'org', excludedRepos: ['rea'], ...overrides });

export function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', agentId: 'agent-1', workspaceId: null, agentTitle: null, parentAgentId: null, key: 'org/app#7', scope: 'thread',
    owner: 'org', repo: 'app', number: 7, isPr: true, title: null, events: ['comment', 'review', 'push', 'ci', 'state'], note: null,
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', expiresAt: null, lastEventAt: null, lastEventId: null,
    delivered: 0, lastDelivery: null, ...overrides,
  };
}

export const issueItem = (number: number, overrides: Item = {}): Item => ({
  id: 1000 + number, number, title: `Issue ${number}`, state: 'open', body: 'body', user: { login: 'alice', type: 'User' }, created_at: '2026-11-06T00:00:10.000Z',
  updated_at: '2026-11-06T00:00:10.000Z', html_url: `https://github.com/org/app/issues/${number}`, ...overrides,
});

export const commentItem = (id: number, issue: number, overrides: Item = {}): Item => ({
  id, body: `comment ${id}`, user: { login: 'alice', type: 'User' }, created_at: '2026-11-06T00:00:20.000Z', updated_at: '2026-11-06T00:00:20.000Z',
  html_url: `https://github.com/org/app/issues/${issue}#issuecomment-${id}`, issue_url: `https://api.github.com/repos/org/app/issues/${issue}`, ...overrides,
});
