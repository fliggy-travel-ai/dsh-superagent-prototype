import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('todo.list 按主机 ID 与条目 ID 去重，防止本机当远端时待办翻倍；todo.act 拒绝 local 或未知主机', async () => {
  const { port, actions } = makeFixture();
  const runtime: TodoRuntime = new TodoRuntime({
    ...port,
    hosts: async () => [
      { id: 'srv-mini', name: 'Mac mini', online: true },
      { id: 'srv-book', name: 'MacBook', online: true },
      { id: 'srv-dup', name: 'Mac mini', online: true },
    ],
    remoteLocal: async hostId => {
      if (hostId === 'srv-dup') {
        // 模拟错把本机当远端返回了相同 hostId 或相同条目 ID
        return runtime.local();
      }
      return port.remoteLocal(hostId);
    },
  });

  const merged = await runtime.list();
  const ids = merged.items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, '待办条目 ID 不应重复');
  const logIds = merged.logs.map(l => l.id);
  assert.equal(new Set(logIds).size, logIds.length, '处理记录 ID 不应重复');

  // hostId 为 local、空字符串或未知主机时拒绝执行
  const badLocal = await runtime.act({
    hostId: 'local',
    action: { type: 'read', questionId: 'q-auto-unread', fingerprint: 'fp-auto-1' },
  });
  assert.equal(badLocal.ok, false);

  const badUnknown = await runtime.act({
    hostId: 'srv-unknown',
    action: { type: 'ack-escalation', escalationId: 'esc-1' },
  });
  assert.equal(badUnknown.ok, false);
  assert.equal(actions.length, 0);
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { DeadlineError, HostRouter } from '../server/core/hosts.ts';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { startModules } from '../server/core/modules.ts';
import { resolveInstance } from '../shared/instances.ts';
import { todoModule } from '../server/modules/todo/index.ts';
import { registerMachineSettingsRpcs } from '../server/core/machine-settings-rpc.ts';

test('HostRouter：selfHost 从 listHosts.self 获取固定主机标识；invokePlugin 总超时涵盖建连阶段', async () => {
  let routeCancelled = false;
  const fakeOrigin = {
    getLastServerInfoMessage: () => ({ serverId: 'srv-self-fixed' }),
    listHosts: async () => ({
      self: { serverId: 'srv-self-fixed', label: 'MacBook Pro' },
      hosts: [{ serverId: 'srv-remote', label: 'Mac mini', enabled: true, status: 'online' }],
    }),
    openHostRoute: (_hostId: string, _scope: string) =>
      new Promise<never>(() => {
        // 模拟建连无限挂起
      }),
    cancelHostRoute: () => {
      routeCancelled = true;
    },
  };

  const router = new HostRouter(fakeOrigin as never);
  const self = await router.selfHost();
  assert.deepEqual(self, { id: 'srv-self-fixed', name: 'MacBook Pro', online: true });

  const t0 = Date.now();
  await assert.rejects(
    () => router.invokePlugin('srv-remote', 'todo.local', {}, 60),
    DeadlineError,
  );
  assert.ok(Date.now() - t0 < 1000, 'invokePlugin 应在给定 timeoutMs 内超时而非等待 20 秒建连');
  assert.equal(routeCancelled, true);

  // 审阅项 9：已建连的共用路由在遇到业务异常时不应被关闭，只有传输层断开时才清理重连
  let closedCount = 0;
  let connectedFlag = true;
  const fakeConnectedClient = {
    get isConnected() {
      return connectedFlag;
    },
    invokePluginRpc: async (_pluginId: string, method: string) => {
      if (method === 'business.fail') throw new Error('目标蓝牙设备不存在');
      if (method === 'transport.fail') {
        connectedFlag = false;
        throw new Error('Transport closed');
      }
      return { ok: true };
    },
    close: async () => {
      closedCount++;
    },
  };
  (router as any).remote.set('srv-ok', Promise.resolve(fakeConnectedClient));
  await assert.rejects(() => router.invokePlugin('srv-ok', 'business.fail', {}), /目标蓝牙设备不存在/);
  assert.equal(closedCount, 0, '业务异常不应断开已建立的共用跨主机路由');
  assert.equal((router as any).remote.has('srv-ok'), true);

  await assert.rejects(
    () => router.withHost('srv-ok', async () => { throw new Error('时间线发生变化'); }),
    /时间线发生变化/,
  );
  assert.equal(closedCount, 0, 'withHost 业务异常不应断开已建立的共用跨主机路由');

  await assert.rejects(() => router.invokePlugin('srv-ok', 'transport.fail', {}), /Transport closed/);
  assert.equal(closedCount, 1, '传输层断开时应关闭并移除失效路由');
  assert.equal((router as any).remote.has('srv-ok'), false);

  await router.stop();
});

test('todoModule：已关闭的模块在轮询 todo.local 时不会被唤醒，且升级事件与 services.escalation 共享同一实例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-mod-test-'));
  const machinePath = join(dir, 'machine.json');
  writeFileSync(
    machinePath,
    JSON.stringify({
      version: 1,
      machine: 'macbook',
      modules: {
        'answer.presence': false,
        'answer.browser': false,
        github: false,
        'todo.stalled': false,
        'answer.escalation': true,
        todo: true,
      },
    }),
  );

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  let presenceCalled = 0;
  let browserCalled = 0;
  let githubCalled = 0;
  let ackedIds: string[] = [];

  const fakeHosts = {
    selfHost: async () => ({ id: 'srv-book', name: 'MacBook', online: true }),
    hosts: async () => [{ id: 'srv-book', name: 'MacBook', online: true }],
    invoke: async () => ({}),
  };

  const fakeEscalation = {
    async snapshot() {
      return {
        enabled: true,
        status: 'error' as const,
        error: 'Webhook 未配置',
        delivery: 'shadow' as const,
        timezone: 'Asia/Singapore',
        immediate: [],
        delayMinutes: 0,
        webhook: { configured: false, hostname: null, fingerprint: null },
        pendingEvents: ackedIds.includes('esc-mem-1')
          ? []
          : [
              {
                id: 'esc-mem-1',
                agentId: 'ag-1',
                sessionTitle: '主会话 A',
                workspaceId: 'ws-1',
                questionText: '请确认发布？',
                notifiedAt: '2026-11-09T05:00:00Z',
                delivery: 'shadow' as const,
              },
            ],
        recentDeliveries: [],
      };
    },
    acknowledge(id: string) {
      ackedIds.push(id);
      return true;
    },
  };

  const main = {
    escalation: fakeEscalation,
    quiet: null,
    readyHosts: async () => fakeHosts,
    readyPresence: async () => {
      presenceCalled++;
      throw new Error('不应唤醒已关闭的 answer.presence');
    },
    readyBrowser: async () => {
      browserCalled++;
      throw new Error('不应唤醒已关闭的 answer.browser');
    },
    github: async () => {
      githubCalled++;
      throw new Error('不应唤醒已关闭的 github');
    },
  };

  const machine = loadMachineConfig(machinePath, {});
  startModules([todoModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services: { home: dir, daemon: {} as never, main: main as never },
    stateDirectory: dir,
    baseDirectory: dir,
  });

  const snap1 = await handlers.get('todo.local')!({});
  assert.equal(presenceCalled, 0);
  assert.equal(browserCalled, 0);
  assert.equal(githubCalled, 0);
  assert.equal(snap1.items.length, 1);
  assert.equal(snap1.items[0].escalationId, 'esc-mem-1');

  const actRes = await handlers.get('todo.act')!({
    hostId: 'srv-book',
    action: { type: 'ack-escalation', escalationId: 'esc-mem-1' },
  });
  assert.equal(actRes.ok, true);
  assert.deepEqual(ackedIds, ['esc-mem-1']);

  const snap2 = await handlers.get('todo.local')!({});
  assert.equal(snap2.items.length, 0);
});

