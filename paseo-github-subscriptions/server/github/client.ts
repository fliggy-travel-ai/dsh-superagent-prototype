import { z } from 'zod';
import type { Commands, Tally } from '../vendor/dsh-superagent/shim.ts';
import { validItems } from '../vendor/dsh-superagent/shim.ts';

export const GITHUB_ORIGIN = 'https://api.github.com';
const SECONDARY_LIMIT_PAUSE_MS = 60_000;
const MAX_ERROR_TEXT = 200;
const Signals = AbortSignal as typeof AbortSignal & {
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};
const SAFE_PATH = /^[\w.~\-/?=&%,:+@]*$/;

export class GithubError extends Error {
  readonly status: number | null;
  readonly retryAt: number | null;
  constructor(message: string, status: number | null = null, retryAt: number | null = null) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.retryAt = retryAt;
  }
  get rateLimited(): boolean {
    return this.retryAt !== null;
  }
}

export interface RateState { remaining: number | null; limit: number | null; resetAt: number | null }

export interface GithubResponse {
  status: number;
  etag: string | null;
  next: string | null;
  text: string;
  json(): unknown;
}

export interface RequestOptions { etag?: string | null; accept?: string; signal?: AbortSignal | undefined }

export interface ListResult {
  status: number;
  etag: string | null;
  items: unknown[];
  truncated: boolean;
}

export interface ListOptions {
  etag?: string | null;
  maxPages?: number;
  signal?: AbortSignal | undefined;
  pick?: (body: unknown) => unknown[];
}

export interface ClientOptions {
  token: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 10;

function parseNext(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1] ?? null;
  }
  return null;
}

export class GithubClient {
  readonly rate: RateState = { remaining: null, limit: null, resetAt: null };
  pausedUntil = 0;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch;
    this.now = options.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  scrub(text: string): string {
    return this.token ? text.split(this.token).join('***') : text;
  }

  private target(location: string): URL {
    const absolute = /^https?:\/\//i.test(location);
    if (!absolute && (!SAFE_PATH.test(location) || location.split('?')[0]!.split('/').includes('..'))) {
      throw new GithubError('GitHub 请求路径无效');
    }
    const url = new URL(absolute ? location : location.replace(/^\/+/, ''), `${GITHUB_ORIGIN}/`);
    if (url.origin !== GITHUB_ORIGIN) throw new GithubError('GitHub 请求被拒绝：只允许 api.github.com');
    if (/^\/notifications(\/|$)/.test(url.pathname)) throw new GithubError('GitHub 请求被拒绝：不读取通知接口');
    return url;
  }

