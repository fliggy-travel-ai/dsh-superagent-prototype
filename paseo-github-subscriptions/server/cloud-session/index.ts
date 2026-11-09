import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHostClient } from '@getpaseo/client/node';
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderInput, type ProviderRegistration, type ProviderTimelineItem } from '@getpaseo/plugin/server/provider';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import * as rpc from '../../shared/cloud-session.ts';
import { cloudSessionStatus } from '../../shared/provider-instance.ts';
import { webRequestDetailReason, type AnswerWebRequest, type ResolveWebRequest, type WebRequestAnswer, type WebRequestContext, type WebRequestResult } from '../../shared/web-request.ts';
import { toWebAnswer } from '../web-request/normalize.ts';

export type { AnswerWebRequest, ResolveWebRequest, WebRequestAnswer, WebRequestContext, WebRequestResult };

type Emit = (event: ProviderEvent) => void;
type Endpoint = { url: string; headers: Record<string, string>; session?: string };
type Session = { id: string; cloud: string; emit: Emit; cwd: string; model: string; mode: string; turn: string | null; endpoint?: Endpoint };
type Item = { seq: number; messageId: string; delivery: 'auto' | 'steer'; text: string; receivedAt: string };
type Daemon = { list(id: string): Promise<{ id: string; workspaceId?: string } | null>; import(id: string, cwd: string, workspaceId: string): Promise<{ id: string; workspaceId?: string }>; createWorkspace(cwd: string, title: string, projectId?: string): Promise<string>; pinWorkspace(id: string): Promise<void>; title(id: string, title: string): Promise<void>; serverId(): string; close(): Promise<void> };
const caps = ['prompt.message', 'prompt.steer', 'session.persistence', 'permission'] as const;
type PendingRequest = { toolUseId: string; toolName: string; kind: 'question' | 'tool'; input: Record<string, unknown> };
export const CLOUD_MANUAL_REQUEST_MARKER = 'cloudSessionManual';



function timelineMessage(result: WebRequestResult): string {
  if (result.status === 'submitted') return '已在 claude.ai 页面提交，等待云端确认';
  if (result.status === 'page_not_open') return 'claude.ai 页面没有打开，请在 claude.ai 作答';
  if (result.detail === 'tool_in_browser') return '权限请求由 claude.ai 页面处理，Paseo 里的回答没有提交，请在 claude.ai 核对';
  if (result.detail === 'multiple_instances') return '多个浏览器环境打开了此会话，没有提交，请在 claude.ai 作答';
  const reason = webRequestDetailReason(result.detail);
  return `结果不确定（${reason}），请在 claude.ai 核对`;
}


function endpointSecrets(endpoint: Endpoint): string[] {
  const authorization = Object.entries(endpoint.headers).filter(([name]) => name.toLowerCase() === 'authorization').map(([, value]) => value);
  return [endpoint.url, ...authorization.flatMap(value => [value, value.replace(/^Bearer\s+/i, '')])].filter(Boolean).sort((a, b) => b.length - a.length);
}

function endpointErrorSecrets(endpoint: Endpoint): string[] {
  const url = new URL(endpoint.url);
  const queryValues = [...url.searchParams.values()];
  const encodedValues = url.search.slice(1).split('&').map(part => part.includes('=') ? part.slice(part.indexOf('=') + 1) : '');
  return [...endpointSecrets(endpoint), ...queryValues, ...encodedValues].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
}

export function redactError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, secrets)
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&][^=\s&#]+)=([^&#\s]+)/g, '$1=[redacted]')
    .replace(/((?:token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

export const LOCAL_CONNECT_TIMEOUT_MS = 5000;
export async function connectWithTimeout(client: { connect(): Promise<unknown>; close(): Promise<unknown> }, timeoutMs = LOCAL_CONNECT_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([client.connect(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error('连接本机 daemon 超时')); }, timeoutMs);
    })]);
  } catch {
    // Do not allow a failed close to mask the connection error or retain the ensure lock.
    void client.close().catch(() => {});
    throw new Error(timedOut ? '连接本机 daemon 超时' : '本机 daemon 连接失败');
  } finally { clearTimeout(timer); }
}

