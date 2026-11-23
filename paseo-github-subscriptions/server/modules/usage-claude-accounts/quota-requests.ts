import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TTL = 5 * 60_000;
const FALLBACK_WAIT = 15 * 60_000;
const MAX_FAILURE_WAIT = 30 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Endpoint = 'profile' | 'usage';
type Failure = { kind: 'network' | 'server'; endpoint: Endpoint; until: number; attempts: number; status?: number };
export type QuotaRequestProblem = Omit<Failure, 'attempts'> | { kind: 'rate-limit'; until: number };

export function quotaRequestMessage(problem: QuotaRequestProblem): string {
  const reason = problem.kind === 'rate-limit' ? 'Claude 额度接口限流（HTTP 429）'
    : `Claude ${problem.endpoint === 'profile' ? '账号资料' : '额度'}接口` + (problem.kind === 'network' ? '连接失败或超时' : `暂时异常（HTTP ${problem.status}）`);
  return `${reason}，已暂停查询；${new Date(problem.until).toISOString()} 后允许重试（UTC）`;
}

function retryAfter(response: Response, now: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header?.trim() ? Number(header) : NaN;
  const wait = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - now : NaN;
  return Number.isFinite(wait) && wait > 0 ? wait : 0;
}

/** 只持久保存账号哈希与等待时间；响应和凭据仅在内存中使用。 */
export class QuotaRequests {
  private waits = new Map<string, number>();
  private cache = new Map<string, { until: number; response: Response }>();
  private pending = new Map<string, Promise<Response>>();
  private failures = new Map<string, Failure>();
  private aliases = new Map<string, string>();
  private file: string;
  private send: typeof fetch;
  private now: () => number;

