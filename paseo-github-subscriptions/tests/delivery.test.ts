import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import type { GithubEvent, Subscription } from '../shared/model.ts';
import { acceptBatch, Dispatcher, matches, messageFor } from '../server/delivery.ts';
import { Storage } from '../server/storage.ts';

const at = '2026-11-06T12:00:00.000Z';
function subscription(agentId = 'agent-one', number: number | null = 42): Subscription {
  return { id: `sub-${agentId}-${number}`, agentId, workspaceId: 'workspace', agentTitle: '订阅会话', parentAgentId: null,
    key: `owner/repo${number ? `#${number}` : ''}`, scope: number ? 'thread' : 'repo', owner: 'owner', repo: 'repo', number,
    isPr: false, title: '测试', events: ['comment', 'state'], note: null, createdAt: '2026-11-06T11:59:00.000Z', updatedAt: at,
    expiresAt: null, lastEventAt: null, lastEventId: null, delivered: 0, lastDelivery: null };
}
function event(id = 'event-one'): GithubEvent {
  return { id, repo: 'owner/repo', number: 42, isPr: false, title: '测试', type: 'comment', actor: 'bbm9527', at,
    url: `https://github.com/owner/repo/issues/42#issuecomment-${id}`, text: '评论正文', markerAgentId: null };
}
async function fixture(action: (storage: Storage) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ghsub-test-'));
  const storage = new Storage(directory);
  await storage.load();
  try { await action(storage); } finally { await rm(directory, { recursive: true, force: true }); }
}
function daemon(options: { archived?: boolean; provider?: string; status?: string; sendError?: Error; send?: (text: string, input: unknown) => void; refresh?: () => Promise<void> } = {}) {
  return { agents: { ref: () => ({ refresh: async () => { await options.refresh?.(); return { agent: { archivedAt: options.archived ? at : null,
    provider: options.provider ?? 'codex', status: options.status ?? 'running', capabilities: {} } }; },
    send: async (text: string, input: unknown) => { options.send?.(text, input); if (options.sendError) throw options.sendError; } }) } } as unknown as PaseoApi;
}

test('只匹配仓库、对象、事件和登记之后的事件，不按共同账号过滤', () => {
  assert.equal(matches(subscription(), event()), true);
  assert.equal(matches(subscription(), { ...event(), markerAgentId: 'agent-one' }), false);
  assert.equal(matches(subscription(), { ...event(), number: 43 }), false);
  assert.equal(matches(subscription(), { ...event(), at: '2026-11-06T11:00:00Z' }), false);
  assert.equal(matches(subscription('agent-two', null), event()), true);
});

test('相同事件命中多条订阅只发送一次，同轮事件按会话合并', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription(), subscription('agent-one', null)]; });
  await acceptBatch(storage, [event(), event('event-two'), event()], { cursor: 1 }, at);
  assert.equal(storage.state.deliveries.length, 1);
  assert.equal(storage.state.deliveries[0].eventIds.length, 2);
  const sent: unknown[] = [];
  await new Dispatcher(storage, daemon({ send: (text, options) => sent.push({ text, options }) }), String).flush();
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { options: unknown }).options, { activeTurnBehavior: 'steer', messageId: storage.state.deliveries[0].id });
  assert.equal(storage.state.deliveries[0].status, 'delivered');
  assert.equal(storage.state.subscriptions[0].delivered, 2);
}));

test('影子模式保留送达记录，切实发后不补发旧影子事件', () => fixture(async storage => {
  await storage.mutate(state => { state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], {}, at);
  await storage.mutate(state => { state.preferences.shadow = false; });
  let sends = 0;
  await new Dispatcher(storage, daemon({ send: () => { sends++; } }), String).flush();
  assert.equal(sends, 0);
  assert.equal(storage.state.deliveries[0].status, 'shadow');
}));

