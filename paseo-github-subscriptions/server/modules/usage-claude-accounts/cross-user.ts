import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { UsageAccount, UsageReport } from '@getpaseo/plugin/server/usage';
import { toneFromUsedPct, windowFromUsedPct } from '@getpaseo/plugin/server/usage';
import { paseoHome } from './providers.ts';

const exec = promisify(execFile);
const mappingsSchema = z.record(z.string(), z.object({ command: z.string().startsWith('/'), args: z.array(z.string()) }).strict());
const replySchema = z.object({
  version: z.literal(1),
  account: z.object({ key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), label: z.string() }).optional(),
  plan: z.string().nullish(), error: z.string().optional(),
  windows: z.array(z.object({ id: z.string(), label: z.string(), shortLabel: z.string(), summary: z.boolean(),
    utilization: z.number().finite().min(0).max(100).nullable(), resetsAt: z.string().nullable() })).default([]),
});
type Reply = z.infer<typeof replySchema>;
const cacheSchema = z.record(z.string(), z.object({ until: z.number().finite(), reply: replySchema }));
const QUERY_INTERVAL = 5 * 60_000;
const RATE_LIMIT_WAIT = 15 * 60_000;
type Mappings = z.infer<typeof mappingsSchema>;
function mappings(file: string): Mappings {
  try { return mappingsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('独立用户额度配置无效'); return {}; }
}
export class CrossUserUsage {
  private load: () => Mappings;
  private run: (command: string, args: string[]) => Promise<string>;
  private cache = new Map<string, { until: number; reply: Reply }>();
  private now: () => number;
  private cacheFile?: string;
  private pending = new Map<string, Promise<Reply>>();
  private identities = new Map<string, NonNullable<Reply['account']>>();
  /** `directory` holds cross-user-providers.json (trusted query programs) and cross-user-cache.json. */
  constructor(options: { mappings?: () => Mappings; run?: (command: string, args: string[]) => Promise<string>; now?: () => number; cacheFile?: string; directory?: string } = {}) {
    const directory = options.directory ?? join(paseoHome(process.env), 'claude-quota-resume');
    this.load = options.mappings ?? (() => mappings(join(directory, 'cross-user-providers.json')));
    this.now = options.now ?? Date.now;
    this.cacheFile = options.cacheFile ?? (options.run ? undefined : join(directory, 'cross-user-cache.json'));
    if (this.cacheFile) {
      try {
        this.cache = new Map(Object.entries(cacheSchema.parse(JSON.parse(readFileSync(this.cacheFile, 'utf8')))));
        for (const [dir, entry] of this.cache) if (entry.reply.account) this.identities.set(dir, entry.reply.account);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('独立用户额度缓存读取失败'); }
    }
    this.run = options.run ?? (async (command, args) => (await exec(command, args, { timeout: 18000, maxBuffer: 65536 })).stdout);
  }
  handles(configDir: string | undefined): boolean { return !!configDir && !!this.load()[configDir]; }
  private async query(configDir: string): Promise<Reply> {
    const mapping = this.load()[configDir];
    if (!mapping) throw new Error('未配置独立用户额度查询');
    const cached = this.cache.get(configDir);
    if (cached && this.now() < cached.until) return cached.reply;
    const running = this.pending.get(configDir); if (running) return running;
    const task = (async () => {
      let reply: Reply;
      try { reply = replySchema.parse(JSON.parse(await this.run(mapping.command, mapping.args))); }
      catch { reply = { version: 1, error: 'query-failed', windows: [] }; }
      if (reply.account) this.identities.set(configDir, reply.account);
      else if (this.identities.has(configDir)) reply = { ...reply, account: this.identities.get(configDir) };
      const until = this.now() + (reply.error === 'http-429' ? RATE_LIMIT_WAIT : QUERY_INTERVAL);
      this.cache.set(configDir, { until, reply });
      if (this.cacheFile) {
        try {
          mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
          const temp = this.cacheFile + '.' + process.pid + '.tmp';
          writeFileSync(temp, JSON.stringify(Object.fromEntries(this.cache)), { mode: 0o600 });
          renameSync(temp, this.cacheFile);
        } catch { console.warn('独立用户额度缓存保存失败'); }
      }
      if (reply.error) {
        const safeCode = /^(egress-(mismatch|timeout|probe-failed|invalid-response)|http-(401|403|429)|network|keychain|query-failed)$/.test(reply.error) ? reply.error : 'query-failed';
        console.warn('独立用户额度查询失败：' + safeCode + '；下次允许查询：' + new Date(until).toISOString());
      }
      return reply;
    })();
    this.pending.set(configDir, task);
    try { return await task; } finally { this.pending.delete(configDir); }
  }
  async discover(configDir: string): Promise<UsageAccount[]> {
    const reply = await this.query(configDir);
    const account = reply.account ?? this.identities.get(configDir);
    return account ? [{ ...account, harness: 'Claude', input: { route: { store: 'cross-user', configDir }, accountKey: account.key } }] : [];
  }
  async fetch(configDir: string, accountKey: string): Promise<UsageReport> {
    const reply = await this.query(configDir);
    if (!reply.account || reply.error) return { status: 'error', error: reply.error === 'egress-mismatch'
      ? '专用代理实际出口与预期 IP 不一致，未发送账号额度请求'
      : reply.error === 'egress-timeout' ? '出口探测超时，未发送账号额度请求；未确认 IP 变化'
      : reply.error === 'egress-probe-failed' ? '出口探测连接失败，未发送账号额度请求'
      : reply.error === 'egress-invalid-response' ? '出口探测服务未返回有效 IP，未发送账号额度请求'
      : reply.error === 'http-429' ? '额度接口限流（HTTP 429），已暂停查询；' + new Date(this.cache.get(configDir)!.until).toISOString() + ' 后允许重试（UTC）'
      : reply.error === 'http-401' ? '账号接口拒绝当前登录凭据（HTTP 401），请检查独立用户登录状态'
      : reply.error === 'http-403' ? '账号接口拒绝访问（HTTP 403）'
      : reply.error === 'keychain' ? '独立用户钥匙串凭据读取失败'
      : reply.error === 'network' ? '出口核对已通过，但账号接口连接失败或超时'
      : '独立用户查询程序执行失败或返回格式异常，请检查插件日志' };
    if (reply.account.key !== accountKey) return { status: 'error', error: '独立用户登录账号已变化，请刷新账号列表' };
    if (!reply.windows.length) return { status: 'error', error: '额度接口未返回用量窗口' };
    return { status: 'available', planLabel: reply.plan ?? undefined, balances: [], details: [],
      windows: reply.windows.map(w => windowFromUsedPct({ id: w.id, label: w.label, shortLabel: w.shortLabel,
        summary: w.summary, utilizationPct: w.utilization, resetsAt: w.resetsAt,
        tone: toneFromUsedPct(w.utilization) })) };
  }
}
