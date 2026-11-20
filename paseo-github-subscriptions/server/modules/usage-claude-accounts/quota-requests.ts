import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TTL = 5 * 60_000;
const FALLBACK_WAIT = 15 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 只持久保存账号哈希与等待时间；响应和凭据仅在内存中使用。 */
export class QuotaRequests {
  private waits = new Map<string, number>();
  private cache = new Map<string, { until: number; response: Response }>();
  private pending = new Map<string, Promise<Response>>();
  private file: string;
  private send: typeof fetch;
  private now: () => number;

  constructor(file: string, send: typeof fetch = fetch, now: () => number = Date.now) {
    this.file = file; this.send = send; this.now = now;
    try {
      for (const [key, until] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
        if (/^[a-f0-9]{64}$/.test(key) && typeof until === 'number' && Number.isFinite(until) && until > now()) this.waits.set(key, until);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('额度查询等待记录读取失败');
    }
  }

  forAccount(identity: string, fallback?: string): typeof fetch {
    const account = hash(identity);
    return async (input, init) => {
      const url = String(input);
      if (!/^https:\/\/api\.anthropic\.com\/api\/oauth\/(profile|usage)$/.test(url) || (init?.method ?? 'GET') !== 'GET') return this.send(input, init);
      const now = this.now();
      const until = Math.max(this.waits.get(account) ?? 0, fallback ? this.waits.get(hash(fallback)) ?? 0 : 0);
      if (until && until > now) return this.limited(until);
      // 账号更换凭据后不能复用旧响应；限流等待则继续按账号生效。
      const key = hash(account + url + new Headers(init?.headers).get('authorization'));
      for (const [id, value] of this.cache) if (value.until <= now) this.cache.delete(id);
      const cached = this.cache.get(key);
      if (cached) return cached.response.clone();
      const running = this.pending.get(key);
      if (running) return (await running).clone();
      const task = (async () => {
        const response = await this.send(input, init);
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const seconds = header?.trim() ? Number(header) : NaN;
          const wait = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - this.now() : NaN;
          const delay = Number.isFinite(wait) && wait > 0 ? wait : FALLBACK_WAIT;
          const deadline = Math.max(this.waits.get(account) ?? 0, this.now() + delay);
          this.waits.set(account, deadline);
          for (const [id, value] of this.waits) if (value <= this.now()) this.waits.delete(id);
          try {
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = this.file + '.' + process.pid + '.tmp';
            writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.waits)), { mode: 0o600 });
            renameSync(temporary, this.file);
          } catch { console.warn('额度查询等待记录保存失败'); }
          console.warn('Claude 额度接口限流，暂停该账号查询至 ' + new Date(deadline).toISOString());
          return this.limited(deadline);
        }
        if (response.ok) this.cache.set(key, { until: this.now() + TTL, response: response.clone() });
        return response;
      })();
      this.pending.set(key, task);
      try { return (await task).clone(); }
      finally { this.pending.delete(key); }
    };
  }

  private limited(until: number): Response {
    return new Response(null, { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil((until - this.now()) / 1000))) } });
  }
}
