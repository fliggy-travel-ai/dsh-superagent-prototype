import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderEventSchema, type ProviderEvent, type ProviderInput } from '@getpaseo/plugin/server/provider';
import { createCloudSession, type ResolveWebRequest } from '../server/cloud-session/index.ts';
import { fileRequestStore } from '../server/cloud-session/request-store.ts';

// #1737 评论 6734539343：网页上已处理的云端请求在 Paseo 中一直显示。插件侧对账兜底。

const cloudId = 'cse_abcdefgh1234';
const input = (value: unknown) => value as ProviderInput;
const tool = (toolUseId: string, command = 'sample') => ({ toolUseId, toolName: 'Bash', kind: 'tool' as const, input: { command } });
const MIN = 60_000;

async function fixture(options: { store?: ReturnType<typeof fileRequestStore>; pending?: Array<{ id: string; name: string; kind: string; input: Record<string, unknown> }> } = {}) {
  let now = Date.parse('2026-11-09T08:00:00Z');
  const events: ProviderEvent[] = [];
  const confirmed: Parameters<ResolveWebRequest>[0][] = [];
  const daemon = async () => ({
    list: async () => ({ id: 'agent-1', workspaceId: 'w', pendingPermissions: options.pending ?? [] }),
    import: async () => ({ id: 'agent-1', workspaceId: 'w' }), createWorkspace: async () => 'w', pinWorkspace: async () => {}, title: async () => {}, serverId: () => 'server', close: async () => {},
  });
  const cloud = createCloudSession(daemon, async () => ({ status: 'page_not_open' }), value => { confirmed.push(value); }, {
    now: () => now, sweepIntervalMs: 0, importFromDaemon: Boolean(options.pending), ...(options.store ? { store: options.store } : {}),
  });
  const connection = await cloud.provider.connect({ versions: [1], capabilities: [] });
  connection.onEvent(event => { assert.ok(ProviderEventSchema.safeParse(event).success); events.push(event); });
  const open = async () => {
    await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: 'agent-1', persistence: { version: 1, data: { cloudSessionId: cloudId } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: {} } }));
    await new Promise(resolve => setImmediate(resolve));
  };
  await open();
  const resolved = () => events.filter(event => event.type === 'session.permission_resolved').map(event => (event as { permissionId: string }).permissionId);
  const shown = () => events.filter(event => event.type === 'session.permission').map(event => (event as { request: { id: string } }).request.id);
  return { cloud, connection, events, confirmed, open, resolved, shown, advance(ms: number) { now += ms; }, close: () => cloud.dispose() };
}

test('云端关闭未知编号的请求时仍发 permission_resolved，并记墓碑，之后同编号的通知不再显示', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: 'toolu_unknown', outcome: 'answered' }), { closed: true });
    assert.deepEqual(f.resolved(), ['toolu_unknown']);
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_unknown') }), { shown: false });
    assert.deepEqual(f.shown(), []);
  } finally { f.close(); }
});

test('同一编号内容不同的重复通知不再抛错，只返回不显示，原请求保留', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_1', 'first') }), { shown: true });
    assert.deepEqual(f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_1', 'second') }), { shown: false });
    assert.deepEqual(f.shown(), ['toolu_1']);
  } finally { f.close(); }
});

test('云端推送的时间线里工具调用已结束时，插件直接关闭对应请求（不依赖云端 marker）', async () => {
  const f = await fixture();
  try {
    f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_2') });
    f.cloud.push({ cloudSessionId: cloudId, startTurn: false, items: [{ type: 'tool_call', id: 'toolu_2', callId: 'toolu_2', name: 'Bash', detail: { type: 'unknown', input: null, output: null }, status: 'completed', error: null }] });
    assert.deepEqual(f.resolved(), ['toolu_2']);
    assert.deepEqual(f.confirmed.map(item => [item.toolUseId, item.outcome]), [['toolu_2', 'answered']]);
    // 云端随后再发关闭：不重复处理
    assert.deepEqual(f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: 'toolu_2', outcome: 'answered' }), { closed: false });
    assert.deepEqual(f.resolved(), ['toolu_2']);
  } finally { f.close(); }
});

