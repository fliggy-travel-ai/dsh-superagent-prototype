import test from 'node:test';
import assert from 'node:assert/strict';
import { StalledRuntime, type StalledAgent, type StalledPort } from '../server/stalled.ts';

function agent(id = 'parent', hostId = 'mini', extra: Partial<StalledAgent> = {}): StalledAgent {
  return { id, hostId, title: '订单开发', status: 'idle', updatedAt: '2026-11-07T01:00:00Z', ...extra };
}
function fixture() {
  const state = { agents: [agent()], listeners: new Set<string>(), busy: new Set<string>(), messageCalls: 0, unavailable: false, subagentFailure: false, messageFailure: false };
  const port: StalledPort = {
    collect: async () => { if (state.unavailable) throw new Error('跨主机状态无法确认'); return { hostId: 'mini', agents: state.agents, listeners: state.listeners }; },
    subagents: async current => { if (state.subagentFailure) throw new Error('子代理读取失败'); return state.busy.has(current.id); },
    message: async () => { state.messageCalls++; if (state.messageFailure) throw new Error('时间线读取失败'); return '已完成接口，等待下一步。'; },
    current: async current => state.agents.find(item => item.id === current.id && item.hostId === current.hostId) ?? null,
  };
  return { state, port, runtime: new StalledRuntime(port) };
}

test('停滞主会话显示最后消息并缓存，更新后重读，恢复工作后移出', async () => {
  const { state, runtime } = fixture();
  assert.equal((await runtime.snapshot()).sessions[0].lastMessage, '已完成接口，等待下一步。');
  await runtime.snapshot(); assert.equal(state.messageCalls, 1);
  state.agents[0].updatedAt = '2026-11-07T01:00:01Z';
  await runtime.snapshot(); assert.equal(state.messageCalls, 2);
  state.agents[0].status = 'running';
  assert.deepEqual((await runtime.snapshot()).sessions, []);
});

test('运行、初始化、活动轮次、待审批、内部、已关闭和归档会话均不算停滞', async () => {
  for (const extra of [{ status: 'running' }, { status: 'initializing' }, { activeTurn: {} }, { pendingPermissions: [{}] }, { internal: true }, { status: 'closed' }, { archivedAt: '2026-11-07T01:00:01Z' }, { labels: { 'paseo.parent-agent-id': 'another' } }]) {
    const { state, runtime } = fixture(); state.agents = [agent('parent', 'mini', extra)];
    assert.deepEqual((await runtime.snapshot()).sessions, [], JSON.stringify(extra));
  }
});

test('跨主机子孙会话工作或有监听时，主会话不算停滞', async () => {
  const { state, runtime } = fixture();
  state.agents.push(agent('child', 'book', { labels: { 'paseo.parent-agent-id': 'parent', 'paseo.parent-server-id': 'mini' } }));
  state.agents.push(agent('grandchild', 'book', { status: 'running', labels: { 'paseo.parent-agent-id': 'child' } }));
  assert.deepEqual((await runtime.snapshot()).sessions, []);
  state.agents[2].status = 'idle'; state.listeners.add('book:child');
  assert.deepEqual((await runtime.snapshot()).sessions, []);
  state.listeners.clear(); assert.equal((await runtime.snapshot()).sessions.length, 1);
  state.listeners.add('mini:parent'); assert.deepEqual((await runtime.snapshot()).sessions, []);
});

test('原生子代理工作时不列为停滞，主机或子代理读取失败也不能当作没有工作', async () => {
  const { state, runtime } = fixture();
  state.busy.add('parent'); assert.deepEqual((await runtime.snapshot()).sessions, []);
  state.busy.clear(); state.subagentFailure = true;
  const failed = await runtime.snapshot(); assert.deepEqual(failed.sessions, []); assert.match(failed.error!, /无法确认/);
  state.subagentFailure = false; state.unavailable = true;
  const disconnected = await runtime.snapshot(); assert.deepEqual(disconnected.sessions, []); assert.match(disconnected.error!, /跨主机/);
});

test('最后消息读取失败仍展示明确原因，下一次扫描恢复消息', async () => {
  const { state, runtime } = fixture(); state.messageFailure = true;
  const failed = await runtime.snapshot(); assert.equal(failed.sessions[0].lastMessage, null); assert.match(failed.sessions[0].messageError!, /读取失败/);
  state.messageFailure = false;
  assert.equal((await runtime.snapshot()).sessions[0].lastMessage, '已完成接口，等待下一步。');
});

test('读取消息期间主会话重新工作，不能发布旧的停滞卡片', async () => {
  const { state, port, runtime } = fixture();
  port.message = async () => { state.agents[0].activeTurn = {}; return '旧消息'; };
  assert.deepEqual((await runtime.snapshot()).sessions, []);
});
