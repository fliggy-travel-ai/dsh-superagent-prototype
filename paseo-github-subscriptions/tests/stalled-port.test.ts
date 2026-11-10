import test from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { PresenceHosts } from '../server/presence-port.ts';
import { stalledPort } from '../server/stalled-port.ts';
import type { StalledAgent } from '../server/stalled.ts';
import { parseWorkspaceRoles } from '../server/core/session-roles.ts';

const parent: StalledAgent = { id: 'parent', hostId: 'mini', workspaceId: 'wks_main', title: null, status: 'idle', updatedAt: '2026-11-07T00:00:00Z' };
function fixture() {
  const state = {
    now: Date.parse('2026-11-10T06:00:00Z'),
    rolesFailed: false,
    shadow: false,
    failed: false,
    remoteStatus: 'online' as 'online' | 'offline',
    remoteListCalls: 0,
    localAgents: [{ ...parent }] as StalledAgent[],
    timeline: [] as Record<string, unknown>[],
    calls: [] as unknown[],
    schedules: [] as unknown[],
  };
  const subscription = { id: 'subscription', agentId: 'child', workspaceId: null, agentTitle: null, parentAgentId: null, key: 'test', scope: 'repo', owner: 'test', repo: 'test', number: null, isPr: null, title: null, events: ['comment'], note: null, createdAt: '', updatedAt: '', expiresAt: null, lastEventAt: null, lastEventId: null, delivered: 0, lastDelivery: null };
  const remote = {
    fetchAgents: async () => { state.remoteListCalls++; return { entries: [{ agent: { ...parent, id: 'child', workspaceId: null } }], pageInfo: { hasMore: false } }; },
    scheduleList: async () => ({ schedules: state.schedules }),
    invokePluginRpc: async () => {
      if (state.failed) throw new Error('远端订阅不可用');
      return { preferences: { enabled: true, shadow: state.shadow }, subscriptions: [subscription], events: [], deliveries: [], repositories: [], token: { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null }, polling: false, lastPollAt: null, toolInjection: false, error: null, intervalSeconds: 60 };
    },
  };
  const origin = {
    getLastServerInfoMessage: () => ({ serverId: 'mini' }),
    listHosts: async () => ({ self: { serverId: 'mini' }, hosts: [{ enabled: true, serverId: 'book', label: 'MacBook', status: state.remoteStatus }] }),
    fetchAgents: async () => ({ entries: state.localAgents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    scheduleList: async () => ({ schedules: [] }),
    fetchAgentTimeline: async (_id: string, options: unknown) => { state.calls.push(options); return state.timeline.shift(); },
  } as unknown as DaemonClient;
  const hosts = { withHost: async (_id: string, operation: (client: unknown) => Promise<unknown>) => operation(remote) } as unknown as PresenceHosts;
  const roles = { read: async () => { if (state.rolesFailed) throw new Error('工作区状态无法读取'); return parseWorkspaceRoles([{ workspaceId: 'wks_main', pinnedAt: 'x' }]); } };
  return { state, port: (stalledPort as any)(origin, hosts, () => ['local-listener'], roles, { now: () => state.now }) as ReturnType<typeof stalledPort> };
}

test('远端有效 GitHub 订阅与 heartbeat 纳入监听，暂停和过期任务不算，读取失败必须报错', async () => {
  const { state, port } = fixture();
  const schedule = { status: 'active', target: { type: 'agent', agentId: 'heartbeat' }, nextRunAt: '2099-01-01T00:00:00Z' };
  state.schedules = [schedule, { ...schedule, target: { type: 'agent', agentId: 'paused' }, status: 'paused' }, { ...schedule, target: { type: 'agent', agentId: 'expired' }, expiresAt: '2000-01-01T00:00:00Z' }];
  const collected = await port.collect();
  assert.deepEqual([...collected.listeners].sort(), ['book:child', 'book:heartbeat', 'mini:local-listener']);
  assert.equal(collected.agents[1].hostId, 'book');
  state.now += 61_000;
  state.shadow = true; assert.equal((await port.collect()).listeners.has('book:child'), false);
  state.now += 61_000;
  state.failed = true; await assert.rejects(port.collect(), /远端订阅不可用/);
});

test('1737-todo-latency：本机无候选主会话时不跨主机读取；远端缓存命中、离线沿用缓存与过期上限报错', async () => {
  const { state, port } = fixture();
  const schedule = { status: 'active', target: { type: 'agent', agentId: 'heartbeat' }, nextRunAt: '2099-01-01T00:00:00Z' };
  state.schedules = [schedule];

  // 1. 本机主会话正在 running，没有候选停滞主会话 -> 不跨主机读取
  state.localAgents = [{ ...parent, status: 'running' }];
  const localOnly = await port.collect();
  assert.equal(state.remoteListCalls, 0, '本机没有候选主会话时不应跨主机拉取');
  assert.equal(localOnly.agents.length, 1);

  // 2. 本机主会话变为 idle -> 首次跨主机拉取并写入缓存
  state.localAgents = [{ ...parent, status: 'idle' }];
  const first = await port.collect();
  assert.equal(state.remoteListCalls, 1);
  assert.equal(first.listeners.has('book:child'), true);

  // 3. 20 秒内再次 collect -> 命中远端缓存，不重复跨主机拉取
  state.now += 20_000;
  const cached = await port.collect();
  assert.equal(state.remoteListCalls, 1, '缓存有效期内不应重复请求远端主机');
  assert.equal(cached.listeners.has('book:child'), true);

  // 4. 50 秒时（超过 45 秒常规 TTL，但未超 60 秒离线缓存上限）远端主机离线 -> 沿用缓存不抛错
  state.now += 30_000;
  state.remoteStatus = 'offline';
  const offlineCached = await port.collect();
  assert.equal(state.remoteListCalls, 1);
  assert.equal(offlineCached.listeners.has('book:child'), true);

  // 5. 超过 60 秒离线缓存上限且远端仍离线 -> 明确报错不判定停滞
  state.now += 15_000;
  await assert.rejects(port.collect(), /有来源主机离线/);
});

test('1737-todo-latency 审阅修复：缓存时间记读取开始时刻；候选主会话 updatedAt 晚于缓存时间时绕过缓存，且离线或读取失败回退分支必须抛错不误判停滞', async () => {
  const { state, port } = fixture();
  const schedule = { status: 'active', target: { type: 'agent', agentId: 'heartbeat' }, nextRunAt: '2099-01-01T00:00:00Z' };
  state.schedules = [schedule];

  // 1. 首次读取远端耗时 4 秒（开始时刻 t0 = 06:00:00Z，完成时刻 t0 + 4s = 06:00:04Z）
  const baseMs = state.now;
  state.localAgents = [{ ...parent, status: 'idle', updatedAt: new Date(baseMs - 10_000).toISOString() }];
  let advanceDuringFetch = 4_000;
  const origInvoke = state;
  const origWithHost = (port as any);
  void origInvoke;
  void origWithHost;

  // 在读取期间推进 state.now，模拟远端读取耗时 4 秒
  const { state: s2, port: p2 } = (() => {
    const f = fixture();
    f.state.schedules = [schedule];
    return f;
  })();
  const startMs = s2.now;
  s2.localAgents = [{ ...parent, status: 'idle', updatedAt: new Date(startMs - 5_000).toISOString() }];
  const origRolesRead = s2;
  void origRolesRead;

  // 首次 collect：让 state.now 在 scheduleList 之后但缓存写入前推进 4 秒
  let delayApplied = false;
  const customOrigin = {
    getLastServerInfoMessage: () => ({ serverId: 'mini' }),
    listHosts: async () => ({ self: { serverId: 'mini' }, hosts: [{ enabled: true, serverId: 'book', label: 'MacBook', status: s2.remoteStatus }] }),
    fetchAgents: async () => ({ entries: s2.localAgents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    scheduleList: async () => ({ schedules: [] }),
  } as unknown as DaemonClient;
  const customRemote = {
    fetchAgents: async () => {
      s2.remoteListCalls++;
      if (!delayApplied) {
        delayApplied = true;
        s2.now += advanceDuringFetch;
      }
      return { entries: [{ agent: { ...parent, id: 'child', workspaceId: null } }], pageInfo: { hasMore: false } };
    },
    scheduleList: async () => ({ schedules: s2.schedules }),
    invokePluginRpc: async () => {
      if (s2.failed) throw new Error('远端订阅不可用');
      return {
        preferences: { enabled: true, shadow: false },
        subscriptions: [],
        events: [],
        deliveries: [],
        repositories: [],
        token: { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null },
        polling: false,
        lastPollAt: null,
        toolInjection: false,
        error: null,
        intervalSeconds: 60,
      };
    },
  };
  const customHosts = { withHost: async (_id: string, op: (client: unknown) => Promise<unknown>) => op(customRemote) } as unknown as PresenceHosts;
  const customRoles = { read: async () => parseWorkspaceRoles([{ workspaceId: 'wks_main', pinnedAt: 'x' }]) };
  const customPort = stalledPort(customOrigin, customHosts, () => [], customRoles, { now: () => s2.now });

  await customPort.collect();
  assert.equal(s2.remoteListCalls, 1);

  // 2. 主会话在远端读取开始后 1 秒（startMs + 1000，早于读取完成时刻 startMs + 4000）派出子会话使 updatedAt 更新：
  //    因为缓存时间记录的是读取开始时刻 startMs，所以 updatedAt (startMs + 1000) > cached.at (startMs)，应绕过缓存重读！
  s2.localAgents = [{ ...parent, status: 'idle', updatedAt: new Date(startMs + 1_000).toISOString() }];
  await customPort.collect();
  assert.equal(s2.remoteListCalls, 2, '读取期间更新的候选主会话 updatedAt 晚于读取开始时刻，必须绕过缓存重读远端');

  // 3. 主会话再次更新（updatedAt 晚于最新缓存时间），此时远端主机变为 offline（仍在 60s 内）：
  //    绝不能用旧缓存判定停滞，必须抛错！
  const afterSecondFetchMs = s2.now;
  s2.localAgents = [{ ...parent, status: 'idle', updatedAt: new Date(afterSecondFetchMs + 2_000).toISOString() }];
  s2.now = afterSecondFetchMs + 5_000;
  s2.remoteStatus = 'offline';
  await assert.rejects(
    customPort.collect(),
    /有来源主机离线/,
    '候选主会话 updatedAt 晚于缓存时间且主机离线时，必须抛错不判定停滞',
  );

  // 4. 主机恢复 online，但远端读取报错，且候选主会话 updatedAt 仍晚于缓存时间：
  //    同样绝不能回退旧缓存，必须抛错！
  s2.remoteStatus = 'online';
  s2.failed = true;
  await assert.rejects(
    customPort.collect(),
    /读取主机“MacBook”的工作状态失败/,
    '候选主会话 updatedAt 晚于缓存时间且远端读取失败时，必须抛错不回退旧缓存',
  );
  void p2;
});

test('置顶状态随采集返回；读取失败必须报错，不能当作没有主会话', async () => {
  const { state, port } = fixture();
  assert.deepEqual([...(await port.collect()).roles.pinned], ['wks_main']);
  state.rolesFailed = true; await assert.rejects(port.collect(), /工作区状态无法读取/);
});

test('助手消息位于工具记录之前时继续分页，游标异常明确报错', async () => {
  const { state, port } = fixture();
  state.timeline = [{ entries: [], hasOlder: true, startCursor: { epoch: 'epoch', seq: 100 } }, { entries: [{ item: { type: 'assistant_message', text: '最后的助手消息' } }], hasOlder: false }];
  assert.equal(await port.message(parent), '最后的助手消息');
  assert.equal((state.calls[1] as { direction: string }).direction, 'before');
  state.timeline = [{ entries: [], hasOlder: true, staleCursor: true }];
  await assert.rejects(port.message(parent), /时间线发生变化/);
  state.timeline = [{ entries: [], hasOlder: true, startCursor: null }];
  await assert.rejects(port.message(parent), /未找到助手消息/);
});

test('远程连接失败后下次重新建路由，不永久缓存失败', async () => {
  let attempts = 0;
  const origin = { openHostRoute: async () => { attempts++; throw new Error('临时路由失败'); } } as unknown as DaemonClient;
  const hosts = new PresenceHosts(origin);
  await assert.rejects(hosts.withHost('book', async () => true), /临时路由失败/);
  await assert.rejects(hosts.withHost('book', async () => true), /临时路由失败/);
  assert.equal(attempts, 2);
  await hosts.stop();
});

test('跨主机路由建立超过五秒时继续等待主机结果', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const origin = {
    openHostRoute: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('主机返回的结果')), 9000)),
    cancelHostRoute: () => { cancelled = true; },
  } as unknown as DaemonClient;
  const hosts = new PresenceHosts(origin);
  const checked = assert.rejects(hosts.withHost('book', async () => true), /主机返回的结果/);
  context.mock.timers.tick(9000);
  await checked;
  assert.equal(cancelled, false);
  await hosts.stop();
});

test('语音建立路由超时后不缓存失败连接', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const origin = {
    openHostRoute: () => { attempts++; return new Promise(() => {}); },
    cancelHostRoute: () => {},
  } as unknown as DaemonClient;
  const hosts = new PresenceHosts(origin);
  for (let attempt = 0; attempt < 2; attempt++) {
    const checked = assert.rejects(hosts.withHost('book', async () => true, true), /来源主机响应超时/);
    context.mock.timers.tick(20_000);
    await checked;
  }
  assert.equal(attempts, 2);
  await hosts.stop();
});