test('有更新请求（晚于本条至少 60 秒）且已过 10 分钟的旧请求被撤下，并在时间线说明；非存量请求等 2 小时也不撤下', async () => {
  const f = await fixture();
  try {
    f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_old') });
    f.advance(5 * MIN);
    f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_new') });
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), []);
    f.advance(6 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), ['toolu_old']);
    assert.ok(f.events.some(event => event.type === 'timeline.item' && /已撤下/.test(JSON.stringify(event))));
    // 用户离开很久：真实在等的请求不撤下（2 小时规则只用于重载后读回的存量）
    f.advance(3 * 60 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), ['toolu_old']);
  } finally { f.close(); }
});

test('并行工具调用几乎同时触发的多个请求，10 分钟后都还在', async () => {
  const f = await fixture();
  try {
    for (const id of ['toolu_p1', 'toolu_p2', 'toolu_p3']) { f.cloud.notify({ cloudSessionId: cloudId, request: tool(id, id) }); f.advance(2000); }
    f.advance(15 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), []);
  } finally { f.close(); }
});

test('墓碑不算“之后有新请求”', async () => {
  const f = await fixture();
  try {
    f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_waiting') });
    f.advance(5 * MIN);
    f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: 'toolu_unknown_late', outcome: 'answered' });
    f.advance(20 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), ['toolu_unknown_late']);
  } finally { f.close(); }
});

test('请求表和墓碑落盘：重载后仍认得已关闭编号，重新打开会话时补发 permission_resolved，未关闭的重新显示', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-perm-store-'));
  try {
    const path = join(directory, 'cloud-requests.json');
    const first = await fixture({ store: fileRequestStore(path) });
    first.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_open') });
    first.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_done') });
    first.cloud.resolve({ cloudSessionId: cloudId, toolUseId: 'toolu_done', outcome: 'answered' });
    await first.cloud.flush();
    first.close();
    assert.match(await readFile(path, 'utf8'), /toolu_done/);

    const second = await fixture({ store: fileRequestStore(path) });
    try {
      assert.deepEqual(second.shown(), ['toolu_open']);
      assert.deepEqual(second.resolved(), ['toolu_done']);
      assert.deepEqual(second.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_done') }), { shown: false });
    } finally { second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('墓碑有上限和过期：超过 7 天的墓碑丢弃，总数不超过上限', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-perm-cap-'));
  try {
    const path = join(directory, 'cloud-requests.json');
    const f = await fixture({ store: fileRequestStore(path) });
    try {
      for (let i = 0; i < 520; i++) f.cloud.resolve({ cloudSessionId: cloudId, toolUseId: `toolu_${i}`, outcome: 'answered' });
      f.cloud.sweep(); await f.cloud.flush();
      let saved = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(saved.entries.length <= 500, String(saved.entries.length));
      f.advance(8 * 24 * 60 * MIN);
      f.cloud.sweep(); await f.cloud.flush();
      saved = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(saved.entries.length, 0);
    } finally { f.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('重载后从 daemon 读回存量待批请求：之后有新请求（晚 60 秒以上）并过 10 分钟即撤下（部署后清理 38530eb6 的残留）', async () => {
  const pending = [
    { id: 'toolu_stale_1', name: 'mcp__paseo__get_agent_status', kind: 'tool', input: {} },
    { id: 'toolu_stale_2', name: 'AskUserQuestion', kind: 'question', input: { questions: [] } },
  ];
  const f = await fixture({ pending });
  try {
    await f.cloud.flush();
    // 存量请求已在 Paseo 中显示，读回时不重复显示
    assert.deepEqual(f.shown(), []);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), []);
    f.advance(1 * MIN);
    f.cloud.notify({ cloudSessionId: cloudId, request: tool('toolu_fresh') });
    f.advance(10 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved().sort(), ['toolu_stale_1', 'toolu_stale_2']);
  } finally { f.close(); }
});

test('重载后读回的存量请求没有新请求时，等满 2 小时撤下', async () => {
  const f = await fixture({ pending: [{ id: 'toolu_lonely', name: 'Bash', kind: 'tool', input: {} }] });
  try {
    await f.cloud.flush();
    f.advance(119 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), []);
    f.advance(2 * MIN);
    f.cloud.sweep();
    assert.deepEqual(f.resolved(), ['toolu_lonely']);
  } finally { f.close(); }
});
