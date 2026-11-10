import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { snapshot } from '../server/modules/capacity/index.ts';
import { CAPACITY_DEFAULT } from '../server/modules/capacity/config.ts';
test('假守护进程：仅统计置顶工作区里未关闭会话', async () => {
  const report = { id: 'claude-accounts:account', sourceId: 'claude-accounts', fetchedAt: new Date().toISOString(), report: { status: 'available', planLabel: 'Pro ai', windows: [{ id: 'five_hour', remainingPct: 100, resetsAt: null }, { id: 'weekly', remainingPct: 100 }] } };
  const client = {
    listUsageReports: async () => ({ reports: [report] }),
    fetchWorkspaces: async () => ({ entries: [{ id: 'pinned', pinnedAt: 'now' }, { id: 'normal', pinnedAt: null }], pageInfo: { hasMore: false } }),
    fetchAgents: async () => ({ entries: [
      { agent: { id: 'a', workspaceId: 'pinned', provider: 'claude-1', status: 'idle' } },
      { agent: { id: 'b', workspaceId: 'pinned', provider: 'claude-1', status: 'closed' } },
      { agent: { id: 'c', workspaceId: 'normal', provider: 'claude-1', status: 'running' } },
    ], pageInfo: { hasMore: false } }),
  };
  const result = await snapshot(client as never, '/tmp', CAPACITY_DEFAULT, 'claude-accounts', { mapping: new Map([['claude-1', 'account']]), providers: ['claude-1'] });
  assert.equal(result.accounts[0]?.load.total, 1); assert.equal(result.totalCanAdd, 1); assert.equal(result.recommendedProvider, 'claude-1');
});