test('machine.settings.*：独立于 todo 模块注册，如实反映 modules.status 错误，pause-all 持久且恢复时不误开原本关闭的 GitHub 监听', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-settings-test-'));
  const machinePath = join(dir, 'machine.json');
  writeFileSync(
    machinePath,
    JSON.stringify({
      version: 1,
      machine: 'macbook',
      modules: {
        todo: false,
        'answer.automation': true,
        'answer.presence': true,
        github: true,
        'answer.escalation': true,
        'answer.quietChildren': true,
      },
    }),
  );

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  let autoPaused = false;
  let presencePaused = false;
  let githubEnabled = false; // 原本就是关闭的！
  let escalationEnabled = true;
  let quietEnabled = true;
  let shouldFailAutomation = false;

  const main = {
    escalation: {
      snapshot: async () => ({ enabled: escalationEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) escalationEnabled = patch.enabled;
      },
    },
    quiet: {
      snapshot: async () => ({ enabled: quietEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) quietEnabled = patch.enabled;
      },
    },
    readyAutomation: async () => ({
      snapshot: () => ({ paused: autoPaused }),
      pause: async (p: boolean) => {
        if (shouldFailAutomation) throw new Error('授权模块连接失败');
        autoPaused = p;
      },
    }),
    readyPresence: async () => ({
      snapshot: () => ({ settings: { mode: 'auto', paused: presencePaused, speechEnabled: true, sourceHostId: null } }),
      configure: async (s: { paused: boolean }) => {
        presencePaused = s.paused;
      },
    }),
    github: async () => ({
      storage: { state: { preferences: { enabled: githubEnabled, intervalMinutes: 5, shadow: true } } },
      preferences: async (prefs: { enabled: boolean }) => {
        githubEnabled = prefs.enabled;
      },
    }),
  };

  const failingMod = {
    id: 'usage.providerQuotas',
    label: '其他 Provider 额度',
    defaultEnabled: true,
    appliesTo: () => true,
    register(ctx: any) {
      ctx.fail(new Error('旧插件仍启用'));
    },
  };

  const noopMod = (id: string) => ({
    id,
    label: id,
    defaultEnabled: true,
    appliesTo: () => true,
    register() {},
  });

  const machine = loadMachineConfig(machinePath, {});
  const host = startModules(
    [
      failingMod as never,
      noopMod('answer.automation') as never,
      noopMod('answer.presence') as never,
      noopMod('github') as never,
      noopMod('todo.stalled') as never,
    ],
    {
      server,
      instance: resolveInstance('main'),
      machine,
      services: { home: dir, daemon: {} as never, main: main as never },
      stateDirectory: dir,
      baseDirectory: dir,
    },
  );

  registerMachineSettingsRpcs({
    server,
    machine,
    host,
    services: { home: dir, daemon: {} as never, main: main as never },
    stateDirectory: dir,
    baseDirectory: dir,
  });

  // 即使 todo: false，machine.settings.snapshot 和 defaults.snapshot 依然可用
  assert.ok(handlers.has('machine.settings.snapshot'));
  assert.ok(handlers.has('defaults.snapshot'));

  const snap = await handlers.get('machine.settings.snapshot')!({});
  const quotaMod = snap.modules.find((m: any) => m.id === 'usage.providerQuotas');
  assert.equal(quotaMod?.state, 'error');
  assert.match(quotaMod?.reason ?? '', /旧插件仍启用/);
  assert.ok(snap.modules.every((m: any) => m.reloadRequired === true));

  // 暂停全部自动化
  const pauseRes = await handlers.get('machine.settings.pause-all')!({ paused: true });
  assert.equal(pauseRes.paused, true);
  assert.equal(autoPaused, true);
  assert.equal(presencePaused, true);
  assert.equal(githubEnabled, false);
  assert.equal(escalationEnabled, false);
  assert.equal(quietEnabled, false);

  // 持久化验证：重新读取 snapshot 的 pausedAll 为 true
  const snapPaused = await handlers.get('machine.settings.pause-all') !== undefined
    ? await handlers.get('machine.settings.snapshot')!({})
    : null;
  assert.equal(snapPaused?.pausedAll, true);

  // 恢复全部自动化：原本 githubEnabled=false 不应被强行打开为 true！
  const resumeRes = await handlers.get('machine.settings.pause-all')!({ paused: false });
  assert.equal(resumeRes.paused, false);
  assert.equal(autoPaused, false);
  assert.equal(presencePaused, false);
  assert.equal(githubEnabled, false, '原本关闭的 GitHub 监听恢复后仍应保持关闭');
  assert.equal(escalationEnabled, true);
  assert.equal(quietEnabled, true);

  // 当某个已启用模块暂停失败时，应抛错而不是返回成功，且已暂停的模块应回滚并保留暂停前的值
  shouldFailAutomation = true;
  await assert.rejects(() => handlers.get('machine.settings.pause-all')!({ paused: true }), /授权模块连接失败/);
  assert.equal(presencePaused, false, '部分失败时已暂停的问答模式应回滚到暂停前的未暂停状态');
  assert.equal(escalationEnabled, true, '部分失败时已关闭的升级通知应回滚到暂停前的开启状态');
  assert.equal(quietEnabled, true, '部分失败时已关闭的子会话免提醒应回滚到暂停前的开启状态');

  // 第三轮审阅项 1：失败回滚后 → 用户手动关闭升级通知 → 再次暂停成功 → 恢复，升级通知保持关闭（不被旧 saved 重新打开）
  shouldFailAutomation = false;
  escalationEnabled = false;
  await handlers.get('machine.settings.pause-all')!({ paused: true });
  assert.equal(escalationEnabled, false);
  await handlers.get('machine.settings.pause-all')!({ paused: false });
  assert.equal(escalationEnabled, false, '回滚后手动关闭的升级通知在下次暂停并恢复后仍应保持关闭');

  // 第三轮审阅项 5（服务端）：并发调用 pause-all 串行执行
  const callOrder: string[] = [];
  const origConfigure = main.escalation.configure;
  main.escalation.configure = async (patch: { enabled?: boolean }) => {
    callOrder.push(`esc:${String(patch.enabled)}:start`);
    await new Promise(r => setTimeout(r, 15));
    if (patch.enabled !== undefined) escalationEnabled = patch.enabled;
    callOrder.push(`esc:${String(patch.enabled)}:end`);
  };
  escalationEnabled = true;
  await Promise.all([
    handlers.get('machine.settings.pause-all')!({ paused: true }),
    handlers.get('machine.settings.pause-all')!({ paused: false }),
  ]);
  main.escalation.configure = origConfigure;
  assert.deepEqual(callOrder, ['esc:false:start', 'esc:false:end', 'esc:true:start', 'esc:true:end']);

  // 恢复时：若 pause-all.json 中没有保存 escalationEnabled / quietEnabled（例如从旧文件或未保存项恢复），不应把原本关闭的模块打开
  shouldFailAutomation = false;
  escalationEnabled = false;
  quietEnabled = false;
  writeFileSync(
    join(dir, 'pause-all.json'),
    JSON.stringify({ paused: true, saved: { automationPaused: false } }),
  );
  await handlers.get('machine.settings.pause-all')!({ paused: false });
  assert.equal(escalationEnabled, false, '未保存过的 escalationEnabled 在恢复时不应被默认设为 true');
  assert.equal(quietEnabled, false, '未保存过的 quietEnabled 在恢复时不应被默认设为 true');

  // 第三轮审阅项 3（服务端）：agentDefaults 配置段损坏时，defaults.save 拒绝覆盖保存
  const badDir = mkdtempSync(join(tmpdir(), 'bad-defaults-test-'));
  const badMachinePath = join(badDir, 'machine.json');
  writeFileSync(
    badMachinePath,
    JSON.stringify({
      version: 1,
      modules: { 'providers.defaults': false },
      agentDefaults: [{ provider: '' }],
    }),
  );
  const badHandlers = new Map<string, (input: any) => Promise<any>>();
  const badServer = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      badHandlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;
  const badMachine = loadMachineConfig(badMachinePath, {
    agentDefaults: { schema: (await import('../shared/defaults.ts')).AgentDefaultsSchema, fallback: [] },
  });
  const badHost = startModules([], {
    server: badServer,
    instance: resolveInstance('main'),
    machine: badMachine,
    services: { home: badDir, daemon: {} as never, main: main as never },
    stateDirectory: badDir,
    baseDirectory: badDir,
  });
  registerMachineSettingsRpcs({
    server: badServer,
    machine: badMachine,
    host: badHost,
    services: { home: badDir, daemon: {} as never, main: main as never },
    stateDirectory: badDir,
    baseDirectory: badDir,
  });
  const badSnap = await badHandlers.get('defaults.snapshot')!({});
  assert.ok(badSnap.error, '损坏的 agentDefaults 应在 snapshot.error 中反映');
  await assert.rejects(() => badHandlers.get('defaults.save')!({ enabled: true }), /拒绝/);
});

