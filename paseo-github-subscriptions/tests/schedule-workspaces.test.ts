import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { scheduledWorkspace, syncScheduleWorkspace, type ScheduleAgent, type ScheduleWorkspacePort } from '../server/modules/schedule-workspaces/sync.ts';

function fixture() {
  const agent: ScheduleAgent = { workspaceId: 'workspace', labels: { 'paseo.schedule-id': 'schedule' } };
  const schedule = { name: '上游同步分析', target: { type: 'new-agent' } };
  const workspace = { name: '自动生成标题', pinnedAt: null as string | null, archivedAt: null as string | null };
  const calls: string[] = [];
  const port: ScheduleWorkspacePort = {
    schedule: async () => schedule,
    workspace: async () => workspace,
    rename: async (_id, title) => { calls.push(title); workspace.name = title; },
    pin: async () => { calls.push('pin'); workspace.pinnedAt = 'now'; },
  };
  return { agent, schedule, workspace, calls, port };
}

test('定时任务命名并置顶，重复执行不重复写入', async () => {
  const sample = fixture();
  assert.equal(await syncScheduleWorkspace(sample.port, sample.agent), true);
  assert.deepEqual(sample.calls, ['【每日】上游同步分析', 'pin']);
  assert.equal(await syncScheduleWorkspace(sample.port, sample.agent), true);
  assert.equal(sample.calls.length, 2);
});

test('已有和重复的每日前缀只保留一次', async () => {
  for (const name of ['【每日】上游同步分析', ' 【每日】 【每日】上游同步分析 ']) {
    const sample = fixture(); sample.schedule.name = name;
    await syncScheduleWorkspace(sample.port, sample.agent);
    assert.equal(sample.workspace.name, '【每日】上游同步分析');
  }
});

test('工作区显式标题优先于默认名称，已置顶时无需写入', async () => {
  const sample = fixture();
  sample.port.workspace = async () => ({ name: '默认目录名', title: '【每日】上游同步分析', pinnedAt: 'now' });
  assert.equal(await syncScheduleWorkspace(sample.port, sample.agent), true);
  assert.deepEqual(sample.calls, []);
});

test('普通会话、子会话、已归档会话和无工作区会话不处理', () => {
  const agents: ScheduleAgent[] = [
    { workspaceId: 'workspace' },
    { labels: { 'paseo.schedule-id': 'schedule' } },
    { ...fixture().agent, archivedAt: 'now' },
    { workspaceId: 'workspace', labels: { 'paseo.schedule-id': 'schedule', 'paseo.parent-agent-id': 'parent' } },
  ];
  for (const agent of agents) assert.equal(scheduledWorkspace(agent), null);
});

test('删除的任务、心跳、空任务名和已归档工作区不写入', async () => {
  for (const kind of ['deleted', 'heartbeat', 'empty', 'archived', 'missing']) {
    const sample = fixture();
    if (kind === 'deleted') sample.port.schedule = async () => null;
    if (kind === 'heartbeat') sample.schedule.target.type = 'agent';
    if (kind === 'empty') sample.schedule.name = '【每日】';
    if (kind === 'archived') sample.workspace.archivedAt = 'now';
    if (kind === 'missing') sample.port.workspace = async () => null;
    assert.equal(await syncScheduleWorkspace(sample.port, sample.agent), false);
    assert.deepEqual(sample.calls, []);
  }
});

test('置顶失败后允许重试，保留已完成的改名', async () => {
  const sample = fixture(); const pin = sample.port.pin;
  sample.port.pin = async () => { throw Error('连接断开'); };
  await assert.rejects(syncScheduleWorkspace(sample.port, sample.agent), /连接断开/);
  sample.port.pin = pin;
  await syncScheduleWorkspace(sample.port, sample.agent);
  assert.deepEqual(sample.calls, ['【每日】上游同步分析', 'pin']);
});

test('模块启动分页补齐，创建钩子处理新增会话并在停止后解除', async () => {
  const { scheduleWorkspacesModule } = await import('../server/modules/schedule-workspaces/index.ts');
  const sample = fixture();
  const calls: string[] = [];
  const first = { ...sample.agent, id: 'first' };
  const later = { ...sample.agent, id: 'later', workspaceId: 'later-workspace' };
  let hook: (event: { agent: { id: string; workspaceId: string; parentAgentId: string | null } }) => Promise<void>;
  let removed = false;
  const client = {
    fetchAgents: async ({ page }: { page: { cursor?: string } }) => page.cursor
      ? { entries: [{ agent: first }], pageInfo: { hasMore: false } }
      : { entries: [{ agent: { id: 'ordinary' } }], pageInfo: { hasMore: true, nextCursor: 'second' } },
    fetchAgent: async (id: string) => ({ agent: id === 'first' ? first : later }),
    scheduleInspect: async () => ({ schedule: sample.schedule }),
    fetchWorkspaces: async () => ({ entries: [{ ...sample.workspace, id: 'workspace' }, { ...sample.workspace, id: 'later-workspace' }], pageInfo: { hasMore: false } }),
    setWorkspaceTitle: async (id: string, title: string) => { calls.push(`${id}:${title}`); },
    setWorkspacePinned: async (id: string) => { calls.push(`${id}:pin`); },
  };
  const cleanup = scheduleWorkspacesModule.register({
    services: { daemon: { ready: async () => ({ client }) } },
    server: { addHook: (name: string, handler: typeof hook) => {
      assert.equal(name, 'agent.create.after'); hook = handler;
      return () => { removed = true; };
    } },
  } as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['workspace:【每日】上游同步分析', 'workspace:pin']);
  const event = { agent: { id: 'later', workspaceId: 'later-workspace', parentAgentId: null } };
  await hook!(event);
  await hook!(event);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(2), ['later-workspace:【每日】上游同步分析', 'later-workspace:pin']);
  if (cleanup) await cleanup();
  assert.equal(removed, true);
});