  private record(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const limit = headers.get('x-ratelimit-limit');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining !== null && Number.isFinite(Number(remaining))) this.rate.remaining = Number(remaining);
    if (limit !== null && Number.isFinite(Number(limit))) this.rate.limit = Number(limit);
    if (reset !== null && Number.isFinite(Number(reset))) this.rate.resetAt = Number(reset) * 1000;
  }

  private pauseFor(status: number, headers: Headers, message: string): number | null {
    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && headers.get('retry-after') !== null && retryAfter >= 0) return this.now() + retryAfter * 1000;
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && headers.get('x-ratelimit-reset') !== null) return reset * 1000;
    if (status === 429 || /rate limit/i.test(message)) return this.now() + SECONDARY_LIMIT_PAUSE_MS;
    return null;
  }

  async request(location: string, options: RequestOptions = {}): Promise<GithubResponse> {
    if (options.signal?.aborted) throw new DOMException('已中止', 'AbortError');
    const url = this.target(location);
    if (this.pausedUntil > this.now()) throw new GithubError('GitHub 限流中，暂停请求', 429, this.pausedUntil);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: options.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'paseo-github-subscriptions',
    };
    if (options.etag) headers['If-None-Match'] = options.etag;
    const signals = [Signals.timeout(this.timeoutMs), ...options.signal ? [options.signal] : []];
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: Signals.any(signals) });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'TimeoutError' || name === 'AbortError') throw new GithubError('GitHub 请求超时');
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      throw new GithubError(`GitHub 请求失败：${typeof code === 'string' ? code : name}`);
    }
    this.record(response.headers);
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new GithubError(`GitHub 返回重定向 (${response.status})，已拒绝`, response.status);
    }
    if (response.status === 304) return { status: 304, etag: options.etag ?? null, next: null, text: '', json: () => null };
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      try { detail = String((JSON.parse(text) as { message?: unknown }).message ?? ''); } catch { detail = ''; }
      const clean = this.scrub(detail).slice(0, MAX_ERROR_TEXT);
      if (response.status === 403 || response.status === 429) {
        const until = this.pauseFor(response.status, response.headers, detail);
        if (until !== null) {
          this.pausedUntil = Math.max(this.pausedUntil, until);
          throw new GithubError(`GitHub 限流 (${response.status})`, response.status, until);
        }
      }
      throw new GithubError(`GitHub ${response.status}${clean ? `：${clean}` : ''}`, response.status);
    }
    return {
      status: response.status, etag: response.headers.get('etag'), next: parseNext(response.headers.get('link')), text,
      json: () => JSON.parse(text) as unknown,
    };
  }

  async list(location: string, options: ListOptions = {}): Promise<ListResult> {
    const pick = options.pick ?? ((body: unknown) => Array.isArray(body) ? body : []);
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const first = await this.request(location, { etag: options.etag, signal: options.signal });
    if (first.status === 304) return { status: 304, etag: first.etag, items: [], truncated: false };
    const items = [...pick(first.json())];
    let next = first.next;
    let pages = 1;
    while (next && pages < maxPages) {
      const page = await this.request(next, { signal: options.signal });
      items.push(...pick(page.json()));
      next = page.next;
      pages += 1;
    }
    return { status: first.status, etag: first.etag, items, truncated: next !== null };
  }

  async get<Value>(schema: z.ZodType<Value>, location: string, signal?: AbortSignal): Promise<Value> {
    const response = await this.request(location, { signal });
    return schema.parse(response.json());
  }
}

export class RepositoryCommands implements Commands {
  private readonly client: GithubClient;
  private readonly repository: string;
  private readonly signal: AbortSignal | undefined;

  constructor(client: GithubClient, repository: string, signal?: AbortSignal) {
    this.client = client;
    this.repository = repository;
    this.signal = signal;
  }

  private locate(path: string): string {
    if (path === '') return `repos/${this.repository}`;
    if (path.startsWith('/') || /^https?:/i.test(path)) throw new GithubError('GitHub 请求路径无效');
    return `repos/${this.repository}/${path}`;
  }

  async api<Value>(schema: z.ZodType<Value>, path: string, ...flags: string[]): Promise<Value>;
  async api(path: string, ...flags: string[]): Promise<string>;
  async api<Value>(first: z.ZodType<Value> | string, ...rest: string[]): Promise<Value | string> {
    const schema = typeof first === 'string' ? null : first;
    const path = typeof first === 'string' ? first : rest[0]!;
    const flags = typeof first === 'string' ? rest : rest.slice(1);
    const accept = flags.flatMap((flag, index) => flag === '-H' && /^Accept:/i.test(flags[index + 1] ?? '') ? [flags[index + 1]!.replace(/^Accept:\s*/i, '')] : [])[0];
    const location = this.locate(path);
    if (flags.includes('--paginate')) {
      const pages: unknown[] = [];
      let next: string | null = location;
      let count = 0;
      while (next && count < 10) {
        const response: GithubResponse = await this.client.request(next, { signal: this.signal, ...accept ? { accept } : {} });
        pages.push(response.json());
        next = response.next;
        count += 1;
      }
      return schema ? schema.parse(pages) : JSON.stringify(pages);
    }
    const response = await this.client.request(location, { signal: this.signal, ...accept ? { accept } : {} });
    if (!schema) return response.text;
    return schema.parse(response.json());
  }

  async pages<Value>(item: z.ZodType<Value>, path: string, tally?: Tally): Promise<Value[]> {
    const listed = await this.client.list(this.locate(path), { signal: this.signal });
    return validItems(item, listed.items, tally);
  }
}
