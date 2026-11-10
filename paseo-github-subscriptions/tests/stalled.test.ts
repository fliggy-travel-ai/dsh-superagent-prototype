import test from 'node:test';
import assert from 'node:assert/strict';
import { StalledRuntime, type StalledAgent, type StalledPort } from '../server/stalled.ts';
import { parseWorkspaceRoles } from '../server/core/session-roles.ts';

function agent(id = 'parent', hostId = 'mini', extra: Partial<StalledAgent> = {}): StalledAgent {
  return { id, hostId, title: '订单开发', workspaceId: 'wks_main', status: 'idle', updatedAt: '2026-11-07T01:00:00Z', ...extra };
}
function fixture() {
  const state = { roles: parseWorkspaceRoles([{ workspaceId: 'wks_main', pinnedAt: '2026-11-03T00:00:00Z' }]), agents: [agent()], listeners: new Set<string>(), busy: new Set<string>(), messageCalls: 0, unavailable: false, subagentFailure: false, messageFailure: false };
  const port: StalledPort = {
    collect: async () => { if (state.unavailable) throw new Error('跨主机状态无法确认'); return { hostId: 'mini', agents: state.agents, listeners: state.listeners, roles: state.roles }; },
    subagents: async current => { if (state.subagentFailure) throw new Error('子代理读取失败'); return state.busy.has(current.id); },
    message: async () => { state.messageCalls++; if (state.messageFailure) throw new Error('时间线读取失败'); return '已完成接口，等待下一步。'; },
    current: async current => state.agents.find(item => item.id === current.id && item.hostId === current.hostId) ?? null,
    liveIds: async () => new Set(state.agents.filter(item => item.hostId === 'mini' && !item.archivedAt && ['idle', 'error'].includes(item.status)).map(item => item.id)),
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
  for (const extra of [{ status: 'running' }, { status: 'initializing' }, { activeTurn: {} }, { pendingPermissions: [{}] }, { internal: true }, { status: 'closed' }, { archivedAt: '2026-11-07T01:00:01Z' }, { workspaceId: 'wks_other' }, { workspaceId: null }]) {
    const { state, runtime } = fixture(); state.agents = [agent('parent', 'mini', extra)];
    assert.deepEqual((await runtime.snapshot()).sessions, [], JSON.stringify(extra));
  }
});

