import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import type { AgentToolContext } from '@getpaseo/plugin/server';
import { Runtime } from '../server/runtime.ts';

const context = { agent: { id: 'agent-one', workspaceId: 'workspace', parentAgentId: null, title: '测试会话' }, signal: new AbortController().signal } as unknown as AgentToolContext;

async function fixture(action: (runtime: Runtime) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ghsub-runtime-'));
  const paseo = { config: { get: async () => ({ config: { mcp: { injectIntoAgents: true } } }) } } as unknown as PaseoApi;
  const runtime = new Runtime(directory, paseo);
  try {
    await runtime.start();
    await runtime.storage.mutate(state => { state.preferences.organization = 'owner'; });
    await action(runtime);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
}

test('整仓库拒绝push和review，订阅数量上限在事务内生效，已有订阅可更新', () => fixture(async runtime => {
  await assert.rejects(runtime.subscribe('owner/repo', ['push'], undefined, context), /需要指定 PR/);
  await assert.rejects(runtime.subscribe('owner/repo', ['review'], undefined, context), /需要指定 PR/);
  await Promise.all(Array.from({ length: 5 }, (_, index) => runtime.subscribe(`owner/repo-${index}`, undefined, undefined, context)));
  await assert.rejects(runtime.subscribe('owner/overflow', undefined, undefined, context), /5 条/);
  await runtime.subscribe('owner/repo-0', ['comment'], '更新', context);
  assert.equal(runtime.storage.state.subscriptions.length, 5);
  assert.equal(runtime.storage.state.subscriptions[0].note, '更新');
  await runtime.storage.mutate(state => {
    const template = state.subscriptions[0];
    state.subscriptions = Array.from({ length: 1000 }, (_, index) => ({ ...template, id: `sub-${index}`, agentId: `other-${index}` }));
  });
  await assert.rejects(runtime.subscribe('owner/new', undefined, undefined, context), /1000 条/);
}));

test('切换影子模式会终结旧pending，切回实发不会补发；快照隐藏内部正文与事件副本', () => fixture(async runtime => {
  await runtime.storage.mutate(state => {
    state.preferences.shadow = false;
    state.deliveries.push({ id: 'draft', agentId: 'agent-one', eventIds: [], at: new Date().toISOString(), status: 'pending', error: null, text: '内部文本', events: [], attempts: 0, retryAt: 0 });
  });
  await runtime.preferences({ ...runtime.storage.state.preferences, shadow: true });
  await runtime.preferences({ ...runtime.storage.state.preferences, shadow: false });
  assert.equal(runtime.storage.state.deliveries[0].status, 'shadow');
  assert.equal('text' in runtime.snapshot().deliveries[0], false);
  assert.equal('events' in runtime.snapshot().deliveries[0], false);
}));
