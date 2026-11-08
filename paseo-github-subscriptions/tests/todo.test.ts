import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoRuntime, type TodoPort } from '../server/todo.ts';
import type { PresenceSnapshot } from '../shared/presence.ts';
import type { BrowserSnapshot } from '../shared/browser.ts';
import type { StalledSnapshot } from '../shared/stalled.ts';
import type { EscalationSnapshot } from '../shared/escalation.ts';
import type { QuietSnapshot } from '../shared/quiet.ts';
import type { TodoLocalSnapshot } from '../shared/todo.ts';

function makeFixture() {
  const now = Date.parse('2026-11-09T06:00:00Z');
  const presence: PresenceSnapshot = {
    settings: { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null },
    observation: { mode: 'online', observedAt: '2026-11-09T05:59:00Z', reason: '蓝牙在场', source: 'bluetooth' },
    hostName: 'Mac mini',
    hosts: [
      { id: 'srv-mini', name: 'Mac mini', online: true },
      { id: 'srv-book', name: 'MacBook', online: true },
    ],
    error: null,
    questions: [
      // 1. 网页提问（应收）
      {
        id: 'q-web-1',
        sessionId: 'sess_web1',
        fingerprint: 'fp-web-1',
        source: 'browser',
        title: '环境 7 · 退款回调测试',
        instanceId: 'inst-7',
        url: 'https://claude.ai/code/session_sess_web1',
        at: '2026-11-09T05:48:00Z',
        state: 'pending',
        reason: '等待回答',
        prompts: [{
          question: '回调失败时如何重试？',
          multiSelect: false,
          options: [
            { label: '指数退避，最多 5 次', description: '', recommended: true },
            { label: '固定间隔 30 秒', description: '', recommended: false },
          ],
        }],
      },
      // 2. 原生提问待答（不应收！在侧栏“需要输入”中处理）
      {
        id: 'q-native-pending',
        sessionId: 'agent-native-1',
        fingerprint: 'fp-native-1',
        source: 'native',
        title: '【整合】原生提问',
        at: '2026-11-09T05:50:00Z',
        state: 'pending',
        reason: '等待回答',
        prompts: [{
          question: '是否继续？',
          multiSelect: false,
          options: [{ label: '继续', description: '', recommended: true }],
        }],
      },
      // 3. 代答未读（应收，同时进入处理记录）
      {
        id: 'q-auto-unread',
        sessionId: 'agent-refund',
        fingerprint: 'fp-auto-1',
        source: 'native',
        title: '【订单退款】联调',
        at: '2026-11-09T05:28:00Z',
        state: 'resolved',
        reason: '离线自动选择推荐项',
        answer: {
          source: 'automatic',
          answers: { '部署环境？': ['预发环境'] },
        },
        prompts: [{
          question: '部署环境？',
          multiSelect: false,
          options: [{ label: '预发环境', description: '', recommended: true }],
        }],
      },
      // 4. 代答已读（不进待办，只进处理记录）
      {
        id: 'q-auto-read',
        sessionId: 'agent-done',
        fingerprint: 'fp-auto-2',
        source: 'native',
        title: '【已读】会话',
        at: '2026-11-09T05:10:00Z',
        state: 'resolved',
        reason: '离线自动选择推荐项',
        answer: {
          source: 'automatic',
          answers: { '确认？': ['是'] },
          readAt: '2026-11-09T05:15:00Z',
        },
        prompts: [{
          question: '确认？',
          multiSelect: false,
          options: [{ label: '是', description: '', recommended: true }],
        }],
      },
    ],
  };

  const browser: BrowserSnapshot = {
    settings: { enabled: true, port: 17373 },
    connected: true,
    error: null,
    bindings: [],
    sessions: [
      // 与 q-web-1 同 sessionId，不应重复报网页等待
      {
        instanceId: 'inst-7',
        instanceName: '环境 7',
        sessionId: 'sess_web1',
        title: '退款回调测试',
        url: 'https://claude.ai/code/session_sess_web1',
        tabCount: 1,
        lastSeenAt: '2026-11-09T05:59:30Z',
        agentId: null,
        groupTitle: '退款回调测试',
        activity: {
          state: 'waiting',
          reason: '等待输入',
          lastMessage: '请回答问题',
          observedAt: '2026-11-09T05:59:30Z',
        },
      },
      // 独立的网页限额等待（应收）
      {
        instanceId: 'inst-12',
        instanceName: '环境 12',
        sessionId: 'sess_web2',
        title: '文档迁移',
        url: 'https://claude.ai/code/session_sess_web2',
        tabCount: 1,
        lastSeenAt: '2026-11-09T05:59:40Z',
        agentId: null,
        groupTitle: '文档迁移',
        activity: {
          state: 'limited',
          reason: '达到用量限制',
          lastMessage: 'Usage limit reached',
          observedAt: '2026-11-09T05:40:00Z',
        },
      },
    ],
    approvals: [
      {
        instanceId: 'inst-7',
        instanceName: '环境 7',
        sessionId: 'sess_web1',
        reservationId: 'res-1',
        digest: 'a'.repeat(64),
        button: 'Allow once',
        at: '2026-11-09T05:42:00.000Z',
        status: 'dismissed',
      },
    ],
  };

  const stalled: StalledSnapshot = {
    sessions: [
      {
        agentId: 'agent-stalled-1',
        title: '【搜索排序】实验',
        since: '2026-11-09T04:00:00Z',
        lastMessage: '主会话没有运行中的轮次，也没有定时唤醒。',
        messageError: null,
      },
    ],
    error: null,
  };

  const escalation: EscalationSnapshot = {
    enabled: true,
    status: 'running',
    error: null,
    delivery: 'live',
    timezone: 'Asia/Singapore',
    immediate: [{ days: 'daily', from: '01:00', to: '09:30' }],
    delayMinutes: 30,
    webhook: { configured: true, hostname: 'hooks.example.net', fingerprint: 'a3f19c07' },
    pendingEvents: [
      {
        id: 'esc-1',
        agentId: 'agent-quota-board',
        sessionTitle: '【额度看板】改版',
        workspaceId: 'ws-1',
        questionText: '是否把每周额度为 0 的账号从下拉列表中隐藏？',
        notifiedAt: '2026-11-09T05:25:00Z',
        delivery: 'live',
      },
    ],
    recentDeliveries: [
      {
        id: 'deliv-1',
        agentId: 'agent-quota-board',
        sessionTitle: '【额度看板】改版',
        summary: '已通知 Grok',
        at: '2026-11-09T05:25:00Z',
        delivery: 'live',
        status: 'delivered',
      },
    ],
  };

  const quiet: QuietSnapshot = {
    enabled: true,
    forwardEvents: true,
    pinnedWorkspaceCount: 5,
    pinnedWorkspaces: [],
    recentHandled: [
      {
        id: 'quiet-1',
        agentId: 'agent-sub-1',
        sessionTitle: '【搜索排序】子任务',
        eventKind: 'completed',
        clearedAttention: true,
        forwardedTo: '【搜索排序】主会话',
        forwardStatus: 'forwarded',
        at: '2026-11-09T05:58:00Z',
      },
    ],
    error: null,
  };

  const remoteSnapshot: TodoLocalSnapshot = {
    hostId: 'srv-book',
    hostName: 'MacBook',
    items: [
      {
        id: 'remote-stall-1',
        type: 'stall',
        label: '停滞会话',
        hostId: 'srv-book',
        hostName: 'MacBook',
        sourceLabel: 'Paseo · MacBook',
        sessionTitle: '【MacBook 主会话】实验',
        at: '2026-11-09T03:00:00Z',
        ageText: '无活动 3 小时',
        text: '主会话没有运行中的轮次。',
        agentId: 'agent-book-1',
      },
    ],
    logs: [
      {
        id: 'remote-log-1',
        at: '2026-11-09T05:55:00Z',
        kind: 'quiet-merge',
        label: '子会话归并',
        hostId: 'srv-book',
        hostName: 'MacBook',
        detail: '【MacBook 子任务】 · 清除提醒，事件转给主会话',
      },
    ],
    accountsNeedingAttention: 1,
  };

  const actions: Array<{ target: string; payload: unknown }> = [];
  let remoteFail = false;

  const port: TodoPort = {
    now: () => now,
    selfHost: async () => ({ id: 'srv-mini', name: 'Mac mini' }),
    hosts: async () => [
      { id: 'srv-mini', name: 'Mac mini', online: true },
      { id: 'srv-book', name: 'MacBook', online: true },
    ],
    presence: async () => presence,
    browser: async () => browser,
    stalled: async () => stalled,
    escalation: async () => escalation,
    quiet: async () => quiet,
    accountsNeedingAttention: async () => 1,
    remoteLocal: async hostId => {
      if (remoteFail) throw new Error(`${hostId} 响应超时`);
      return remoteSnapshot;
    },
    remoteAct: async (hostId, input) => {
      actions.push({ target: `remote:${hostId}`, payload: input });
      return { ok: true, message: '已转发执行' };
    },
    answerQuestion: async input => {
      actions.push({ target: 'local:answer', payload: input });
    },
    markQuestionRead: async input => {
      actions.push({ target: 'local:read', payload: input });
    },
    ackEscalation: async input => {
      actions.push({ target: 'local:ack-escalation', payload: input });
    },
  };

  return {
    port,
    runtime: new TodoRuntime(port),
    actions,
    setRemoteFail(value: boolean) {
      remoteFail = value;
    },
  };
}

