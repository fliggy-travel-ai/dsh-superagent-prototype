import test from 'node:test';
import assert from 'node:assert/strict';
import { isAntigravityProvider, outOfTurnState, summarize } from '../shared/out-of-turn.ts';
import { OutOfTurnTracker, type OutOfTurnReport, type StreamEvent } from '../server/modules/answer-quiet-children/out-of-turn.ts';
import { verdictOf } from '../scripts/out-of-turn.ts';
import { Engine, emptyState, type Notice } from '../server/notify/engine.ts';

// 2026-11-23 MacBook 实测（#2258）：后台命令 sleep 60 结束后，Antigravity 在本轮外继续执行第二步。
const TURN = 'acp:8888f1ea';
const PROVIDER = 'antigravity-cy517';
const recorded: Array<[string, StreamEvent]> = [
  ['00:57:09.449', { type: 'turn_started', provider: PROVIDER, turnId: TURN }],
  ['00:57:11.814', { type: 'timeline', provider: PROVIDER, turnId: TURN, item: { type: 'tool_call', callId: 'bg', status: 'running' } }],
  ['00:57:15.795', { type: 'timeline', provider: PROVIDER, turnId: TURN, item: { type: 'assistant_message', text: '已启动', messageId: 'm2' } }],
  ['00:57:16.006', { type: 'timeline', provider: PROVIDER, turnId: TURN, item: { type: 'tool_call', callId: 'bg', status: 'completed' } }],
  ['00:57:16.006', { type: 'turn_completed', provider: PROVIDER, turnId: TURN }],
  ['00:58:20.719', { type: 'timeline', provider: PROVIDER, item: { type: 'tool_call', callId: 'bg', status: 'completed' } }],
  ['00:58:20.719', { type: 'timeline', provider: PROVIDER, item: { type: 'tool_call', callId: 'step2', status: 'running' } }],
  ['00:58:20.728', { type: 'timeline', provider: PROVIDER, item: { type: 'tool_call', callId: 'step2', status: 'completed' } }],
  ['00:58:20.733', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '\n\n第二步', messageId: 'm3' } }],
  ['00:58:20.734', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '完成', messageId: 'm3' } }],
];
const at = (clock: string) => Date.parse(`2026-11-23T${clock}Z`);

function harness(options: { quietMs?: number; runningCapMs?: number } = {}) {
  let now = at('00:57:00.000');
  const timers: Array<{ due: number; fn: () => void; live: boolean }> = [];
  const reports: OutOfTurnReport[] = [];
  const tracker = new OutOfTurnTracker({
    ...options,
    now: () => now,
    setTimer: (fn, ms) => { const timer = { due: now + ms, fn, live: true }; timers.push(timer); return timer; },
    clearTimer: handle => { if (handle) (handle as { live: boolean }).live = false; },
    report: report => reports.push(report),
  });
  const advance = (to: number) => {
    for (;;) {
      const next = timers.filter(timer => timer.live && timer.due <= to).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = next.due; next.live = false; next.fn();
    }
    now = to;
  };
  const feed = (events: Array<[string, StreamEvent]>, agentId = 'child') => {
    for (const [clock, event] of events) { advance(at(clock)); tracker.observe(agentId, event, at(clock)); }
  };
  return { tracker, reports, advance, feed };
}

test('Antigravity 提供方识别包含多账号派生', () => {
  assert.ok(isAntigravityProvider('antigravity'));
  assert.ok(isAntigravityProvider('antigravity-cy517'));
  assert.ok(!isAntigravityProvider('claude-3'));
  assert.ok(!isAntigravityProvider(undefined));
});

test('实测序列：本轮外续跑静默 60 秒后报告一次，带最后一条助手消息', () => {
  const h = harness();
  h.feed(recorded);
  assert.equal(h.reports.length, 0);
  h.advance(at('00:59:20.000'));
  assert.equal(h.reports.length, 0, '静默不满 60 秒不报告');
  h.advance(at('00:59:21.000'));
  assert.equal(h.reports.length, 1);
  const [report] = h.reports;
  assert.equal(report!.agentId, 'child');
  assert.equal(report!.count, 5);
  assert.equal(report!.runningTools, 0);
  assert.equal(report!.lastAssistant, '第二步完成');
  assert.equal(report!.firstAt, '2026-11-23T00:58:20.719Z');
  h.advance(at('01:10:00.000'));
  assert.equal(h.reports.length, 1, '同一段续跑只报告一次');
});

test('本轮内事件、其他提供方和系统错误提示不算续跑', () => {
  const h = harness();
  h.feed(recorded.slice(0, 5));
  h.feed([
    ['00:58:00.000', { type: 'timeline', provider: 'claude-3', item: { type: 'assistant_message', text: '别的提供方' } }],
    ['00:58:01.000', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '[System Error] Provider connection closed' } }],
    ['00:58:02.000', { type: 'timeline', provider: PROVIDER, item: { type: 'user_message', text: '用户' } }],
  ]);
  h.advance(at('01:30:00.000'));
  assert.equal(h.reports.length, 0);
  assert.deepEqual(h.tracker.pending(), []);
});

