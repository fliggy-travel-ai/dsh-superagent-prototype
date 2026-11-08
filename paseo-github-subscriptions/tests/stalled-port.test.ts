import test from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { PresenceHosts } from '../server/presence-port.ts';
import { stalledPort } from '../server/stalled-port.ts';
import type { StalledAgent } from '../server/stalled.ts';

const parent: StalledAgent = { id: 'parent', hostId: 'mini', title: null, status: 'idle', updatedAt: '2026-11-07T00:00:00Z' };
function fixture() {
  const state = { shadow: false, failed: false, timeline: [] as Record<string, unknown>[], calls: [] as unknown[], schedules: [] as unknown[] };
  const subscription = { id: 'subscription', agentId: 'child', workspaceId: null, agentTitle: null, parentAgentId: null, key: 'test', scope: 'repo', owner: 'test', repo: 'test', number: null, isPr: null, title: null, events: ['comment'], note: null, createdAt: '', updatedAt: '', expiresAt: null, lastEventAt: null, lastEventId: null, delivered: 0, lastDelivery: null };
  const remote = {
    fetchAgents: async () => ({ entries: [{ agent: { ...parent, id: 'child' } }], pageInfo: { hasMore: false } }),
    scheduleList: async () => ({ schedules: state.schedules }),
    invokePluginRpc: async () => {
      if (state.failed) throw new Error('远端订阅不可用');
      return { preferences: { enabled: true, shadow: state.shadow }, subscriptions: [subscription], events: [], deliveries: [], repositories: [], token: { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null }, polling: false, lastPollAt: null, toolInjection: false, error: null, intervalSeconds: 60 };
    },
  };
  const origin = {
    getLastServerInfoMessage: () => ({ serverId: 'mini' }),
    listHosts: async () => ({ self: { serverId: 'mini' }, hosts: [{ enabled: true, serverId: 'book', status: 'online' }] }),
    fetchAgents: async () => ({ entries: [{ agent: parent }], pageInfo: { hasMore: false } }),
    scheduleList: async () => ({ schedules: [] }),
    fetchAgentTimeline: async (_id: string, options: unknown) => { state.calls.push(options); return state.timeline.shift(); },
  } as unknown as DaemonClient;
  const hosts = { withHost: async (_id: string, operation: (client: unknown) => Promise<unknown>) => operation(remote) } as unknown as PresenceHosts;
  return { state, port: stalledPort(origin, hosts, () => ['local-listener']) };
}

test('远端有效 GitHub 订阅与 heartbeat 纳入监听，暂停和过期任务不算，读取失败必须报错', async () => {
  const { state, port } = fixture();
  const schedule = { status: 'active', target: { type: 'agent', agentId: 'heartbeat' }, nextRunAt: '2099-01-01T00:00:00Z' };
  state.schedules = [schedule, { ...schedule, target: { type: 'agent', agentId: 'paused' }, status: 'paused' }, { ...schedule, target: { type: 'agent', agentId: 'expired' }, expiresAt: '2000-01-01T00:00:00Z' }];
  const collected = await port.collect();
  assert.deepEqual([...collected.listeners].sort(), ['book:child', 'book:heartbeat', 'mini:local-listener']);
  assert.equal(collected.agents[1].hostId, 'book');
  state.shadow = true; assert.equal((await port.collect()).listeners.has('book:child'), false);
  state.failed = true; await assert.rejects(port.collect(), /远端订阅不可用/);
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