test('todo.local 只收网页提问、网页等待、停滞会话、升级事件、代答未读，不收原生提问与原生授权', async () => {
  const { runtime } = makeFixture();
  const local = await runtime.local();
  assert.equal(local.hostId, 'srv-mini');
  assert.equal(local.hostName, 'Mac mini');
  assert.equal(local.accountsNeedingAttention, 1);

  // 检查 4 条本机待办：网页提问、升级事件、网页等待、停滞会话、代答未读（共 5 类）
  assert.deepEqual(
    local.items.map(item => [item.type, item.sessionTitle]),
    [
      ['ask', '环境 7 · 退款回调测试'],
      ['esc', '【额度看板】改版'],
      ['web', '环境 12 · 文档迁移'],
      ['stall', '【搜索排序】实验'],
      ['read', '【订单退款】联调'],
    ],
  );
  // 确认不包含原生待答提问 q-native-pending，也不包含已读代答 q-auto-read
  assert.ok(!local.items.some(item => item.sessionTitle.includes('原生提问')));
  assert.ok(!local.items.some(item => item.sessionTitle.includes('【已读】')));

  // 检查处理记录：包含子会话归并、网页权限点击、离线代答、升级投递
  assert.deepEqual(
    local.logs.map(log => log.kind),
    ['quiet-merge', 'web-approval', 'auto-answer', 'escalation', 'auto-answer'],
  );
});