test('新回合开始时放弃跟踪，由回合结束通知接手', () => {
  const h = harness();
  h.feed(recorded.slice(5, 7));
  h.feed([['00:58:30.000', { type: 'turn_started', provider: PROVIDER, turnId: 'acp:next' }]]);
  h.advance(at('01:30:00.000'));
  assert.equal(h.reports.length, 0);
});

test('有运行中的本轮外工具时继续等待，超过上限后照常报告并注明', () => {
  const h = harness({ quietMs: 60_000, runningCapMs: 5 * 60_000 });
  h.feed([['00:58:00.000', { type: 'timeline', provider: PROVIDER, item: { type: 'tool_call', callId: 'server', status: 'running' } }]]);
  h.advance(at('01:02:00.000'));
  assert.equal(h.reports.length, 0);
  h.advance(at('01:03:00.000'));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0]!.runningTools, 1);
});

test('出现本轮内事件时放弃跟踪（重连时可能漏掉回合开始）', () => {
  const h = harness();
  h.feed(recorded.slice(5, 7));
  h.feed([['00:58:30.000', { type: 'timeline', provider: PROVIDER, turnId: 'acp:next', item: { type: 'reasoning', text: '想' } }]]);
  h.advance(at('01:30:00.000'));
  assert.equal(h.reports.length, 0);
});

test('没有 messageId 的连续助手消息分片拼成一条', () => {
  const h = harness();
  h.feed([
    ['00:58:00.000', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '旧消息' } }],
    ['00:58:01.000', { type: 'timeline', provider: PROVIDER, item: { type: 'tool_call', callId: 'x', status: 'completed' } }],
    ['00:58:02.000', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '第二步' } }],
    ['00:58:02.100', { type: 'timeline', provider: PROVIDER, item: { type: 'assistant_message', text: '完成' } }],
  ]);
  h.advance(at('01:00:00.000'));
  assert.equal(h.reports[0]!.lastAssistant, '第二步完成');
});

test('早于 10 分钟的事件不报告（按事件时间判断）', () => {
  const h = harness();
  h.advance(at('02:00:00.000'));
  h.tracker.observe('child', recorded[8]![1], at('00:58:20.733'));
  h.advance(at('03:00:00.000'));
  assert.equal(h.reports.length, 0);
});

test('快照判定：最后一轮之后的无 turnId 条目', () => {
  const entries = [
    { turnId: TURN, timestamp: '2026-11-23T00:57:16.006Z', item: { type: 'tool_call', callId: 'bg', status: 'completed' } },
    { turnId: null, timestamp: '2026-11-23T00:58:20.728Z', item: { type: 'tool_call', callId: 'step2', status: 'completed' } },
    { turnId: null, timestamp: '2026-11-23T00:58:20.733Z', item: { type: 'assistant_message', text: '\n\n第二步完成' } },
  ];
  const state = outOfTurnState(entries);
  assert.deepEqual(state, { count: 2, lastAt: '2026-11-23T00:58:20.733Z', running: 0, lastAssistant: '第二步完成' });
  assert.equal(verdictOf('idle', state, at('00:58:50.000'), 60), 'out-of-turn-active');
  assert.equal(verdictOf('idle', state, at('01:00:00.000'), 60), 'out-of-turn-done');
  assert.equal(verdictOf('running', state, at('01:00:00.000'), 60), 'in-turn');
  assert.equal(verdictOf('idle', outOfTurnState(entries.slice(0, 1)), at('01:00:00.000'), 60), 'idle');
  // 之前有过本轮外条目，但之后又有新回合：只看最后一轮之后。
  assert.equal(outOfTurnState([...entries, { turnId: 'acp:later', timestamp: '2026-11-23T01:00:00Z', item: { type: 'assistant_message', text: '好' } }]).count, 0);
});

test('摘要保留末尾', () => {
  assert.equal(summarize('短'), '短');
  assert.equal(summarize('一二三四五', 3), '…三四五');
  assert.equal(summarize(null), null);
});

test('子会话的后台续跑结束事件投递给主会话，不像普通完成那样只记录', async () => {
  const sent: Notice[] = [];
  const engine = new Engine({ hostId: 'macbook', machine: 'macbook', delivery: 'live', mains: ['main'], children: { child: { agentId: 'main' } } }, emptyState(), async () => {}, async notice => { sent.push(notice); }, async () => false);
  engine.metadata({ id: 'child', provider: PROVIDER, parentAgentId: 'main' });
  await engine.enqueue('subagent_done', 'child', {}, 'done', { agentId: 'main' });
  await engine.enqueue('background_resumed', 'child', { message: '子会话后台续跑已结束', lastAssistant: '第二步完成' }, 'out-of-turn:child:1', { agentId: 'main' });
  await engine.enqueue('background_resumed', 'child', { message: '重复' }, 'out-of-turn:child:1', { agentId: 'main' });
  await engine.tick();
  assert.deepEqual(sent.map(notice => notice.event), ['background_resumed']);
  assert.equal(sent[0]!.target?.agentId, 'main');
});
