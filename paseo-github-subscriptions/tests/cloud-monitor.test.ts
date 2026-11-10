import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderEventSchema, type ProviderEvent, type ProviderInput } from '@getpaseo/plugin/server/provider';
import { createCloudSession } from '../server/cloud-session/index.ts';
import { fileContactStore } from '../server/cloud-session/contact-store.ts';
import { fileRequestStore } from '../server/cloud-session/request-store.ts';

const id = 'cse_abcdefgh1234';
const input = (value: unknown) => value as ProviderInput;
const request = (toolUseId: string) => ({ toolUseId, toolName: 'AskUserQuestion', kind: 'question' as const, input: { questions: [] } });
async function fixture(opts: { directory?: string; pending?: string[]; activeTurn?: string; initial?: number } = {}) {
  let time = opts.initial ?? 1_800_000_000_000;
  const events: ProviderEvent[] = [];
  const daemon = async () => ({ list: async () => ({ id: 'agent', pendingPermissions: (opts.pending ?? []).map(id => ({ id, name: 'AskUserQuestion', kind: 'question', input: {} })), activeTurn: opts.activeTurn ? { turnId: opts.activeTurn } : null }), import: async () => ({ id: 'agent' }), createWorkspace: async () => 'w', pinWorkspace: async () => {}, title: async () => {}, serverId: () => 'server', close: async () => {} });
  const cloud = createCloudSession(daemon, undefined, undefined, { now: () => time, offlineMs: 120 * 60_000, sweepIntervalMs: 0, importFromDaemon: true, ...(opts.directory ? { store: fileRequestStore(join(opts.directory, 'requests.json')), contactStore: fileContactStore(join(opts.directory, 'contacts.json')) } : {}) });
  const connection = await cloud.provider.connect({ versions: [1], capabilities: [] });
  connection.onEvent(event => { assert.ok(ProviderEventSchema.safeParse(event).success); events.push(event); });
  await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: 'agent', persistence: { version: 1, data: { cloudSessionId: id } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: {} } }));
  await cloud.flush();
  return { cloud, events, advance: (ms: number) => { time += ms; }, time: () => time, close: () => cloud.dispose() };
}
const resolved = (events: ProviderEvent[]) => events.filter(e => e.type === 'session.permission_resolved').map(e => e.permissionId);
const ended = (events: ProviderEvent[]) => events.filter(e => e.type === 'session.turn' && e.state === 'canceled');
const messages = (events: ProviderEvent[]) => events.filter(e => e.type === 'timeline.item').map(e => JSON.stringify(e.item));