test('todo.list 合并两台主机待办与处理记录，按类别顺序排列', async () => {
  const { runtime } = makeFixture();
  const merged = await runtime.list();
  assert.equal(merged.warning, null);
  assert.equal(merged.items.length, 6);
  assert.ok(merged.items.some(item => item.hostName === 'Mac mini'));
  assert.ok(merged.items.some(item => item.hostName === 'MacBook'));
  assert.deepEqual(
    merged.hosts.map(h => [h.hostName, h.responded, h.accountsNeedingAttention]),
    [
      ['Mac mini', true, 1],
      ['MacBook', true, 1],
    ],
  );
  // 处理记录合并后按时间倒序排列
  assert.equal(merged.logs[0]?.id, 'quiet:quiet-1');
  assert.equal(merged.logs[1]?.id, 'remote-log-1');
});

test('todo.list 远端主机超时时只返回本机待办并给出明确提示，不抛错', async () => {
  const { runtime, setRemoteFail } = makeFixture();
  setRemoteFail(true);
  const merged = await runtime.list();
  assert.equal(merged.items.length, 5);
  assert.ok(merged.items.every(item => item.hostId === 'srv-mini'));
  assert.equal(merged.warning, 'MacBook 未响应，以下只含 Mac mini 的待办');
  assert.equal(merged.hosts.find(h => h.hostId === 'srv-book')?.responded, false);
});

test('todo.act 本机操作直接执行，跨主机操作经 core/hosts 转发', async () => {
  const { runtime, actions } = makeFixture();
  const res1 = await runtime.act({
    hostId: 'srv-mini',
    action: { type: 'read', questionId: 'q-auto-unread', fingerprint: 'fp-auto-1' },
  });
  assert.equal(res1.ok, true);
  assert.equal(actions[0]?.target, 'local:read');

  const res2 = await runtime.act({
    hostId: 'srv-book',
    action: { type: 'ack-escalation', escalationId: 'esc-remote-1' },
  });
  assert.equal(res2.ok, true);
  assert.equal(actions[1]?.target, 'remote:srv-book');
});
