import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { forwardMcp } from '../shared/cloud-session.ts';
import { ProviderEventSchema, type ProviderEvent, type ProviderInput } from '@getpaseo/plugin/server/provider';
import { createCloudSession, importRequest, registerCloudSession, connectWithTimeout, LOCAL_CONNECT_TIMEOUT_MS, redactError, type AnswerWebRequest } from '../server/cloud-session/index.ts';

const cloudId = 'cse_abcdefgh1234';
const token = 'fake-secret-token-1707';
const input = (value: unknown) => value as ProviderInput;
test('error redaction removes websocket addresses', () => {
  for (const scheme of ['ws', 'wss']) {
    const result = redactError(new Error(`connection failed: ${scheme}://example.invalid/path?token=fake-secret`));
    assert.equal(result, 'connection failed: [redacted URL]');
  }
});
async function fixture(url?: string, answerWeb?: AnswerWebRequest) {
  const agents: { id: string; cloud: string; archived: boolean; workspaceId: string; title?: string }[] = [];
  const importedCwds: string[] = [];
  const workspaces: { id: string; path: string; title: string; projectId?: string }[] = [];
  const pins: string[] = []; let failPin = false;
  let imports = 0; let failure: string | undefined; let closeFailure = false; let reloads = 0; let session = 0;
  let cloud: ReturnType<typeof createCloudSession>;
  let connection: Awaited<ReturnType<typeof cloud.provider.connect>>;
  const events: ProviderEvent[] = [];
  const open = async () => {
    await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: `s${++session}`, persistence: { version: 1, data: { cloudSessionId: cloudId } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: url ? { paseo: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } : {} } }));
  };
  const daemon = async () => ({
    list: async (id: string) => agents.find(a => a.cloud === id && !a.archived) ?? null,
    import: async (id: string, cwd: string, workspaceId: string) => { importedCwds.push(cwd); if (failure) { const message = failure; failure = undefined; throw new Error(message); } imports++; const a = { id: `a${imports}`, cloud: id, archived: false, workspaceId }; agents.push(a); await open(); return a; },
    createWorkspace: async (path: string, title: string, projectId?: string) => { const id = `workspace-${workspaces.length + 1}`; workspaces.push({ id, path, title, projectId }); return id; },
    pinWorkspace: async (id: string) => { pins.push(id); if (failPin) throw new Error(`Bearer ${token}`); },
    title: async (id: string, title: string) => { agents.find(a => a.id === id)!.title = title; }, serverId: () => 'server', close: async () => { if (closeFailure) throw new Error(`close failed Bearer ${token}`); },
  });
  const paseo = { agents: { ref: () => ({ reload: async () => { reloads++; await open(); } }) }, projects: { list: async () => ({ projects: [] }) }, workspaces: { list: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  const restart = async () => { cloud?.dispose(); cloud = createCloudSession(daemon, answerWeb); connection = await cloud.provider.connect({ versions: [1], capabilities: [] }); connection.onEvent(event => { assert.ok(ProviderEventSchema.safeParse(event).success); events.push(event); }); };
  await restart();
  return { get cloud() { return cloud; }, get connection() { return connection; }, events, agents, workspaces, pins, importedCwds, failPin(value: boolean) { failPin = value; }, get imports() { return imports; }, get reloads() { return reloads; }, failClose(value: boolean) { closeFailure = value; }, failNext(message = 'original import error') { failure = message; }, restart, open, paseo, current: () => `s${session}` };
}
test('import uses the CLI-compatible persistence handle', () => {
  const request = importRequest(cloudId, '/tmp');
  assert.equal(request.provider, 'cloud-session');
  assert.deepEqual(JSON.parse(request.sessionId.slice('plugin:'.length)), { version: 1, data: { cloudSessionId: cloudId } });
  assert.equal(request.labels['cloud-session.id'], cloudId);
});
const ensureInput = { cloudSessionId: cloudId, title: '标题', cwd: '/tmp' };
const prompt = (sessionId: string, id: string, delivery: string) => input({ type: 'session.prompt', sessionId, prompt: { clientMessageId: id, delivery, input: { type: 'message', content: [{ type: 'text', text: id }] } } });

test('provider, inbox, restoration, concurrent ensure and timeline', async () => {
  const f = await fixture('http://127.0.0.1:12345/mcp');
  const [a, b] = await Promise.all([f.cloud.ensure(ensureInput, f.paseo), f.cloud.ensure(ensureInput, f.paseo)]);
  assert.equal(a.agentId, b.agentId); assert.equal(f.imports, 1); assert.equal(f.agents[0]!.title, '标题');
  assert.deepEqual(f.events.slice(0, 4).map(e => e.type), ['session.opened', 'session.config', 'session.commands', 'session.ready']);
  const waiting = f.cloud.poll({ cloudSessionId: cloudId, afterSeq: 0, waitMs: 1000 });
  await f.connection.send(prompt(f.current(), 'first', 'auto'));
  assert.equal((await waiting).items[0]?.messageId, 'first');
  assert.deepEqual(f.events.slice(4).map(e => e.type), ['session.prompt_result', 'session.turn']);
  await f.connection.send(prompt(f.current(), 'second', 'steer'));
  assert.equal(f.events.at(-1)?.type, 'session.prompt_result');
  const poll = () => f.cloud.poll({ cloudSessionId: cloudId, afterSeq: 0, waitMs: 0 });
  assert.deepEqual((await poll()).items.map(i => i.delivery), ['auto', 'steer']);
  assert.deepEqual((await poll()).items.map(i => i.seq), [1, 2]);
  f.cloud.ack({ cloudSessionId: cloudId, seq: 1 }); assert.equal((await poll()).items.length, 1);
  await f.connection.send(input({ type: 'session.interrupt', sessionId: f.current(), requestId: 'interrupt' }));
  assert.equal(f.events.at(-1)?.type, 'request.completed');
  await f.connection.send(input({ type: 'session.configure', sessionId: f.current(), requestId: 'configure', changes: {} }));
  assert.equal(f.events.at(-1)?.type, 'request.completed');
  const before = f.events.length;
  assert.throws(() => f.cloud.push({ cloudSessionId: cloudId, startTurn: true, items: [{ type: 'assistant_message', id: 'x', text: 'ok' }, { type: 'tool_call' }] }));
  assert.equal(f.events.length, before);
  const tool = { type: 'tool_call', id: 'tool', callId: 'tool', name: 'read', detail: { type: 'plain_text', label: 'read', icon: 'wrench' }, status: 'running', error: null };
  f.cloud.push({ cloudSessionId: cloudId, startTurn: true, items: [tool, { ...tool, status: 'completed' }], endTurn: 'completed' });
  assert.deepEqual(f.events.slice(before).map(e => e.type), ['timeline.item', 'timeline.item', 'session.turn']);
  await f.connection.send(input({ type: 'session.close', sessionId: f.current(), requestId: 'close' }));
  assert.deepEqual(f.events.slice(-2).map(e => e.type), ['session.closed', 'request.completed']);
  await assert.rejects(f.cloud.mcp({ cloudSessionId: cloudId, message: {}, timeoutMs: 1000 }), /not_opened/);
  const previousSession = f.current();
  assert.equal((await f.cloud.ensure(ensureInput, f.paseo)).agentId, a.agentId);
  assert.notEqual(f.current(), previousSession);
  const oldEpoch = f.cloud.epoch; await f.restart(); assert.notEqual(f.cloud.epoch, oldEpoch); assert.equal((await poll()).items.length, 0);
  assert.equal((await f.cloud.ensure(ensureInput, f.paseo)).agentId, a.agentId);
  f.agents[0]!.archived = true; f.failNext(); await assert.rejects(f.cloud.ensure(ensureInput, f.paseo), /original import error/);
  assert.notEqual((await f.cloud.ensure(ensureInput, f.paseo)).agentId, a.agentId); assert.equal(f.imports, 2);
  f.cloud.dispose();
});

test('MCP forwards only to the session endpoint, handles JSON and SSE, and hides credentials', async () => {
  const seen: { url?: string; auth?: string; mcp?: string }[] = [];
  const server = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization, mcp: req.headers['mcp-session-id'] as string | undefined }); res.setHeader('mcp-session-id', 'mcp-id'); if (seen.length === 1) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', result: 'ok' })); } else { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', result: token })}\n\n`); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const f = await fixture(`http://127.0.0.1:${address.port}/mcp?callerAgentId=own`); await f.cloud.ensure(ensureInput, f.paseo);
    const payload = { cloudSessionId: cloudId, message: { jsonrpc: '2.0', method: 'tools/list' }, timeoutMs: 1000, url: 'http://elsewhere', callerAgentId: 'other' };
    const first = await f.cloud.mcp(payload); const second = await f.cloud.mcp(payload);
    assert.equal(first.status, 200); assert.equal(seen[0]?.url, '/mcp?callerAgentId=own'); assert.equal(seen[0]?.auth, `Bearer ${token}`); assert.equal(seen[1]?.mcp, 'mcp-id');
    assert.ok(!JSON.stringify([first, second, f.events]).includes(token));
    f.cloud.dispose();
  } finally { server.close(); }
});

