import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserApprovalEventSchema, BrowserBindingInputSchema, BrowserSettingsSchema, BrowserSyncSchema, type AnswerWebRequest, type BrowserBindingInput, type BrowserPairing, type BrowserSettings, type BrowserSnapshot, type WebRequestAnswer, type WebRequestResult } from '../shared/browser.ts';
import type { PresenceRuntime } from './presence.ts';

const ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_BODY = 65536;
const MAX_AGE = 150_000;
const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名会话';
const key = (instanceId: string, sessionId: string) => `${instanceId}:${sessionId}`;

export class BrowserBridge {
  private settings: BrowserSettings = BrowserSettingsSchema.parse({});
  private bindings: BrowserSnapshot['bindings'] = [];
  private approvals: NonNullable<BrowserSnapshot['approvals']> = [];
  private sessions = new Map<string, BrowserSnapshot['sessions'][number]>();
  private seen = new Map<string, number>();
  private server: Server | null = null;
  private token = '';
  private error: string | null = null;
  private started = false;
  private tail: Promise<unknown> = Promise.resolve();
  private directory: string;
  private resolveAgent: (agentId: string) => Promise<{ id: string; title: string } | null>;
  private syncQuestions?: PresenceRuntime['browserSync'];
  private answerWeb?: AnswerWebRequest;
  private usageRoute?: (body: unknown) => void | Promise<void>;