export function importRequest(id: string, cwd: string, workspaceId?: string) {
  return { ...(workspaceId ? { workspaceId } : {}), provider: rpc.CLOUD_SESSION_PROVIDER_ID, sessionId: `plugin:${JSON.stringify({ version: 1, data: { cloudSessionId: id } })}`, cwd, labels: { [rpc.CLOUD_SESSION_LABEL]: id } };
}

async function connectLocal(): Promise<Daemon> {
  const home = process.env.PASEO_HOME ?? join(homedir(), '.paseo');
  const lock = JSON.parse(await readFile(join(home, 'paseo.pid'), 'utf8')) as { listen: string };
  const client = createHostClient(lock.listen, { clientId: `cloud-session-${randomUUID()}`, clientType: 'cli', localCredential: async () => (await readFile(join(home, 'local-credential'), 'utf8')).trim() || undefined, reconnect: { enabled: false } });
  await connectWithTimeout(client);
  return {
    async list(id) {
      let cursor: string | undefined;
      do {
        const page = await client.fetchAgents({ filter: { labels: { [rpc.CLOUD_SESSION_LABEL]: id }, includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        const found = page.entries.find(({ agent }) => !agent.archivedAt && agent.labels[rpc.CLOUD_SESSION_LABEL] === id);
        if (found) return found.agent;
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return null;
    },
    import: (id, cwd, workspaceId) => client.importAgent(importRequest(id, cwd, workspaceId)),
    async createWorkspace(cwd, title, projectId) {
      const result = await client.createWorkspace({ source: { kind: 'directory', path: cwd, ...(projectId ? { projectId } : {}) }, title });
      if (result.error || !result.workspace) throw new Error(result.error ?? '工作区创建失败');
      return result.workspace.id;
    },
    async pinWorkspace(id) { await client.setWorkspacePinned(id, true); },
    title: (id, title) => client.updateAgent(id, { name: title }),
    serverId: () => { const id = client.getLastServerInfoMessage()?.serverId; if (!id) throw new Error('daemon server id unavailable'); return id; },
    close: () => client.close(),
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function resolveImportCwd(paseo: import('@getpaseo/client').PaseoApi, cwd: string, fallbackCwd?: string): Promise<{ path: string; projectId?: string }> {
  const name = basename(cwd);
  const projects = (await paseo.projects.list()).projects.filter(project => project.projectDisplayName === name);
  const matches: typeof projects = [];
  for (const project of projects) if (await directoryExists(project.projectRootPath)) matches.push(project);
  if (matches.length === 1) return { path: matches[0]!.projectRootPath, projectId: matches[0]!.projectId };
  if (matches.length > 1) {
    for (const project of matches) {
      const workspaces = await paseo.workspaces.list({ filter: { projectId: project.projectId, includeBackground: true }, page: { limit: 1 } });
      if (workspaces.entries.length) return { path: project.projectRootPath, projectId: project.projectId };
    }
    return { path: matches[0]!.projectRootPath, projectId: matches[0]!.projectId };
  }
  return { path: fallbackCwd && await directoryExists(fallbackCwd) ? fallbackCwd : homedir() };
}

function displayInput(request: PendingRequest): Record<string, unknown> {
  if (request.kind !== 'question' || request.toolName !== 'AskUserQuestion' || !Array.isArray(request.input.questions)) return structuredClone(request.input);
  return {
    ...structuredClone(request.input),
    questions: request.input.questions.map(question => question && typeof question === 'object' && !Array.isArray(question) ? { ...structuredClone(question as Record<string, unknown>), allowOther: true } : structuredClone(question)),
  };
}

export function createCloudSession(connect: () => Promise<Daemon> = connectLocal, answerWebRequest: AnswerWebRequest = async () => ({ status: 'page_not_open' }), resolveWebRequest?: ResolveWebRequest) {
  const epoch = randomUUID();
  const sessions = new Map<string, Session>();
  const queues = new Map<string, { seq: number; items: Item[]; waiters: Set<() => void> }>();
  const locks = new Map<string, Promise<unknown>>();
  const workspaceReservations = new Map<string, { id: string; path: string }>();
  const requests = new Map<string, Map<string, { request: PendingRequest; closed: boolean; delivered: boolean; response?: Extract<ProviderInput, { type: 'session.permission' }>['response'] }>>();
  const pending = (cloud: string) => { let entries = requests.get(cloud); if (!entries) { entries = new Map(); requests.set(cloud, entries); } return entries; };
  const permissionEvent = (s: Session, request: PendingRequest) => {
    const event = ProviderEventSchema.parse({ type: 'session.permission', sessionId: s.id, request: { id: request.toolUseId, name: request.toolName, kind: request.kind, title: request.toolName, input: displayInput(request), metadata: { [CLOUD_MANUAL_REQUEST_MARKER]: true, webSessionId: `session_${s.cloud.slice(4)}`, toolUseId: request.toolUseId } } });
    s.emit(event);
  };
  const notify = ({ cloudSessionId, request }: { cloudSessionId: string; request: PendingRequest }) => {
    const s = find(cloudSessionId); const entries = pending(cloudSessionId);
    const existing = entries.get(request.toolUseId);
    if (existing) { if (!isDeepStrictEqual(existing.request, request)) throw new Error('云端请求内容已变化'); return { shown: false }; }
    ProviderEventSchema.parse({ type: 'session.permission', sessionId: s.id, request: { id: request.toolUseId, name: request.toolName, kind: request.kind, title: request.toolName, input: request.input } });
    const original = structuredClone(request);
    entries.set(request.toolUseId, { request: original, closed: false, delivered: false }); permissionEvent(s, original); return { shown: true };
  };
  const resolve = ({ cloudSessionId, toolUseId, outcome }: { cloudSessionId: string; toolUseId: string; outcome: 'answered' | 'denied' | 'canceled' }) => {
    const entry = requests.get(cloudSessionId)?.get(toolUseId); if (!entry || entry.closed) return { closed: false };
    entry.closed = true;
    resolveWebRequest?.({ webSessionId: `session_${cloudSessionId.slice(4)}`, toolUseId, outcome });
    const s = sessions.get(cloudSessionId); if (s) s.emit({ type: 'session.permission_resolved', sessionId: s.id, permissionId: toolUseId }); return { closed: true };
  };
  const answer = async (s: Session, permissionId: string, response: Extract<ProviderInput, { type: 'session.permission' }>['response']) => {
    const entry = requests.get(s.cloud)?.get(permissionId);
    if (!entry || entry.closed) return;
    if (entry.delivered) {
      if (!isDeepStrictEqual(entry.response, response)) s.emit({ type: 'timeline.item', sessionId: s.id, item: { type: 'assistant_message', id: randomUUID(), text: timelineMessage({ status: 'unknown', detail: 'answer_changed' }) } });
      return;
    }
    entry.delivered = true; entry.response = structuredClone(response);
    let result: WebRequestResult;
    try {
      const context = { webSessionId: `session_${s.cloud.slice(4)}`, toolUseId: permissionId, expected: { toolName: entry.request.toolName, input: structuredClone(entry.request.input) } };
      if (entry.request.kind === 'question') {
        const normalized = toWebAnswer(context.expected, response);
        if (!normalized.ok) result = { status: normalized.status, detail: normalized.detail };
        else result = await answerWebRequest({ ...context, kind: 'question', answers: normalized.answers, ...(normalized.otherAnswers ? { otherAnswers: normalized.otherAnswers } : {}) });
      } else result = await answerWebRequest({ ...context, kind: 'tool', decision: response.behavior });
    } catch { result = { status: 'unknown', detail: '' }; }
    if (entry.closed || sessions.get(s.cloud) !== s) return;
    const text = timelineMessage(result);
    s.emit({ type: 'timeline.item', sessionId: s.id, item: { type: 'assistant_message', id: randomUUID(), text } });
  };
  const queue = (id: string) => { let q = queues.get(id); if (!q) { q = { seq: 0, items: [], waiters: new Set() }; queues.set(id, q); } return q; };
  const find = (cloud: string) => { const session = sessions.get(cloud); if (!session) throw new Error('not_opened'); return session; };
  const finish = (s: Session, state: 'completed' | 'failed' | 'canceled') => { if (!s.turn) return; const turnId = s.turn; s.turn = null; s.emit({ type: 'session.turn', sessionId: s.id, turnId, state, ...(state === 'failed' ? { error: { message: 'Cloud turn failed', code: 'CLOUD_TURN_FAILED' } } : {}) }); };
  const start = (s: Session) => { const turnId = randomUUID(); s.turn = turnId; s.emit({ type: 'session.turn', sessionId: s.id, turnId, state: 'started' }); };
  const config = (s: Session) => ({ model: s.model, mode: s.mode, models: [{ id: 'cloud-session', label: '云端会话', isDefault: true }], modes: [{ id: 'default', label: 'Default' }], thinkingOptions: [], settings: [] });
  const provider: ProviderRegistration = {
    id: rpc.CLOUD_SESSION_PROVIDER_ID, label: '云端会话', async status() { return { available: true }; },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Provider protocol version 1 is required');
      const listeners = new Set<Emit>(); let closed = false;
      const emit: Emit = e => { if (!closed) for (const listener of listeners) listener(e); };
      const byId = (id: string) => [...sessions.values()].find(s => s.id === id && s.emit === emit);
      const handle = (input: ProviderInput) => {
        if (input.type === 'catalog') { emit({ type: 'catalog', requestId: input.requestId, catalog: { models: [{ id: 'cloud-session', label: '云端会话', isDefault: true }], modes: [{ id: 'default', label: 'Default' }], defaultModel: 'cloud-session', defaultMode: 'default' } }); return; }
        if (input.type === 'sessions') { emit({ type: 'sessions', requestId: input.requestId, sessions: [] }); return; }
        if (input.type === 'session.open') {
          const data = input.persistence?.data;
          const cloud = rpc.CloudSessionIdSchema.parse(data && typeof data === 'object' && !Array.isArray(data) ? data.cloudSessionId : undefined);
          const server = input.config.mcpServers.paseo;
          let endpoint: Endpoint | undefined;
          if (server && server.type !== 'stdio') {
            const url = new URL(server.url);
            if ((url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) endpoint = { url: server.url, headers: { ...server.headers } };
          }
          const s: Session = { id: input.sessionId, cloud, emit, cwd: input.config.cwd, model: input.config.model ?? 'cloud-session', mode: input.config.mode ?? 'default', turn: null, ...(endpoint ? { endpoint } : {}) };
          sessions.set(cloud, s);
          emit({ type: 'session.opened', requestId: input.requestId, sessionId: s.id, capabilities: [...caps], restoration: 'core', persistence: { version: 1, data: { cloudSessionId: cloud } }, cwd: s.cwd, title: input.config.title });
          emit({ type: 'session.config', sessionId: s.id, config: config(s) });
          emit({ type: 'session.commands', sessionId: s.id, commands: [] });
          emit({ type: 'session.ready', requestId: input.requestId, sessionId: s.id });
          for (const entry of requests.get(cloud)?.values() ?? []) if (!entry.closed) permissionEvent(s, entry.request);
          return;
        }
        if (input.type === 'session.prompt') {
          const s = byId(input.sessionId); if (!s) { emit({ type: 'session.prompt_result', sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: { message: 'Unknown session', code: 'UNKNOWN_SESSION' } } }); return; }
          const delivery = s.turn ? 'steer' : 'auto'; const turnId = s.turn ?? randomUUID();
          emit({ type: 'session.prompt_result', sessionId: s.id, clientMessageId: input.prompt.clientMessageId, result: { type: delivery === 'steer' ? 'steer' : 'turn', turnId } });
          if (!s.turn) { s.turn = turnId; emit({ type: 'session.turn', sessionId: s.id, turnId, state: 'started' }); }
          const text = input.prompt.input.type === 'message' ? input.prompt.input.content.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n') : `/${input.prompt.input.name} ${input.prompt.input.arguments}`;
          const q = queue(s.cloud); q.items.push({ seq: ++q.seq, messageId: input.prompt.clientMessageId, delivery, text, receivedAt: new Date().toISOString() }); for (const wake of q.waiters) wake(); return;
        }
        if (input.type === 'session.permission') { const s = byId(input.sessionId); if (s) void answer(s, input.permissionId, input.response); return; }
        if (input.type === 'session.close') { const s = byId(input.sessionId); if (s && sessions.get(s.cloud) === s) sessions.delete(s.cloud); emit({ type: 'session.closed', sessionId: input.sessionId }); emit({ type: 'request.completed', requestId: input.requestId }); return; }
        if (input.type === 'session.interrupt') { emit({ type: 'request.completed', requestId: input.requestId }); return; }
        if (input.type === 'session.configure') { const s = byId(input.sessionId); if (s) { s.model = input.changes.model ?? s.model; s.mode = input.changes.mode ?? s.mode; emit({ type: 'session.config', sessionId: s.id, config: config(s) }); } emit({ type: 'request.completed', requestId: input.requestId }); return; }
        if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: { message: 'Unsupported request', code: 'UNSUPPORTED' } });
      };
      return { version: 1, capabilities: [...caps], async send(input) { if (closed) throw new Error('Connection closed'); handle(input); }, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async close() { closed = true; for (const [id, s] of sessions) if (s.emit === emit) sessions.delete(id); listeners.clear(); } } satisfies ProviderConnection;
    },
  };
  const ensure = async (input: { cloudSessionId: string; title: string; cwd: string; fallbackCwd?: string }, paseo: import('@getpaseo/client').PaseoApi) => {
    const previous = locks.get(input.cloudSessionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const knownSecrets = [...sessions.values()].flatMap(session => session.endpoint ? endpointErrorSecrets(session.endpoint) : []);
      let daemon: Daemon | undefined;
      try {
        daemon = await connect();
        let agent = await daemon.list(input.cloudSessionId); const created = !agent;
        if (!agent) {
          sessions.delete(input.cloudSessionId);
          let workspace = workspaceReservations.get(input.cloudSessionId);
          if (!workspace) {
            const location = await resolveImportCwd(paseo, input.cwd, input.fallbackCwd);
            const id = await daemon.createWorkspace(location.path, input.title, location.projectId);
            workspace = { id, path: location.path }; workspaceReservations.set(input.cloudSessionId, workspace);
            try { await daemon.pinWorkspace(id); } catch { console.error('云端会话工作区置顶失败'); }
          }
          agent = await daemon.import(input.cloudSessionId, workspace.path, workspace.id);
          if (!agent.workspaceId) agent = { ...agent, workspaceId: workspace.id };
          workspaceReservations.delete(input.cloudSessionId);
          await daemon.title(agent.id, input.title);
        }
        if (!agent.workspaceId) throw new Error('云端会话 agent 没有关联工作区');
        if (!sessions.has(input.cloudSessionId)) await paseo.agents.ref(agent.id).reload();
        if (!sessions.has(input.cloudSessionId)) throw new Error('not_opened');
        return { agentId: agent.id, serverId: daemon.serverId(), workspaceId: agent.workspaceId, epoch, created };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const secrets = [...knownSecrets, ...[...sessions.values()].flatMap(session => session.endpoint ? endpointErrorSecrets(session.endpoint) : [])];
        const safe = redactError(message, secrets);
        if (error instanceof Error && safe === message) throw error;
        throw new Error(safe);
      } finally {
        if (daemon) {
          try { await daemon.close(); } catch { console.error('本机 daemon 连接关闭失败'); }
        }
      }
    });
    locks.set(input.cloudSessionId, operation); try { return await operation; } finally { if (locks.get(input.cloudSessionId) === operation) locks.delete(input.cloudSessionId); }
  };
  const push = (input: { cloudSessionId: string; startTurn: boolean; items: Record<string, unknown>[]; usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; contextWindowMaxTokens?: number; contextWindowUsedTokens?: number }; endTurn?: 'completed' | 'failed' | 'canceled' }) => {
    const s = find(input.cloudSessionId);
    const items = input.items.map(item => {
      if (!['user_message', 'assistant_message', 'reasoning', 'tool_call'].includes(String(item.type))) throw new Error('Invalid timeline item');
      const result = ProviderEventSchema.safeParse({ type: 'timeline.item', sessionId: s.id, item });
      if (!result.success || result.data.type !== 'timeline.item') throw new Error('Invalid timeline item');
      return result.data.item;
    });
    if (input.startTurn && !s.turn) start(s);
    for (const item of items) s.emit({ type: 'timeline.item', sessionId: s.id, item: item as ProviderTimelineItem });
    if (input.usage) s.emit({ type: 'session.usage', sessionId: s.id, turnId: s.turn ?? undefined, usage: input.usage });
    if (input.endTurn) finish(s, input.endTurn);
    return { accepted: items.length, turnRunning: !!s.turn, epoch };
  };
  const poll = async ({ cloudSessionId, afterSeq, waitMs }: { cloudSessionId: string; afterSeq: number; waitMs: number }) => {
    const q = queue(cloudSessionId); if (!q.items.some(i => i.seq > afterSeq) && waitMs) await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); q.waiters.delete(done); resolve(); }; const timer = setTimeout(done, waitMs); q.waiters.add(done); });
    return { epoch, items: q.items.filter(i => i.seq > afterSeq), lastSeq: q.seq };
  };
  const ack = ({ cloudSessionId, seq }: { cloudSessionId: string; seq: number }) => { const q = queue(cloudSessionId); q.items = q.items.filter(i => i.seq > seq); return { remaining: q.items.length }; };
  const mcp = async ({ cloudSessionId, message, timeoutMs }: { cloudSessionId: string; message: Record<string, unknown>; timeoutMs: number }) => {
    const endpoint = find(cloudSessionId).endpoint; if (!endpoint) throw new Error('not_opened');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint.url, { method: 'POST', redirect: 'error', headers: { ...endpoint.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(endpoint.session ? { 'Mcp-Session-Id': endpoint.session } : {}) }, body: JSON.stringify(message), signal: controller.signal });
      endpoint.session = response.headers.get('mcp-session-id') ?? endpoint.session;
      const body = await response.text(); const parts = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? body.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')).filter(Boolean) : body.trim() ? [body] : [];
      const secrets = endpointSecrets(endpoint);
      const clean = (value: unknown): unknown => {
        if (typeof value === 'string') return redact(value, secrets);
        if (Array.isArray(value)) return value.map(clean);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [clean(key) as string, clean(entry)]));
        return value;
      };
      return { status: response.status, messages: parts.map(part => clean(JSON.parse(part)) as Record<string, unknown>) };
    } catch { throw new Error(controller.signal.aborted ? 'Paseo MCP request timed out' : 'Paseo MCP request failed'); } finally { clearTimeout(timer); }
  };
  const status = () => {
    let unackedMessages = 0;
    for (const q of queues.values()) unackedMessages += q.items.length;
    return { enabled: true, onlineSessions: sessions.size, unackedMessages };
  };
  return { provider, ensure, push, poll, ack, mcp, notify, resolve, status, epoch, dispose() { sessions.clear(); requests.clear(); workspaceReservations.clear(); for (const q of queues.values()) for (const wake of q.waiters) wake(); queues.clear(); } };
}

export function registerCloudSession(server: PluginServerContext, create = createCloudSession) {
  const cloud = create();
  server.registerProvider(cloud.provider);
  server.handle(rpc.ensureSession, (input, context) => cloud.ensure(input, context.paseo));
  server.handle(rpc.pushTimeline, input => cloud.push(input));
  server.handle(rpc.pollInbox, input => cloud.poll(input));
  server.handle(rpc.ackInbox, input => cloud.ack(input));
  server.handle(rpc.forwardMcp, input => cloud.mcp(input));
  server.handle(rpc.notifyPendingRequest, input => cloud.notify(input));
  server.handle(rpc.resolvePendingRequest, input => cloud.resolve(input));
  server.handle(cloudSessionStatus, () => cloud.status());
  return () => cloud.dispose();
}