test('RPC error paths conceal endpoint credentials and query values', async () => {
  const querySecret = 'fake-query-secret-1707';
  let behavior: 'status' | 'invalid' | 'timeout' = 'status';
  const server = createServer((_req, res) => {
    if (behavior === 'timeout') return;
    if (behavior === 'invalid') { res.setHeader('content-type', 'application/json'); res.end(`invalid ${token} ${querySecret}`); return; }
    res.statusCode = 503; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: `unavailable ${token} ${querySecret}` } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp?callerAgentId=${querySecret}`;
  const f = await fixture(url);
  type Handler = (data: unknown, context: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const host = {
    registerProvider() {},
    handle(contract: { name: string }, handler: Handler) { handlers.set(contract.name, handler); },
  } as unknown as PluginServerContext;
  const dispose = registerCloudSession(host, () => f.cloud);
  const invoke = async (name: string, data: unknown) => handlers.get(name)!(data, { paseo: f.paseo });
  const assertSafe = (value: unknown) => {
    const text = value instanceof Error ? value.message : JSON.stringify(value);
    assert.ok(!text.includes(token)); assert.ok(!text.includes(querySecret));
  };
  try {
    await f.cloud.ensure(ensureInput, f.paseo);
    const args = { cloudSessionId: cloudId, message: { jsonrpc: '2.0', method: 'tools/list' }, timeoutMs: 1000 };
    const status = await invoke('cloud-session.mcp', args) as { status: number; messages: unknown[] };
    assert.equal(status.status, 503); assert.equal(status.messages.length, 1); assert.ok(!JSON.stringify(status).includes(token)); assert.ok(JSON.stringify(status).includes(querySecret));
    behavior = 'invalid';
    await assert.rejects(invoke('cloud-session.mcp', args), error => { assertSafe(error); return error instanceof Error && error.message === 'Paseo MCP request failed'; });
    behavior = 'timeout';
    await assert.rejects(invoke('cloud-session.mcp', args), error => { assertSafe(error); return error instanceof Error && error.message === 'Paseo MCP request timed out'; });
    f.agents[0]!.archived = true;
    f.failNext(`import failed ${token} ${querySecret} ${url}`);
    await assert.rejects(invoke('cloud-session.ensure', ensureInput), error => { assertSafe(error); return error instanceof Error && error.message.includes('import failed'); });
    await f.restart();
    registerCloudSession(host, () => f.cloud);
    f.failNext(`import failed Bearer ${token} ${url}`);
    await assert.rejects(invoke('cloud-session.ensure', ensureInput), error => { assertSafe(error); return error instanceof Error && error.message.includes('import failed'); });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await f.open();
    await assert.rejects(invoke('cloud-session.mcp', args), error => { assertSafe(error); return error instanceof Error && error.message === 'Paseo MCP request failed'; });
  } finally { server.closeAllConnections(); server.close(); dispose(); f.cloud.dispose(); }
});

test('opened session without MCP remains running across ensure', async () => {
  const f = await fixture();
  const first = await f.cloud.ensure(ensureInput, f.paseo);
  await f.connection.send(prompt(f.current(), 'running', 'auto'));
  const events = f.events.length; const current = f.current(); const reloads = f.reloads;
  assert.equal((await f.cloud.ensure(ensureInput, f.paseo)).agentId, first.agentId);
  assert.equal(f.reloads, reloads); assert.equal(f.current(), current); assert.equal(f.events.length, events);
  assert.equal(f.cloud.push({ cloudSessionId: cloudId, startTurn: true, items: [] }).turnRunning, true);
  await assert.rejects(f.cloud.mcp({ cloudSessionId: cloudId, message: {}, timeoutMs: 1000 }), /not_opened/);
  f.cloud.dispose();
});

test('MCP preserves own agent ID and forwards params without changing endpoint identity', async () => {
  const own = 'own-agent-id-123'; let body: unknown; let requestUrl = ''; let auth = '';
  const server = createServer(async (req, res) => {
    requestUrl = req.url ?? ''; auth = req.headers.authorization ?? '';
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ parentAgentId: own, message: `child of ${own}`, token, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp?callerAgentId=${own}` }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const f = await fixture(`http://127.0.0.1:${addr.port}/mcp?callerAgentId=${own}`);
  try {
    await f.cloud.ensure(ensureInput, f.paseo);
    const message = { jsonrpc: '2.0', method: 'tools/call', params: { callerAgentId: 'other-agent', url: 'http://other.invalid/mcp' } };
    const result = await f.cloud.mcp({ cloudSessionId: cloudId, message, timeoutMs: 1000 });
    assert.deepEqual(body, message); assert.equal(requestUrl, `/mcp?callerAgentId=${own}`); assert.equal(auth, `Bearer ${token}`);
    assert.equal(result.messages[0]?.parentAgentId, own); assert.equal(result.messages[0]?.message, `child of ${own}`);
    assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes(`http://127.0.0.1:${addr.port}/mcp`));
  } finally { f.cloud.dispose(); server.closeAllConnections(); server.close(); }
});