test('送达结果只更新命中事件的订阅', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription(), subscription('agent-one', 43)]; });
  await acceptBatch(storage, [event()], {}, at);
  await new Dispatcher(storage, daemon(), String).flush();
  assert.equal(storage.state.subscriptions[0].lastDelivery?.ok, true);
  assert.equal(storage.state.subscriptions[1].lastDelivery, null);
  assert.equal(storage.state.subscriptions[1].delivered, 0);
}));

test('读取会话期间停用或切换影子模式后不再发送', async () => {
  for (const preference of ['enabled', 'shadow', 'completed'] as const) {
    await fixture(async storage => {
      await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription()]; });
      await acceptBatch(storage, [event()], {}, at);
      let sends = 0;
      await new Dispatcher(storage, daemon({ send: () => { sends++; }, refresh: async () => {
        await storage.mutate(state => {
          if (preference === 'enabled') state.preferences.enabled = false;
          if (preference === 'shadow') state.preferences.shadow = true;
          if (preference === 'completed') state.deliveries[0].status = 'shadow';
        });
      } }), String).flush();
      assert.equal(sends, 0, preference);
    });
  }
});

test('评论标记和评论登记只拦回写会话，其他订阅者收到', () => fixture(async storage => {
  await storage.mutate(state => { state.subscriptions = [subscription(), subscription('agent-two')]; state.ownComments[event().url] = { agentId: 'agent-one', at }; });
  await acceptBatch(storage, [event()], {}, at);
  assert.deepEqual(storage.state.deliveries.map(delivery => delivery.agentId), ['agent-two']);
}));

test('关闭设置三天到期，重开清除到期', () => fixture(async storage => {
  await storage.mutate(state => { state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [{ ...event(), type: 'state', closed: true }], {}, at);
  assert.equal(storage.state.subscriptions[0].expiresAt, '2026-11-09T12:00:00.000Z');
  await acceptBatch(storage, [{ ...event('reopen'), type: 'state', closed: false }], {}, at);
  assert.equal(storage.state.subscriptions[0].expiresAt, null);
}));

test('关闭不影响整仓库到期，未选择state的线程订阅仍跟随关闭与重开', () => fixture(async storage => {
  await storage.mutate(state => { state.subscriptions = [subscription('agent-one', null), { ...subscription(), events: ['comment'] }]; });
  await acceptBatch(storage, [{ ...event(), type: 'state', closed: true }], {}, at);
  assert.equal(storage.state.subscriptions[0].expiresAt, null);
  assert.equal(storage.state.subscriptions[1].expiresAt, '2026-11-09T12:00:00.000Z');
  await acceptBatch(storage, [{ ...event('reopened'), type: 'state', closed: false }], {}, at);
  assert.equal(storage.state.subscriptions[1].expiresAt, null);
}));

test('取消批次中的部分订阅只移除对应事件，剩余事件用新编号送达', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [{ ...subscription('agent-one', null), events: ['state'] }, subscription()]; });
  await acceptBatch(storage, [{ ...event('closed'), number: 3, type: 'state', closed: true }, event('comment')], {}, at);
  const original = storage.state.deliveries[0].id;
  await storage.mutate(state => { state.subscriptions = state.subscriptions.filter(subscription => subscription.scope === 'repo'); });
  const sent: Array<{ text: string; input: unknown }> = [];
  await new Dispatcher(storage, daemon({ send: (text, input) => sent.push({ text, input }) }), String).flush();
  assert.equal(sent.length, 1);
  const delivered = storage.state.deliveries.find(delivery => delivery.status === 'delivered')!;
  assert.notEqual(delivered.id, original);
  assert.deepEqual(delivered.eventIds, ['closed']);
  assert.equal(storage.state.deliveries[0].status, 'skipped');
  assert.equal(sent[0].text.includes('issuecomment-comment'), false);
}));