  constructor(file: string, send: typeof fetch = fetch, now: () => number = Date.now, legacyFile?: string) {
    this.file = file; this.send = send; this.now = now;
    for (const source of new Set([...(legacyFile ? [legacyFile] : []), file])) try {
      const saved = JSON.parse(readFileSync(source, 'utf8'));
      for (const [key, until] of Object.entries(saved)) {
        if (/^[a-f0-9]{64}$/.test(key) && typeof until === 'number' && Number.isFinite(until) && until > now()) this.waits.set(key, Math.max(until, this.waits.get(key) ?? 0));
      }
      for (const [key, value] of Object.entries(saved.failures ?? {})) {
        const failure = value as Failure;
        if (/^[a-f0-9]{64}$/.test(key) && failure && ['network', 'server'].includes(failure.kind)
          && ['profile', 'usage'].includes(failure.endpoint) && Number.isFinite(failure.until)
          && Number.isInteger(failure.attempts) && failure.attempts >= 1 && failure.attempts <= 4
          && (failure.kind === 'network' || (typeof failure.status === 'number' && failure.status >= 500 && failure.status < 600))
          && failure.until >= (this.failures.get(key)?.until ?? 0)) this.failures.set(key, failure);
      }
      for (const [alias, account] of Object.entries(saved.aliases ?? {})) {
        if (/^[a-f0-9]{64}$/.test(alias) && typeof account === 'string' && /^[a-f0-9]{64}$/.test(account)) this.aliases.set(alias, account);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('额度查询等待记录读取失败');
    }
  }

  problem(identity: string, fallback?: string, endpoint?: Endpoint): QuotaRequestProblem | null {
    const accounts = [hash(identity), ...(fallback ? [hash(fallback)] : [])];
    // 资料文件暂时缺失、身份退回目录键时，仍遵守已确认账号的等待。
    if (!fallback || identity === fallback) {
      const known = this.aliases.get(hash(identity));
      if (known) accounts.push(known);
    }
    const until = Math.max(...accounts.map(account => this.waits.get(account) ?? 0));
    if (until > this.now()) return { kind: 'rate-limit', until };
    const failures = accounts.flatMap(account => (endpoint ? [endpoint] : ['profile', 'usage'] as const)
      .map(name => this.failures.get(hash(account + name))))
      .filter((failure): failure is Failure => !!failure && failure.until > this.now());
    return failures.sort((a, b) => b.until - a.until)[0] ?? null;
  }

  forAccount(identity: string, fallback?: string): typeof fetch {
    const account = hash(identity);
    if (fallback && identity !== fallback) this.aliases.set(hash(fallback), account);
    return async (input, init) => {
      const url = String(input);
      if (!/^https:\/\/api\.anthropic\.com\/api\/oauth\/(profile|usage)$/.test(url) || (init?.method ?? 'GET') !== 'GET') return this.send(input, init);
      const endpoint = url.endsWith('/profile') ? 'profile' : 'usage';
      const now = this.now();
      const problem = this.problem(identity, fallback, endpoint);
      if (problem?.kind === 'rate-limit') return this.limited(problem.until);
      if (problem?.kind === 'network') throw new Error('Claude quota request temporarily paused');
      if (problem) return new Response(null, { status: problem.status });
      // 账号更换凭据后不能复用旧响应；限流等待则继续按账号生效。
      const key = hash(account + url + new Headers(init?.headers).get('authorization'));
      for (const [id, value] of this.cache) if (value.until <= now) this.cache.delete(id);
      const cached = this.cache.get(key);
      if (cached) return cached.response.clone();
      const running = this.pending.get(key);
      if (running) return (await running).clone();
      const task = (async () => {
        let response: Response;
        try { response = await this.send(input, init); }
        catch {
          this.failed(account, endpoint);
          throw new Error('Claude quota request failed');
        }
        if (response.status >= 500 && response.status < 600) {
          this.failed(account, endpoint, response.status, retryAfter(response, this.now()));
          return response;
        }
        const cleared = this.failures.delete(hash(account + endpoint));
        if (response.status === 429) {
          const delay = retryAfter(response, this.now()) || FALLBACK_WAIT;
          const deadline = Math.max(this.waits.get(account) ?? 0, this.now() + delay);
          this.waits.set(account, deadline);
          this.save();
          this.log(account, endpoint, 429, deadline);
          return this.limited(deadline);
        }
        if (cleared) this.save();
        // 拒绝结果也按当前凭据缓存；重新登录产生的新凭据不会命中旧结果。
        if (response.ok || response.status === 401 || response.status === 403) this.cache.set(key, { until: this.now() + TTL, response: response.clone() });
        return response;
      })();
      this.pending.set(key, task);
      try { return (await task).clone(); }
      finally { this.pending.delete(key); }
    };
  }

  private failed(account: string, endpoint: Endpoint, status?: number, serverWait = 0) {
    const key = hash(account + endpoint);
    const attempts = Math.min(4, (this.failures.get(key)?.attempts ?? 0) + 1);
    const until = this.now() + Math.max(serverWait, Math.min(MAX_FAILURE_WAIT, TTL * 2 ** (attempts - 1)));
    this.failures.set(key, { kind: status ? 'server' : 'network', endpoint, until, attempts, ...(status ? { status } : {}) });
    this.save();
    this.log(account, endpoint, status ?? 'network', until);
  }

  private save() {
    for (const [id, value] of this.waits) if (value <= this.now()) this.waits.delete(id);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({ ...Object.fromEntries(this.waits), failures: Object.fromEntries(this.failures), aliases: Object.fromEntries(this.aliases) }), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch { console.warn('额度查询等待记录保存失败'); }
  }

  /** 只记录实际失败的请求；缓存与本地等待不重复记为服务端限流。 */
  private log(account: string, endpoint: Endpoint, status: number | 'network', until: number) {
    console.warn(`Claude 额度查询：账号 ${account.slice(0, 12)}，接口 ${endpoint}，结果 ${status}，下次允许请求 ${new Date(until).toISOString()}`);
  }

  private limited(until: number): Response {
    return new Response(null, { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil((until - this.now()) / 1000))) } });
  }
}
