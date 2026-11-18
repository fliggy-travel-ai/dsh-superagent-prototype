import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkScheduleWorkspaces } from '../scripts/check-schedule-workspaces.ts';

function fixture() {
  const snapshot = { instance: { role: 'main', legacy: true }, config: { path: '/tmp/machine.json', source: 'file', errors: [] }, modules: [{ id: 'schedules.workspaces', label: '定时任务工作区', state: 'running', reason: undefined as string | undefined }] };
  const workspace = { id: 'daily-workspace', title: '【每日】产品反馈分析', name: '默认标题', pinnedAt: '2026-11-17T01:25:00.000Z' as string | null };
  const client = {
    invokePluginRpc: async (pluginId: string, method: string) => { assert.equal(pluginId, 'github-subscriptions'); assert.equal(method, 'modules.status'); return snapshot; },
    fetchWorkspaces: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }),
  };
  return { snapshot, workspace, client: client as unknown as Parameters<typeof checkScheduleWorkspaces>[0] };
}

test('插件整体运行但缺少定时任务模块时，部署验收失败', async () => {
  const sample = fixture(); sample.snapshot.modules = [];
  await assert.rejects(checkScheduleWorkspaces(sample.client), /缺少定时任务工作区模块/);
});

test('定时任务模块关闭或出错时，部署验收失败', async () => {
  for (const state of ['off', 'error']) {
    const sample = fixture(); sample.snapshot.modules[0]!.state = state;
    await assert.rejects(checkScheduleWorkspaces(sample.client), /模块未运行/);
  }
});

test('工作区验收读回置顶时间和每日标题', async () => {
  const sample = fixture();
  assert.deepEqual(await checkScheduleWorkspaces(sample.client, sample.workspace.id), {
    module: 'running', workspaceId: sample.workspace.id, title: sample.workspace.title, pinnedAt: sample.workspace.pinnedAt,
  });
  sample.workspace.pinnedAt = null;
  await assert.rejects(checkScheduleWorkspaces(sample.client, sample.workspace.id), /尚未置顶/);
  sample.workspace.pinnedAt = 'now'; sample.workspace.title = '产品反馈分析';
  await assert.rejects(checkScheduleWorkspaces(sample.client, sample.workspace.id), /尚未同步/);
});

test('工作区分页读取，不把第一页未找到当作不存在', async () => {
  const sample = fixture(); let calls = 0;
  sample.client.fetchWorkspaces = (async () => ++calls === 1
    ? { entries: [], pageInfo: { hasMore: true, nextCursor: 'next' } }
    : { entries: [sample.workspace], pageInfo: { hasMore: false } }) as unknown as typeof sample.client.fetchWorkspaces;
  await checkScheduleWorkspaces(sample.client, sample.workspace.id);
  assert.equal(calls, 2);
});