test('滚动事件清空后重启仍能按快照送达，清理不会裁掉早期pending', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], {}, at);
  await storage.mutate(state => {
    state.events = [];
    const draft = state.deliveries[0];
    state.deliveries.push(...Array.from({ length: 5001 }, (_, index) => ({ ...draft, id: `completed-${index}`, status: 'delivered' as const })));
  });
  await storage.prune(Date.parse(at));
  assert.equal(storage.state.deliveries.filter(delivery => delivery.status === 'pending').length, 1);
  assert.equal(storage.state.deliveries.length, 5001);
  const restarted = new Storage(storage.directory); await restarted.load();
  let sends = 0;
  await new Dispatcher(restarted, daemon({ send: () => { sends++; } }), String).flush();
  assert.equal(sends, 1);
  assert.equal(restarted.state.subscriptions[0].delivered, 1);
}));

test('整仓库ci只接收默认分支，通知正文不超过20条和4000字符', () => {
  const repo = { ...subscription('agent-one', null), events: ['ci'] as Subscription['events'] };
  assert.equal(matches(repo, { ...event(), type: 'ci' }), false);
  assert.equal(matches(repo, { ...event(), type: 'ci', number: null }), true);
  const text = messageFor(Array.from({ length: 100 }, (_, index) => ({ ...event(String(index)), text: '长'.repeat(500), title: '标题'.repeat(200) })));
  assert.ok(text.length <= 4000);
  assert.ok((text.match(/issuecomment-/g)?.length ?? 0) <= 20);
  assert.match(text, /另有 \d+ 条事件/);
});

test('发送结果未知时停止自动重试', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], {}, at);
  let attempts = 0;
  const dispatcher = new Dispatcher(storage, daemon({ sendError: Object.assign(new Error('agent_request_outcome_unknown'), { code: 'agent_request_outcome_unknown' }), send: () => { attempts++; } }), String);
  await dispatcher.flush(); await dispatcher.flush();
  assert.equal(attempts, 1);
  assert.equal(storage.state.deliveries[0].status, 'unknown');
}));

test('归档会话不发送并取消订阅；已取消对象不因其他订阅残留而发送', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], {}, at);
  await new Dispatcher(storage, daemon({ archived: true, send: () => assert.fail('不能发送') }), String).flush();
  assert.equal(storage.state.subscriptions.length, 0);
  assert.equal(storage.state.deliveries[0].status, 'skipped');
  await storage.mutate(state => { state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event('new')], {}, at);
  await storage.mutate(state => { state.subscriptions = [subscription('agent-one', 100)]; });
  await new Dispatcher(storage, daemon({ send: () => assert.fail('不能发送已取消对象') }), String).flush();
  assert.equal(storage.state.deliveries[1].status, 'skipped');
}));

test('不支持steer的忙会话按提供方设置跳过，默认仍立即发送', () => fixture(async storage => {
  await storage.mutate(state => { state.preferences.shadow = false; state.preferences.providerPolicies.other = 'skip'; state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], {}, at);
  await new Dispatcher(storage, daemon({ provider: 'other', send: () => assert.fail('设置为跳过') }), String).flush();
  assert.equal(storage.state.deliveries[0].status, 'skipped');
  await storage.mutate(state => { state.preferences.providerPolicies.other = 'interrupt'; });
  await acceptBatch(storage, [event('default')], {}, at);
  let sent = false;
  await new Dispatcher(storage, daemon({ provider: 'other', send: () => { sent = true; } }), String).flush();
  assert.equal(sent, true);
}));

test('重启保留游标、事件和稳定发送编号，重复批次不生成新送达记录', () => fixture(async storage => {
  await storage.mutate(state => { state.subscriptions = [subscription()]; });
  await acceptBatch(storage, [event()], { cursor: 'saved' }, at);
  const reopened = new Storage(storage.directory); await reopened.load();
  await acceptBatch(reopened, [event()], { cursor: 'next' }, at);
  assert.equal(reopened.state.deliveries.length, 1);
  assert.equal(reopened.state.deliveries[0].id, storage.state.deliveries[0].id);
  assert.deepEqual(reopened.state.source, { cursor: 'next' });
}));
