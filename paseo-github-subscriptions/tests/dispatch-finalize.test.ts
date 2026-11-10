import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { finalize, type FinalizePort } from '../server/modules/dispatch-finalize/finalize.ts';

function fixture() {
  const agent = { id: 'a', workspaceId: 'w', labels: { role: 'main', issue: '123', 'paseo.parent-agent-id': 'p' } };
  const workspace = { id: 'w', pinnedAt: null as string | null, labels: [] as string[] };
  const calls: string[] = [];
  const port: FinalizePort = { agent: async () => agent, workspace: async () => workspace,
    detach: async () => { calls.push('detach'); delete (agent.labels as Record<string,string>)['paseo.parent-agent-id']; },
    pin: async () => { calls.push('pin'); workspace.pinnedAt = 'now'; },
    label: async () => { calls.push('label'); workspace.labels.push('主会话'); } };
  return { port, calls, agent, workspace };
}
test('收尾执行各步，再次执行时跳过已完成步骤', async () => {
  const f = fixture(); const first = await finalize(f.port, 'a');
  assert.equal(first.ok, true); assert.deepEqual(f.calls, ['detach', 'pin', 'label']);
  const second = await finalize(f.port, 'a'); assert.equal(second.ok, true);
  assert.deepEqual(second.steps.map(s => s.status), ['done', 'skipped', 'skipped', 'skipped', 'done']);
});
test('收尾操作失败和解绑读回失败均不报告成功', async () => {
  for (const step of ['detach', 'pin', 'label'] as const) {
    const f = fixture(); f.port[step] = async () => { throw Error('failure'); };
    const result = await finalize(f.port, 'a'); assert.equal(result.ok, false); assert.equal(result.steps.at(-1)?.status, 'failed');
  }
  const f = fixture(); f.port.detach = async () => {};
  assert.equal((await finalize(f.port, 'a')).reason, '解绑读回失败');
});
test('无主会话标签或已归档工作区不执行操作', async () => {
  const f = fixture(); f.agent.labels.role = 'child'; assert.equal((await finalize(f.port, 'a')).ok, false); assert.deepEqual(f.calls, []);
  f.agent.labels.role = 'main'; f.port.workspace = async () => ({ id: 'w', archivedAt: 'now' });
  assert.equal((await finalize(f.port, 'a')).ok, false); assert.deepEqual(f.calls, []);
});
test('假守护进程：使用守护进程接口解绑、置顶、打标签并读回', async () => {
  const { finalizePort } = await import('../server/modules/dispatch-finalize/index.ts');
  const f = fixture();
  const client = {
    fetchAgent: async () => ({ agent: f.agent }),
    fetchWorkspaces: async () => ({ entries: [f.workspace], pageInfo: { hasMore: false } }),
    detachAgent: f.port.detach, setWorkspacePinned: f.port.pin,
    setWorkspaceLabel: async () => f.port.label('w'),
  };
  assert.equal((await finalize(finalizePort(client as never), 'a')).ok, true);
  assert.deepEqual(f.calls, ['detach', 'pin', 'label']);
});
test('置顶后标签失败，用户取消置顶后重试不再次置顶', async () => {
  const f = fixture(); let handled = false; const label = f.port.label;
  f.port.label = async () => { throw Error('failed'); };
  const first = await finalize(f.port, 'a', { onPinHandled: async () => { handled = true; } });
  assert.equal(first.ok, false); assert.equal(handled, true);
  f.workspace.pinnedAt = null; f.port.label = label;
  assert.equal((await finalize(f.port, 'a', { pinHandled: handled })).ok, true);
  assert.equal(f.calls.filter(c => c === 'pin').length, 1); assert.equal(f.workspace.pinnedAt, null);
});