test('local connection timeout releases ensure lock and closes failed client', async () => {
  assert.equal(LOCAL_CONNECT_TIMEOUT_MS, 5000);
  let connects = 0; let closes = 0;
  const cloud = createCloudSession(async () => {
    connects++;
    if (connects === 1) await connectWithTimeout({ connect: () => new Promise(() => {}), close: async () => { closes++; } }, 25);
    throw new Error('second attempt');
  });
  const paseo = {} as PaseoApi;
  const first = cloud.ensure(ensureInput, paseo); const second = cloud.ensure(ensureInput, paseo);
  await assert.rejects(first, /连接本机 daemon 超时/);
  await assert.rejects(second, /second attempt/);
  assert.equal(connects, 2); assert.equal(closes, 1); cloud.dispose();
});

test('daemon close failure does not mask result or import error', async () => {
  const f = await fixture('http://127.0.0.1:12345/mcp'); const logs: string[] = []; const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    f.failClose(true);
    assert.equal((await f.cloud.ensure(ensureInput, f.paseo)).agentId, 'a1');
    f.agents[0]!.archived = true; f.failNext('original import error');
    await assert.rejects(f.cloud.ensure(ensureInput, f.paseo), /original import error/);
    assert.equal(logs.length, 2); assert.ok(!logs.join(' ').includes(token));
  } finally { console.error = original; f.cloud.dispose(); }
});