test('可信归档信号立即结束轮次并撤下全部请求', async () => {
  const f = await fixture();
  try {
    f.cloud.push({ cloudSessionId: id, startTurn: true, items: [] });
    f.cloud.notify({ cloudSessionId: id, request: request('one') }); f.cloud.notify({ cloudSessionId: id, request: request('two') });
    assert.deepEqual(await f.cloud.reportEnded({ cloudSessionId: id, reason: 'archived' }), { closedRequests: 2 });
    assert.deepEqual(resolved(f.events), ['one', 'two']); assert.equal(ended(f.events).length, 1);
    assert.ok(messages(f.events).some(message => message.includes('云端会话已归档，已撤下 2 条请求')));
  } finally { f.close(); }
});
test('失联满阈值结束轮次并说明，不将失联称作归档', async () => {
  const f = await fixture();
  try {
    f.cloud.push({ cloudSessionId: id, startTurn: true, items: [] }); f.cloud.notify({ cloudSessionId: id, request: request('one') });
    f.advance(119 * 60_000); f.cloud.sweep(); assert.deepEqual(resolved(f.events), []);
    f.advance(60_000); f.cloud.sweep(); assert.deepEqual(resolved(f.events), ['one']); assert.equal(ended(f.events).length, 1);
    assert.ok(messages(f.events).some(message => message.includes('云端已失联') && message.includes('仍在等待请在网页处理')));
    f.cloud.sweep(); assert.equal(ended(f.events).length, 1);
  } finally { f.close(); }
});
test('正常长任务持续发送心跳时不结束轮次或撤下请求', async () => {
  const f = await fixture();
  try {
    f.cloud.push({ cloudSessionId: id, startTurn: true, items: [] }); f.cloud.notify({ cloudSessionId: id, request: request('one') });
    for (let i = 0; i < 180; i++) { f.advance(60_000); f.cloud.push({ cloudSessionId: id, startTurn: false, items: [] }); f.cloud.sweep(); }
    assert.deepEqual(resolved(f.events), []); assert.equal(ended(f.events).length, 0);
  } finally { f.close(); }
});
test('重载读回存量请求及运行轮次，按持久化联系时间结束', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-monitor-'));
  try {
    const first = await fixture({ directory: dir }); first.cloud.notify({ cloudSessionId: id, request: request('one') }); await first.cloud.flush(); const start = first.time(); first.close();
    const second = await fixture({ directory: dir, initial: start + 121 * 60_000, pending: ['one', 'two'], activeTurn: 'restored-turn' });
    try {
      second.cloud.sweep(); assert.deepEqual(resolved(second.events).sort(), ['one', 'two']);
      assert.equal((ended(second.events)[0] as Extract<ProviderEvent, { type: 'session.turn' }> | undefined)?.turnId, 'restored-turn');
      assert.ok(messages(second.events).some(message => message.includes('已撤下 2 条请求')));
    } finally { second.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('读回失败时不假装清理完成，恢复连接后重试', async () => {
  let time = 1_800_000_000_000; let available = false; const events: ProviderEvent[] = [];
  const daemon = async () => ({ list: async () => { if (!available) throw Error('offline'); return { id: 'agent', pendingPermissions: [{ id: 'old', name: 'AskUserQuestion', kind: 'question', input: {} }], activeTurn: { turnId: 'turn' } }; }, import: async () => ({ id: 'agent' }), createWorkspace: async () => 'w', pinWorkspace: async () => {}, title: async () => {}, serverId: () => 'server', close: async () => {} });
  const cloud = createCloudSession(daemon, undefined, undefined, { now: () => time, offlineMs: 120 * 60_000, sweepIntervalMs: 0, importFromDaemon: true });
  const connection = await cloud.provider.connect({ versions: [1], capabilities: [] }); connection.onEvent(event => events.push(event));
  try {
    await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: 'agent', persistence: { version: 1, data: { cloudSessionId: id } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: {} } }));
    await cloud.flush(); time += 121 * 60_000; cloud.sweep(); await cloud.flush();
    assert.deepEqual(resolved(events), []); assert.equal(ended(events).length, 0);
    available = true; cloud.sweep(); await cloud.flush(); cloud.sweep();
    assert.deepEqual(resolved(events), ['old']); assert.equal(ended(events).length, 1);
  } finally { cloud.dispose(); }
});
test('读回期间收到新的云端结束事件，不复活旧轮次', async () => {
  let time = 1_800_000_000_000; let done!: (value: any) => void; const events: ProviderEvent[] = [];
  const pending = new Promise<any>(resolve => { done = resolve; });
  const daemon = async () => ({ list: async () => pending, import: async () => ({ id: 'agent' }), createWorkspace: async () => 'w', pinWorkspace: async () => {}, title: async () => {}, serverId: () => 'server', close: async () => {} });
  const cloud = createCloudSession(daemon, undefined, undefined, { now: () => time, offlineMs: 120 * 60_000, sweepIntervalMs: 0, importFromDaemon: true });
  const connection = await cloud.provider.connect({ versions: [1], capabilities: [] }); connection.onEvent(event => events.push(event));
  try {
    await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: 'agent', persistence: { version: 1, data: { cloudSessionId: id } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: {} } }));
    cloud.push({ cloudSessionId: id, startTurn: true, items: [], endTurn: 'completed' });
    done({ id: 'agent', pendingPermissions: [], activeTurn: { turnId: 'old' } }); await cloud.flush();
    time += 121 * 60_000; cloud.sweep(); assert.equal(ended(events).length, 0);
  } finally { cloud.dispose(); }
});
test('可信不存在信号独立标明原因，并且重复通知不重复结束', async () => {
  const f = await fixture();
  try {
    f.cloud.push({ cloudSessionId: id, startTurn: true, items: [] });
    assert.deepEqual(await f.cloud.reportEnded({ cloudSessionId: id, reason: 'not_found' }), { closedRequests: 0 });
    assert.deepEqual(await f.cloud.reportEnded({ cloudSessionId: id, reason: 'not_found' }), { closedRequests: 0 });
    assert.equal(ended(f.events).length, 1); assert.equal(messages(f.events).filter(message => message.includes('云端会话不存在')).length, 1);
  } finally { f.close(); }
});
test('收件轮询也是云端联系，持续轮询不触发失联', async () => {
  const f = await fixture();
  try {
    f.cloud.push({ cloudSessionId: id, startTurn: true, items: [] }); f.cloud.notify({ cloudSessionId: id, request: request('one') });
    for (let i = 0; i < 3; i++) { f.advance(60 * 60_000); await f.cloud.poll({ cloudSessionId: id, afterSeq: 0, waitMs: 0 }); f.cloud.sweep(); }
    assert.deepEqual(resolved(f.events), []); assert.equal(ended(f.events).length, 0);
  } finally { f.close(); }
});
test('读回期间收到心跳仍可恢复运行轮次', async () => {
  let time = 1_800_000_000_000; let done!: (value: any) => void; const events: ProviderEvent[] = [];
  const pending = new Promise<any>(resolve => { done = resolve; });
  const daemon = async () => ({ list: async () => pending, import: async () => ({ id: 'agent' }), createWorkspace: async () => 'w', pinWorkspace: async () => {}, title: async () => {}, serverId: () => 'server', close: async () => {} });
  const cloud = createCloudSession(daemon, undefined, undefined, { now: () => time, offlineMs: 120 * 60_000, sweepIntervalMs: 0, importFromDaemon: true });
  const connection = await cloud.provider.connect({ versions: [1], capabilities: [] }); connection.onEvent(event => events.push(event));
  try {
    await connection.send(input({ type: 'session.open', requestId: 'open', sessionId: 'agent', persistence: { version: 1, data: { cloudSessionId: id } }, config: { cwd: '/tmp', env: {}, persist: true, mcpServers: {} } }));
    cloud.push({ cloudSessionId: id, startTurn: false, items: [] });
    done({ id: 'agent', pendingPermissions: [], activeTurn: { turnId: 'old' } }); await cloud.flush();
    time += 121 * 60_000; cloud.sweep();
    assert.equal((ended(events)[0] as Extract<ProviderEvent, { type: 'session.turn' }> | undefined)?.turnId, 'old');
  } finally { cloud.dispose(); }
});