test('审阅项 4/7/8c：todo.stalled 与 todo 模块共用同一个 StalledRuntime 实例与缓存，pause-all 覆盖停滞检查，todo 轮询看 host.status running', async () => {
  const { stalledModule } = await import('../server/modules/todo-stalled/index.ts');
  const { MainServices } = await import('../server/core/services.ts');
  const dir = mkdtempSync(join(tmpdir(), 'stalled-shared-test-'));
  mkdirSync(join(dir, 'projects'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'workspaces.json'), '[]');
  const machinePath = join(dir, 'machine.json');
  writeFileSync(
    machinePath,
    JSON.stringify({
      version: 1,
      machine: 'macbook',
      modules: {
        'todo.stalled': true,
        todo: true,
        'answer.presence': true,
        'answer.browser': true,
        github: false,
      },
    }),
  );

  let listAgentsCalls = 0;
  const fakeClient = {
    getLastServerInfoMessage: () => ({ serverId: 'srv-self' }),
    listHosts: async () => ({ self: { serverId: 'srv-self', label: 'MacBook' }, hosts: [] }),
    fetchAgents: async () => {
      listAgentsCalls++;
      return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
    },
    scheduleList: async () => ({ schedules: [] }),
  };
  const fakePaseo = {
    agents: {
      list: async () => {
        listAgentsCalls++;
        return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
      },
    },
  };
  const fakeDaemon = {
    ready: async () => ({ client: fakeClient, paseo: fakePaseo, approve: () => {}, respond: () => {} }),
  };
  const main = new MainServices(dir, fakeDaemon as never);
  let presenceCalled = 0;
  (main as any).readyPresence = async () => {
    presenceCalled++;
    return { snapshot: () => ({ settings: { mode: 'online', paused: false, speechEnabled: true, sourceHostId: null }, observation: { mode: 'online', reason: 'ok', updatedAt: new Date().toISOString() }, hosts: [], questions: [] }) };
  };
  (main as any).readyBrowser = async () => ({
    snapshot: () => ({ settings: { enabled: true, port: 17373 }, connected: false, sessions: [], bindings: [], questions: [], approvals: [], extensionPath: dir }),
  });

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  // 模拟 answer.presence 虽然在 machine.json 中是 true，但注册时出错（state === 'error'）
  const failingPresenceMod = {
    id: 'answer.presence',
    label: '问答模式',
    defaultEnabled: true,
    appliesTo: () => true,
    register(ctx: any) {
      ctx.fail(new Error('守护进程异常'));
    },
  };

  const machine = loadMachineConfig(machinePath, {});
  const services = { home: dir, daemon: fakeDaemon as never, main };
  const host = startModules([failingPresenceMod as never, stalledModule, todoModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services,
    stateDirectory: dir,
    baseDirectory: dir,
  });
  registerMachineSettingsRpcs({ server, machine, host, services, stateDirectory: dir, baseDirectory: dir });

  // 1. 先调 todos.stalled，再调 todo.local：共用同一个实例与缓存，agents.list 只跑 1 次！
  await handlers.get('todos.stalled')!({});
  assert.equal(listAgentsCalls, 1);
  await handlers.get('todo.local')!({});
  assert.equal(listAgentsCalls, 1, 'todos.stalled 与 todo.local 应共用同一实例与缓存');

  // 2. answer.presence 在 host.status() 中为 error，todo.local 不应调用 readyPresence
  assert.equal(presenceCalled, 0, '模块 state 不为 running 时不应被 todo.local 调用');

  // 3. pause-all 暂停后，todos.stalled 返回空且不触发新的扫描
  await handlers.get('machine.settings.pause-all')!({ paused: true });
  main.invalidateStalledCache();
  const pausedStalled = await handlers.get('todos.stalled')!({});
  assert.deepEqual(pausedStalled.sessions, []);
  assert.equal(listAgentsCalls, 1, 'pause-all 暂停期间不应扫描停滞会话');

  await host.dispose();
  await main.stop();
});