test('MCP RPC timeout defaults to 45 seconds and rejects above 50 seconds', () => {
  assert.equal(forwardMcp.input.parse({ cloudSessionId: cloudId, message: {} }).timeoutMs, 45_000);
  assert.equal(forwardMcp.input.parse({ cloudSessionId: cloudId, message: {}, timeoutMs: 50_000 }).timeoutMs, 50_000);
  assert.equal(forwardMcp.input.safeParse({ cloudSessionId: cloudId, message: {}, timeoutMs: 50_001 }).success, false);
});

test('ensure selects an existing Mac project directory or the requested fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-cwd-test-'));
  const first = join(root, 'one'); const second = join(root, 'two'); const fallback = join(root, 'fallback');
  const missing = join(root, 'missing'); const file = join(root, 'file');
  await Promise.all([mkdir(first), mkdir(second), mkdir(fallback), writeFile(file, 'file')]);
  const project = (projectId: string, projectRootPath: string, projectDisplayName = 'repository') => ({ projectId, projectRootPath, projectDisplayName });
  const cases = [
    { name: 'matching project', projects: [project('one', first)], active: [], fallbackCwd: fallback, expected: first },
    { name: 'active workspace preferred', projects: [project('one', first), project('two', second)], active: ['two'], fallbackCwd: fallback, expected: second },
    { name: 'project order breaks ties', projects: [project('one', first), project('two', second)], active: ['one', 'two'], fallbackCwd: fallback, expected: first },
    { name: 'no active workspace uses first', projects: [project('one', first), project('two', second)], active: [], fallbackCwd: fallback, expected: first },
    { name: 'missing project directory ignored', projects: [project('one', missing), project('two', second)], active: ['one'], fallbackCwd: fallback, expected: second },
    { name: 'fallback directory', projects: [project('one', first, 'different')], active: [], fallbackCwd: fallback, expected: fallback },
    { name: 'missing fallback uses home', projects: [], active: [], fallbackCwd: missing, expected: homedir() },
    { name: 'file is not a fallback directory', projects: [], active: [], fallbackCwd: file, expected: homedir() },
  ];
  try {
    for (const example of cases) {
      const f = await fixture();
      const paseo = { ...f.paseo,
        projects: { list: async () => ({ projects: example.projects }) },
        workspaces: { list: async ({ filter }: { filter: { projectId: string } }) => ({ entries: example.active.includes(filter.projectId) ? [{ projectId: filter.projectId }] : [] }) },
      } as unknown as PaseoApi;
      try {
        await f.cloud.ensure({ ...ensureInput, cwd: '/cloud/path/repository/', fallbackCwd: example.fallbackCwd }, paseo);
        assert.equal(f.importedCwds[0], example.expected, example.name);
        const selected = example.projects.find(project => project.projectRootPath === example.expected && project.projectDisplayName === 'repository');
        assert.equal(f.workspaces[0]?.projectId, selected?.projectId, `${example.name}: project association`);
        assert.equal(f.agents[0]?.workspaceId, f.workspaces[0]?.id, `${example.name}: import into created workspace`);
        await f.cloud.ensure({ ...ensureInput, cwd: '/cloud/path/other' }, paseo);
        assert.equal(f.importedCwds.length, 1, `${example.name}: existing agent is reused`);
      } finally { f.cloud.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new cloud session creates and pins a dedicated workspace; existing agent reuses it', async () => {
  const f = await fixture();
  try {
    const result = await f.cloud.ensure(ensureInput, f.paseo);
    assert.equal(result.workspaceId, 'workspace-1');
    assert.deepEqual(f.workspaces, [{ id: 'workspace-1', path: homedir(), title: ensureInput.title, projectId: undefined }]);
    assert.deepEqual(f.pins, ['workspace-1']); assert.equal(f.agents[0]?.workspaceId, result.workspaceId);
    assert.equal((await f.cloud.ensure(ensureInput, f.paseo)).workspaceId, result.workspaceId);
    assert.equal(f.workspaces.length, 1); assert.equal(f.pins.length, 1);
  } finally { f.cloud.dispose(); }
});

test('workspace pin failure is logged safely and does not block ensure', async () => {
  const f = await fixture(); f.failPin(true);
  const logs: string[] = []; const original = console.error; console.error = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const result = await f.cloud.ensure(ensureInput, f.paseo);
    assert.equal(result.workspaceId, 'workspace-1'); assert.equal(logs.length, 1);
    assert.match(logs[0]!, /置顶失败/); assert.ok(!logs[0]!.includes(token));
  } finally { console.error = original; f.cloud.dispose(); }
});