test('主会话只看置顶工作区：带父会话标签的会话在置顶工作区中也检查，不在置顶工作区的无父会话会话不检查', async () => {
  const { state, runtime } = fixture();
  state.agents = [
    agent('child-in-pinned', 'mini', { labels: { 'paseo.parent-agent-id': 'another' } }),
    agent('loose', 'mini', { workspaceId: 'wks_temp' }),
  ];
  assert.deepEqual((await runtime.snapshot()).sessions.map(session => session.agentId), ['child-in-pinned']);
  state.roles = parseWorkspaceRoles([]);
  assert.deepEqual((await runtime.snapshot()).sessions, []);
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

test('已展示会话归档后移除，其他候选慢读期间归档也不能发布', async () => {
  const { state, port, runtime } = fixture();
  assert.equal((await runtime.snapshot()).sessions.length, 1);
  state.agents[0] = { ...state.agents[0], archivedAt: '2026-11-08T06:03:14Z', status: 'closed' };
  assert.deepEqual((await runtime.snapshot()).sessions, []);
  state.agents = [agent('fast'), agent('slow')];
  let finishSlow!: (message: string) => void;
  const waiting = new Promise<string>(resolve => { finishSlow = resolve; });
  port.message = async current => current.id === 'slow' ? waiting : '快速会话的旧消息';
  const scan = runtime.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  state.agents[0] = { ...state.agents[0], archivedAt: '2026-11-08T06:04:00Z', status: 'closed' };
  finishSlow('较慢会话的消息');
  assert.deepEqual((await scan).sessions.map(session => session.agentId), ['slow']);
});

test('发布前无法核对本机会话状态时不返回旧卡片', async () => {
  const { port, runtime } = fixture();
  port.liveIds = async () => { throw new Error('本机断开'); };
  const result = await runtime.snapshot();
  assert.deepEqual(result.sessions, []);
  assert.match(result.error!, /无法核对会话是否已归档/);
});

test('1737-todo-latency：慢远端端口下 snapshot 立即返回，后台扫描完成后返回结果并附带 scannedAt 与 timings', async () => {
  const { state, port, runtime } = fixture();
  let releaseCollect!: () => void;
  port.collect = async () => {
    await new Promise<void>(resolve => { releaseCollect = resolve; });
    return { hostId: 'mini', agents: state.agents, listeners: state.listeners, roles: state.roles };
  };

  const t0 = Date.now();
  const first = await runtime.snapshot();
  assert.ok(Date.now() - t0 < 300, '首次遇到慢端口时 snapshot 应立即返回空快照而不阻塞等待整轮扫描');
  assert.deepEqual(first.sessions, []);
  assert.equal(first.scannedAt, null);

  releaseCollect();
  await new Promise(resolve => setTimeout(resolve, 30));

  // 下一次扫描再次挂起，但 snapshot 应立即返回上一次后台完成的快照
  let releaseSecond!: () => void;
  port.collect = async () => {
    await new Promise<void>(resolve => { releaseSecond = resolve; });
    return { hostId: 'mini', agents: state.agents, listeners: state.listeners, roles: state.roles };
  };
  const t1 = Date.now();
  const second = await runtime.snapshot();
  assert.ok(Date.now() - t1 < 300, '后台已有扫描结果时慢端口下 snapshot 应立即返回');
  assert.deepEqual(second.sessions.map(s => s.agentId), ['parent']);
  assert.equal(typeof second.scannedAt, 'string');
  assert.equal(typeof second.timings?.collectMs, 'number');
  assert.equal(typeof second.timings?.totalMs, 'number');
  releaseSecond?.();
  runtime.stop();
});

test('1737-todo-latency：本机会话变为 running、activeTurn 或有待批权限后，下一次 snapshot 立即剔除不等慢扫描', async () => {
  const { state, port, runtime } = fixture();
  const initial = await runtime.snapshot();
  assert.deepEqual(initial.sessions.map(s => s.agentId), ['parent']);

  const blockCollect = () => {
    let release!: () => void;
    port.collect = async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { hostId: 'mini', agents: state.agents, listeners: state.listeners, roles: state.roles };
    };
    return async () => {
      port.collect = async () => ({ hostId: 'mini', agents: state.agents, listeners: state.listeners, roles: state.roles });
      release?.();
      await new Promise(resolve => setImmediate(resolve));
    };
  };

  // 1. status 变为 running，即使跨主机 collect 卡住也立即剔除
  let unblock = blockCollect();
  state.agents[0].status = 'running';
  const t0 = Date.now();
  const afterRunning = await runtime.snapshot();
  assert.ok(Date.now() - t0 < 300, '剔除已运行的本机会话不应等待慢扫描');
  assert.deepEqual(afterRunning.sessions, []);
  await unblock();

  // 2. 恢复 idle 后再测 activeTurn
  state.agents[0].status = 'idle';
  assert.equal((await runtime.snapshot()).sessions.length, 1);

  unblock = blockCollect();
  state.agents[0].activeTurn = { id: 'turn-1' };
  assert.deepEqual((await runtime.snapshot()).sessions, []);
  await unblock();

  // 3. 恢复后再测 pendingPermissions
  delete state.agents[0].activeTurn;
  assert.equal((await runtime.snapshot()).sessions.length, 1);

  unblock = blockCollect();
  state.agents[0].pendingPermissions = [{ id: 'perm-1' }];
  assert.deepEqual((await runtime.snapshot()).sessions, []);
  await unblock();
});

test('1737-todo-latency 审阅修复：超过 60 秒无 snapshot 请求自动暂停后台扫描，下次请求恢复；MainServices 异步等待期间暂停不会重新挂上定时器', async () => {
  const { port } = fixture();
  let nowMs = 1_000;
  let collectCount = 0;
  const origCollect = port.collect;
  port.collect = async () => {
    collectCount += 1;
    return origCollect();
  };

  const runtime = new StalledRuntime(port, {
    now: () => nowMs,
    scanIntervalMs: 25,
    idlePauseMs: 60_000,
    cacheTtlMs: 10,
  } as any);

  runtime.start();
  await runtime.snapshot();
  const afterInitial = collectCount;
  assert.ok(afterInitial >= 1);

  // 推进时间超过 60 秒空闲阈值，不再调用 snapshot：定时器下一次触发时应自动暂停，不再持续扫描
  nowMs += 65_000;
  await new Promise(resolve => setTimeout(resolve, 40));
  const countAfterIdlePause = collectCount;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(collectCount, countAfterIdlePause, '超过 60 秒无 snapshot 请求后后台定时扫描应自动暂停');

  // 再次请求 snapshot 时应恢复扫描并重挂后台定时器
  nowMs += 1_000;
  await runtime.snapshot();
  assert.ok(collectCount > countAfterIdlePause, '再次调用 snapshot 时应恢复扫描');
  runtime.stop();

  // 验证 MainServices.stalledSnapshot 在异步等待 ready 期间遭遇暂停（stalledPaused = true）时，不会在等待结束后重新启动定时器或执行扫描
  const { MainServices } = await import('../server/core/services.ts');
  let releaseReady!: () => void;
  const readyPromise = new Promise<void>(resolve => {
    releaseReady = resolve;
  });
  let readyFetchCalls = 0;
  const fakeClient = {
    getLastServerInfoMessage: () => ({ serverId: 'mini' }),
    listHosts: async () => ({ self: { serverId: 'mini', label: 'Mini' }, hosts: [] }),
    fetchAgents: async () => {
      readyFetchCalls += 1;
      return { entries: [], pageInfo: { hasMore: false } };
    },
    scheduleList: async () => ({ schedules: [] }),
  };
  const fakeDaemon = {
    ready: async () => {
      await readyPromise;
      return { client: fakeClient, paseo: {} };
    },
  };
  const services = new MainServices('/tmp', fakeDaemon as any, '/tmp');
  const pendingSnap = services.stalledSnapshot({ modules: { 'todo.stalled': true, github: false } });
  await new Promise(resolve => setImmediate(resolve));

  // 在 daemon.ready() 尚未完成时触发暂停
  services.stalledPaused = true;
  services.invalidateStalledCache();
  releaseReady();

  const pausedSnap = await pendingSnap;
  assert.deepEqual(pausedSnap.sessions, []);
  assert.equal(readyFetchCalls, 0, '异步等待期间已暂停时不应再启动扫描');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((services as any).stalled?.timer ?? null, null, '异步等待期间已暂停时不应遗留运行中的后台定时器');
  await services.stop();
});