test('暂停中途崩溃后再次暂停又失败时保留 inProgress 与原值，恢复后回到原值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pause-crash-retry-test-'));
  const machinePath = join(dir, 'machine.json');
  writeFileSync(
    machinePath,
    JSON.stringify({
      version: 1,
      machine: 'macbook',
      modules: {
        'todo.stalled': true,
        'answer.presence': true,
        'answer.escalation': true,
        'answer.quietChildren': true,
        github: true,
        'answer.automation': true,
      },
    }),
  );

  let presencePaused = false;
  let escalationEnabled = true;
  let quietEnabled = true;
  let githubEnabled = true;
  let autoPaused = false;
  let failPresence = false;

  const noopMod = (id: string) => ({
    id,
    label: id,
    defaultEnabled: true,
    appliesTo: () => true,
    register() {},
  });

  const main = {
    stalledPaused: false,
    invalidateStalledCache() {},
    readyPresence: async () => {
      if (failPresence) throw new Error('问答模式读取失败');
      return {
        snapshot: () => ({ settings: { mode: 'online', paused: presencePaused, speechEnabled: true, sourceHostId: null } }),
        configure: async (next: { paused: boolean }) => {
          presencePaused = next.paused;
        },
      };
    },
    escalation: {
      snapshot: async () => ({ enabled: escalationEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) escalationEnabled = patch.enabled;
      },
    },
    quiet: {
      snapshot: async () => ({ enabled: quietEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) quietEnabled = patch.enabled;
      },
    },
    github: async () => ({
      storage: { state: { preferences: { enabled: githubEnabled } } },
      preferences: async (next: { enabled: boolean }) => {
        githubEnabled = next.enabled;
      },
    }),
    readyAutomation: async () => ({
      snapshot: () => ({ paused: autoPaused }),
      pause: async (p: boolean) => {
        autoPaused = p;
      },
    }),
  };

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  const machine = loadMachineConfig(machinePath, {});
  const host = startModules(
    [
      noopMod('todo.stalled') as never,
      noopMod('answer.presence') as never,
      noopMod('answer.escalation') as never,
      noopMod('answer.quietChildren') as never,
      noopMod('github') as never,
      noopMod('answer.automation') as never,
    ],
    {
      server,
      instance: resolveInstance('main'),
      machine,
      services: { home: dir, daemon: {} as never, main: main as never },
      stateDirectory: dir,
      baseDirectory: dir,
    },
  );
  registerMachineSettingsRpcs({
    server,
    machine,
    host,
    services: { home: dir, daemon: {} as never, main: main as never },
    stateDirectory: dir,
    baseDirectory: dir,
  });

  // 模拟暂停中途进程崩溃：升级通知、子会话免提醒、GitHub 监听已关，状态文件留有 inProgress: true 和原值
  escalationEnabled = false;
  quietEnabled = false;
  githubEnabled = false;
  writeFileSync(
    join(dir, 'pause-all.json'),
    JSON.stringify({
      paused: false,
      inProgress: true,
      saved: {
        stalledPaused: false,
        presencePaused: false,
        escalationEnabled: true,
        quietEnabled: true,
        githubEnabled: true,
      },
    }),
  );

  // 再暂停时问答模式读取失败
  failPresence = true;
  await assert.rejects(() => handlers.get('machine.settings.pause-all')!({ paused: true }), /问答模式读取失败/);

  // 状态文件仍保留进行中标记和原值
  const stateAfterFail = JSON.parse(readFileSync(join(dir, 'pause-all.json'), 'utf8'));
  assert.equal(stateAfterFail.inProgress, true, '崩溃后再次暂停失败仍应保留 inProgress 标记');
  assert.equal(stateAfterFail.saved?.escalationEnabled, true);
  assert.equal(stateAfterFail.saved?.quietEnabled, true);
  assert.equal(stateAfterFail.saved?.githubEnabled, true);

  // 恢复后三项回到原值
  failPresence = false;
  await handlers.get('machine.settings.pause-all')!({ paused: false });
  assert.equal(escalationEnabled, true, '恢复后升级通知应回到原值 true');
  assert.equal(quietEnabled, true, '恢复后子会话免提醒应回到原值 true');
  assert.equal(githubEnabled, true, '恢复后 GitHub 监听应回到原值 true');

  await host.dispose();
});