test('provider mirrors requests and forwards human answers once until cloud resolves them', async () => {
  const received: Parameters<AnswerWebRequest>[0][] = [];
  let status: 'submitted' | 'page_not_open' | 'unknown' = 'submitted';
  const f = await fixture(undefined, async value => { received.push(value); return status === 'unknown' ? { status, detail: 'uncertain' } : { status }; });
  try {
    await f.cloud.ensure(ensureInput, f.paseo);
    const connection = f.connection;
    assert.ok(connection.capabilities.includes('permission'));
    const question = { toolUseId: 'tool-question', toolName: 'AskUserQuestion', kind: 'question' as const, input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } };
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request: question }), { shown: true });
    const event = f.events.at(-1); assert.equal(event?.type, 'session.permission');
    if (event?.type === 'session.permission') { assert.equal(event.request.id, question.toolUseId); assert.equal(event.request.kind, 'question'); assert.deepEqual(event.request.input, question.input); }
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request: question }), { shown: false });
    await connection.send(input({ type: 'session.permission', sessionId: f.current(), permissionId: question.toolUseId, response: { behavior: 'allow', updatedInput: { answers: { 'Which?': 'A' } } } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(received[0], { webSessionId: 'session_abcdefgh1234', toolUseId: question.toolUseId, kind: 'question', answers: { 'Which?': 'A' } });
    assert.equal(f.events.at(-1)?.type, 'session.permission');
    await connection.send(input({ type: 'session.permission', sessionId: f.current(), permissionId: question.toolUseId, response: { behavior: 'allow' } }));
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
    assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: question.toolUseId, outcome: 'answered' }), { closed: true });
    assert.equal(f.events.at(-1)?.type, 'session.permission_resolved');
    assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: question.toolUseId, outcome: 'answered' }), { closed: false });
    for (const next of ['page_not_open', 'unknown'] as const) {
      status = next; const toolUseId = `tool-${next}`;
      f.cloud.notify({ cloudSessionId: cloudId, request: { toolUseId, toolName: 'Bash', kind: 'tool', input: { command: 'sample' } } });
      const permission = f.events.at(-1); assert.equal(permission?.type, 'session.permission');
      if (permission?.type === 'session.permission') assert.equal(permission.request.kind, 'tool');
      await connection.send(input({ type: 'session.permission', sessionId: f.current(), permissionId: toolUseId, response: { behavior: 'deny' } }));
      await new Promise<void>(resolve => setImmediate(resolve));
      const last = f.events.at(-1); assert.equal(last?.type, 'timeline.item');
      if (last?.type === 'timeline.item' && last.item.type === 'assistant_message') assert.equal(last.item.text, next === 'page_not_open' ? '请在 claude.ai 作答' : '结果不确定，请在 claude.ai 核对');
      assert.equal(received.at(-1)?.decision, 'deny');
      await connection.send(input({ type: 'session.permission', sessionId: f.current(), permissionId: toolUseId, response: { behavior: 'allow' } }));
      await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(received.filter(item => item.toolUseId === toolUseId).length, 1);
      assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId, outcome: 'denied' }), { closed: true });
    }
  } finally { f.cloud.dispose(); }
});

test('pending requests reappear after reopen and can resolve while closed', async () => {
  const f = await fixture();
  try {
    await f.cloud.ensure(ensureInput, f.paseo);
    const request = { toolUseId: 'pending-one', toolName: 'Bash', kind: 'tool' as const, input: { command: 'sample' } };
    f.cloud.notify({ cloudSessionId: cloudId, request });
    await f.connection.send(input({ type: 'session.close', sessionId: f.current(), requestId: 'close' }));
    await f.open(); assert.equal(f.events.at(-1)?.type, 'session.permission');
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request }), { shown: false });
    await f.connection.send(input({ type: 'session.close', sessionId: f.current(), requestId: 'close-again' }));
    assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: request.toolUseId, outcome: 'answered' }), { closed: true });
    await f.open(); assert.equal(f.events.at(-1)?.type, 'session.ready');
  } finally { f.cloud.dispose(); }
});