  constructor(directory: string, resolveAgent: (agentId: string) => Promise<{ id: string; title: string } | null>, syncQuestions?: PresenceRuntime['browserSync'], answerWeb?: AnswerWebRequest) { this.directory = directory; this.resolveAgent = resolveAgent; this.syncQuestions = syncQuestions; this.answerWeb = answerWeb; }
  setUsageRoute(route: (body: unknown) => void | Promise<void>) { this.usageRoute = route; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next;
  }
  private async save() {
    const path = join(this.directory, 'browser-state.json');
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ settings: this.settings, bindings: this.bindings, approvals: this.approvals }), { mode: 0o600 });
    await rename(tmp, path); await chmod(path, 0o600);
  }
  async start(): Promise<void> { return this.serial(async () => {
    if (this.started) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(join(this.directory, 'browser-state.json'), 'utf8'));
      this.settings = BrowserSettingsSchema.parse(state.settings);
      this.bindings = BrowserBindingInputSchema.extend({ agentId: BrowserBindingInputSchema.shape.agentId.unwrap() }).array().parse(state.bindings);
      this.approvals = BrowserApprovalEventSchema.array().parse(state.approvals ?? []).slice(-300);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('浏览器分组状态无效'); }
    const tokenPath = join(this.directory, 'browser-token');
    try { this.token = (await readFile(tokenPath, 'utf8')).trim(); if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('invalid'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('浏览器配对令牌无效'); this.token = randomBytes(32).toString('hex'); await writeFile(tokenPath, this.token, { mode: 0o600, flag: 'wx' }); }
    await chmod(tokenPath, 0o600); this.started = true;
    if (this.settings.enabled) await this.listen().catch(() => {});
  }); }
  private async listen() {
    const server = createServer((req, res) => {
      const origin = req.headers.origin ?? '';
      if (!ORIGIN.test(origin)) { res.writeHead(403).end(); return; }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS' && (req.url === '/sync' || req.url === '/usage')) {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '60' }).end(); return;
      }
      const provided = req.headers.authorization ?? '';
      const expected = `Bearer ${this.token}`;
      const a = Buffer.from(provided), b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST' || (req.url !== '/sync' && req.url !== '/usage') || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(404).end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); } else chunks.push(chunk); });
      req.on('end', () => { if (size > MAX_BODY) return; void this.serial(async () => {
        try {
          if (req.url === '/usage') { await this.usageRoute?.(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(204).end(); return; }
          const input = BrowserSyncSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const ids = new Set<string>();
          for (const s of input.sessions) {
            const url = new URL(s.url);
            if (url.origin !== 'https://claude.ai' || url.pathname !== `/code/session_${s.sessionId}` || url.search || url.hash || ids.has(s.sessionId)) throw new Error('invalid');
            ids.add(s.sessionId);
          }
          const next: BrowserSnapshot['sessions'] = [];
          let bindingsChanged = false;
          for (const s of input.sessions) {
            const binding = this.bindings.find(b => b.instanceId === input.instanceId && b.sessionId === s.sessionId);
            let agent: { id: string; title: string } | null = null;
            if (binding) { try {
              agent = await this.resolveAgent(binding.agentId);
              if (!agent || agent.id !== binding.agentId) { this.bindings = this.bindings.filter(b => b !== binding); bindingsChanged = true; agent = null; }
            } catch { agent = null; } }
            if (agent?.id !== binding?.agentId) agent = null;
            next.push({ ...s, title: cleanTitle(s.title), instanceId: input.instanceId, instanceName: input.instanceName, lastSeenAt: new Date().toISOString(), agentId: agent?.id ?? null, groupTitle: cleanTitle(agent?.title ?? s.title) });
          }
          const previousApprovals = JSON.stringify(this.approvals);
          for (const entry of input.approvals) {
            const previous = this.approvals.find(item => item.instanceId === input.instanceId && item.reservationId === entry.reservationId);
            if (previous) {
              if (previous.sessionId !== entry.sessionId || previous.digest !== entry.digest || previous.at !== entry.at || previous.button !== entry.button || previous.status !== 'reserved') continue;
              Object.assign(previous, entry);
            } else this.approvals.push({ ...entry, instanceId: input.instanceId, instanceName: input.instanceName });
          }
          this.approvals.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)); this.approvals = this.approvals.slice(-300);
          if (bindingsChanged || previousApprovals !== JSON.stringify(this.approvals)) await this.save();
          for (const [k, session] of this.sessions) if (session.instanceId === input.instanceId) this.sessions.delete(k);
          for (const session of next) this.sessions.set(key(session.instanceId, session.sessionId), session);
          this.seen.set(input.instanceId, Date.now());
          const decisions = await this.syncQuestions?.(input.instanceId, input.questions, input.results, input.sessions, input.observedSessionIds) ?? [];
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ sessions: next.map(({ sessionId, groupTitle }) => ({ sessionId, groupTitle })), decisions }));
        } catch { if (!res.headersSent) res.writeHead(400).end(); }
      }); });
      req.on('error', () => {});
    });
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.settings.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); this.server = server; this.error = null; server.on('error', () => { this.error = '浏览器桥接服务错误'; }); }
    catch { server.close(); this.error = '浏览器桥接端口不可用'; throw new Error(this.error); }
  }
  private async close() { const server = this.server; this.server = null; this.seen.clear(); this.sessions.clear(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
  async stop(): Promise<void> { return this.serial(async () => { await this.close(); this.started = false; }); }
  snapshot(): BrowserSnapshot {
    const now = Date.now(); const active = [...this.seen.values()].some(t => now - t < MAX_AGE);
    return { settings: { ...this.settings }, connected: !!this.server && active, error: this.error, approvals: this.approvals.map(entry => ({ ...entry })), sessions: [...this.sessions.values()].filter(s => now - Date.parse(s.lastSeenAt) < MAX_AGE).map(s => ({ ...s })), bindings: this.bindings.map(b => ({ ...b })) };
  }
  async configure(value: BrowserSettings): Promise<BrowserSnapshot> { return this.serial(async () => {
    if (!this.started) throw new Error('浏览器桥接尚未启动');
    const settings = BrowserSettingsSchema.parse(value); await this.close(); this.settings = settings; await this.save();
    if (settings.enabled) await this.listen(); else this.error = null;
    return this.snapshot();
  }); }
  async bind(value: BrowserBindingInput): Promise<BrowserSnapshot> { return this.serial(async () => {
    if (!this.started) throw new Error('浏览器桥接尚未启动');
    const input = BrowserBindingInputSchema.parse(value); const current = this.sessions.get(key(input.instanceId, input.sessionId));
    if (input.agentId && (!current || Date.now() - Date.parse(current.lastSeenAt) >= MAX_AGE)) throw new Error('浏览器会话不可用');
    const agent = input.agentId ? await this.resolveAgent(input.agentId) : null;
    if (input.agentId && (!agent || agent.id !== input.agentId)) throw new Error('Paseo 会话不可用');
    this.bindings = this.bindings.filter(b => b.instanceId !== input.instanceId || b.sessionId !== input.sessionId);
    if (input.agentId) this.bindings.push({ instanceId: input.instanceId, sessionId: input.sessionId, agentId: input.agentId });
    await this.save();
    if (current) { current.agentId = agent?.id ?? null; current.groupTitle = cleanTitle(agent?.title ?? current.title); }
    return this.snapshot();
  }); }
  async pairing(): Promise<BrowserPairing> { if (!this.started || !this.server || !this.settings.enabled) throw new Error('浏览器桥接未启用'); return { url: `http://127.0.0.1:${this.settings.port}/sync`, token: this.token }; }
  freshSessions(now = Date.now()): BrowserSnapshot['sessions'] {
    return [...this.sessions.values()].filter(s => now - Date.parse(s.lastSeenAt) < 70_000).map(s => ({ ...s }));
  }
  syncStatus(now = Date.now()) {
    const seenAges = [...this.seen.values()].map(t => now - t).filter(age => age < MAX_AGE);
    const activeSessions = [...this.sessions.values()].filter(s => now - Date.parse(s.lastSeenAt) < MAX_AGE).map(s => ({ ...s }));
    const freshSessions = this.freshSessions(now);
    const hasFreshInstance = seenAges.some(age => age < 70_000) || freshSessions.length > 0;
    const hasStaleInstance = seenAges.some(age => age >= 70_000) || activeSessions.some(s => now - Date.parse(s.lastSeenAt) >= 70_000);
    return { connected: !!this.server && (seenAges.length > 0 || activeSessions.length > 0), hasFreshInstance, hasStaleInstance, freshSessions, activeSessions };
  }
  async answerWebRequest(request: WebRequestAnswer): Promise<WebRequestResult> {
    if (!this.answerWeb) return { status: 'page_not_open' };
    return this.answerWeb(request);
  }
}