test('已暂停时再次收到暂停请求直接返回，不重新执行、不回滚，开关和状态文件都不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pause-idempotent-test-'));
  const machinePath = join(dir, 'machine.json');
  writeFileSync(
    machinePath,
    JSON.stringify({
      version: 1,
      machine: 'macbook',
      modules: {
        'todo.stalled': true,
        'answer.presence': true,
        'answer.escalation': true,
        'answer.quietChildren': true,
        github: true,
        'answer.automation': true,
      },
    }),
  );

  let presencePaused = false;
  let escalationEnabled = true;
  let quietEnabled = true;
  let githubEnabled = true;
  let autoPaused = false;
  let shouldFailAutomation = false;

  const noopMod = (id: string) => ({
    id,
    label: id,
    defaultEnabled: true,
    appliesTo: () => true,
    register() {},
  });

  const main = {
    stalledPaused: false,
    invalidateStalledCache() {},
    readyPresence: async () => ({
      snapshot: () => ({ settings: { mode: 'online', paused: presencePaused, speechEnabled: true, sourceHostId: null } }),
      configure: async (next: { paused: boolean }) => {
        presencePaused = next.paused;
      },
    }),
    escalation: {
      snapshot: async () => ({ enabled: escalationEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) escalationEnabled = patch.enabled;
      },
    },
    quiet: {
      snapshot: async () => ({ enabled: quietEnabled }),
      configure: async (patch: { enabled?: boolean }) => {
        if (patch.enabled !== undefined) quietEnabled = patch.enabled;
      },
    },
    github: async () => ({
      storage: { state: { preferences: { enabled: githubEnabled } } },
      preferences: async (next: { enabled: boolean }) => {
        githubEnabled = next.enabled;
      },
    }),
    readyAutomation: async () => {
      if (shouldFailAutomation) throw new Error('授权模块连接失败');
      return {
        snapshot: () => ({ paused: autoPaused }),
        pause: async (p: boolean) => {
          autoPaused = p;
        },
      };
    },
  };

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: (input: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  const machine = loadMachineConfig(machinePath, {});
  const host = startModules(
    [
      noopMod('todo.stalled') as never,
      noopMod('answer.presence') as never,
      noopMod('answer.escalation') as never,
      noopMod('answer.quietChildren') as never,
      noopMod('github') as never,
      noopMod('answer.automation') as never,
    ],
    {
      server,
      instance: resolveInstance('main'),
      machine,
      services: { home: dir, daemon: {} as never, main: main as never },
      stateDirectory: dir,
      baseDirectory: dir,
    },
  );
  registerMachineSettingsRpcs({
    server,
    machine,
    host,
    services: { home: dir, daemon: {} as never, main: main as never },
    stateDirectory: dir,
    baseDirectory: dir,
  });

  // 第一次暂停成功
  await handlers.get('machine.settings.pause-all')!({ paused: true });
  assert.equal(presencePaused, true);
  assert.equal(escalationEnabled, false);
  assert.equal(quietEnabled, false);
  assert.equal(githubEnabled, false);
  assert.equal(autoPaused, true);
  const stateBefore = readFileSync(join(dir, 'pause-all.json'), 'utf8');

  // 已暂停时再次暂停且中途模块设置会失败：应直接返回，不重新执行、不回滚
  shouldFailAutomation = true;
  const secondRes = await handlers.get('machine.settings.pause-all')!({ paused: true });
  assert.deepEqual(secondRes, { paused: true });
  assert.equal(presencePaused, true);
  assert.equal(escalationEnabled, false);
  assert.equal(quietEnabled, false);
  assert.equal(githubEnabled, false);
  assert.equal(autoPaused, true);
  assert.equal(readFileSync(join(dir, 'pause-all.json'), 'utf8'), stateBefore);

  await host.dispose();
});
