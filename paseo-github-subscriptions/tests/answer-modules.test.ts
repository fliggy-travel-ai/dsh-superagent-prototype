import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startModules } from '../server/core/modules.ts';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { resolveInstance } from '../shared/instances.ts';
import { escalationModule } from '../server/modules/answer-escalation/index.ts';
import { quietChildrenModule } from '../server/modules/answer-quiet-children/index.ts';

function setupBroken() { return setup({}, undefined, undefined, '{坏'); }
function setup(files: Record<string, unknown> = {}, json: unknown = { version: 1, modules: { 'answer.escalation': true, 'answer.quietChildren': true } }, ready: () => Promise<never> = () => new Promise<never>(() => {}), rawConfig?: string) {
  const home = mkdtempSync(join(tmpdir(), 'answer-modules-'));
  mkdirSync(join(home, 'github-subscriptions'));
  for (const [name, value] of Object.entries(files)) { mkdirSync(join(home, name, '..'), { recursive: true }); writeFileSync(join(home, name), JSON.stringify(value)); }
  if (rawConfig !== undefined) writeFileSync(join(home, 'config.json'), rawConfig);
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  const hooks: string[] = [];
  const server = {
    handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler as never); },
    addHook: (name: string) => { hooks.push(name); return () => {}; }, on: () => () => {}, before: () => () => {},
    registerProvider: () => {}, registerUsageSource: () => {}, registerSettings: () => { throw new Error('unused'); },
  };
  const daemon = { ready, current: () => null };
  const sections = Object.fromEntries([escalationModule, quietChildrenModule].map(module => [module.config!.section, module.config!.spec]));
  const machine = loadMachineConfig(join(home, 'machine.json'), sections, () => JSON.stringify(json));
  const host = startModules([escalationModule, quietChildrenModule], {
    server: server as never, instance: resolveInstance('main'), machine, services: { home, daemon, main: null } as never,
    stateDirectory: join(home, 'github-subscriptions'), baseDirectory: join(home, 'github-subscriptions'), log: () => {}, process: new EventEmitter(),
  });
  return { home, handlers, host, done: async () => { await host.dispose(); rmSync(home, { recursive: true, force: true }); } };
}

test('升级通知和子会话免提醒注册约定的 RPC，升级通知只有实际发送且不启用事件转发', async () => {
  const run = setup();
  try {
    assert.deepEqual([...run.handlers.keys()].filter(name => /^(escalation|quiet)\./.test(name)).sort(), [
      'escalation.acknowledge', 'escalation.configure', 'escalation.snapshot', 'escalation.test-webhook', 'escalation.webhook.configure',
      'quiet.configure', 'quiet.resolve-main', 'quiet.snapshot',
    ]);
    assert.deepEqual(run.host.status().modules.map(m => [m.id, m.state]), [['answer.escalation', 'running'], ['answer.quietChildren', 'running']]);
    const escalation = await run.handlers.get('escalation.snapshot')!({});
    assert.equal('delivery' in escalation, false);
    assert.equal(escalation.blockedReason, null);
    assert.equal(escalation.enabled, true);
    assert.equal(escalation.delayMinutes, 0);
    assert.equal(escalation.webhook.configured, false);
    assert.equal(escalation.status, 'running');
    const quiet = await run.handlers.get('quiet.snapshot')!({});
    assert.equal(quiet.forwardEvents, false);
    assert.equal(quiet.enabled, true);
    assert.equal(quiet.pinnedWorkspaceCount, 0);
    assert.match(quiet.error, /workspaces\.json 不存在/);
  } finally { await run.done(); }
});

test('页面写入的设置立即生效并持久化；不合法的时段整个拒绝', async () => {
  const run = setup();
  try {
    const next = await run.handlers.get('escalation.configure')!({ delayMinutes: 30, timezone: 'UTC', immediate: [{ days: 'daily', from: '02:00', to: '03:00' }], enabled: false });
    assert.deepEqual([next.delayMinutes, next.timezone, next.enabled, next.status], [30, 'UTC', false, 'stopped']);
    assert.equal(next.immediate[0].from, '02:00');
    await assert.rejects(run.handlers.get('escalation.configure')!({ timezone: 'Nowhere/City' }));
    assert.equal((await run.handlers.get('escalation.snapshot')!({})).timezone, 'UTC');
    const quiet = await run.handlers.get('quiet.configure')!({ enabled: false, forwardEvents: true });
    assert.deepEqual([quiet.enabled, quiet.forwardEvents], [false, true]);
  } finally { await run.done(); }
});

test('旧事件通知插件仍启用时：升级通知不启动、不发送，面板显示先停用旧插件；事件转发不能打开', async () => {
  const run = setup({ 'config.json': { plugins: { 'event-notifications': { enabled: true } } } });
  try {
    const escalation = await run.handlers.get('escalation.snapshot')!({});
    assert.match(escalation.blockedReason, /event-notifications/);
    assert.match(escalation.blockedReason, /停用旧插件/);
    assert.equal(escalation.status, 'error');
    await assert.rejects(run.handlers.get('quiet.configure')!({ forwardEvents: true }), /仍启用/);
    assert.equal((await run.handlers.get('quiet.snapshot')!({})).forwardEvents, false);
  } finally { await run.done(); }
});

test('旧插件仍启用时不复制旧状态；停用后启动才复制，旧文件不动', async () => {
  const legacyState = { pending: {}, outbox: [], seen: { a: 1 } };
  const active = setup({ 'config.json': { plugins: { 'event-notifications': { enabled: true } } }, 'event-notifications/state.json': legacyState });
  try { assert.equal(existsSync(join(active.home, 'github-subscriptions', 'escalation', 'state.json')), false); } finally { await active.done(); }
  const stopped = setup({ 'event-notifications/state.json': legacyState });
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(stopped.home, 'github-subscriptions', 'escalation', 'state.json'), 'utf8')), legacyState);
    assert.deepEqual(JSON.parse(readFileSync(join(stopped.home, 'event-notifications', 'state.json'), 'utf8')), legacyState);
  } finally { await stopped.done(); }
});

test('读不到 Paseo 的 config.json 时按旧插件仍启用处理：升级通知不发送，事件转发打不开', async () => {
  const broken = setupBroken();
  try {
    const escalation = await broken.handlers.get('escalation.snapshot')!({});
    assert.match(escalation.blockedReason, /config\.json 无法解析/);
    await assert.rejects(broken.handlers.get('quiet.configure')!({ forwardEvents: true }), /config\.json 无法解析/);
  } finally { await broken.done(); }
});

test('置顶工作区数量来自 workspaces.json；无法读取时给出错误而不是当作没有', async () => {
  const run = setup({ 'projects/workspaces.json': [{ workspaceId: 'w1', pinnedAt: 'x' }, { workspaceId: 'w2', pinnedAt: 'x' }, { workspaceId: 'w3' }] });
  try {
    const quiet = await run.handlers.get('quiet.snapshot')!({});
    assert.equal(quiet.pinnedWorkspaceCount, 2);
    assert.deepEqual(quiet.pinnedWorkspaces.map((w: { id: string }) => w.id).sort(), ['w1', 'w2']);
    writeFileSync(join(run.home, 'projects', 'workspaces.json'), '{坏');
    assert.match((await run.handlers.get('quiet.snapshot')!({})).error, /读取置顶工作区失败/);
  } finally { await run.done(); }
});

test('对方主机转发时用 quiet.resolve-main 确认现任主会话；读取失败时抛错', async () => {
  const run = setup({ 'projects/workspaces.json': [{ workspaceId: 'w1', pinnedAt: 'x' }] }, undefined, () => Promise.reject(new Error('守护进程未连接')));
  try {
    await assert.rejects(run.handlers.get('quiet.resolve-main')!({ parentAgentId: 'p' }), /守护进程未连接/);
  } finally { await run.done(); }
});

test('webhook 配置不完整时保存凭据抛出明确错误', async () => {
  const run = setup();
  try {
    await assert.rejects(run.handlers.get('escalation.webhook.configure')!({ url: 'https://example.test/hook', auth: 'X-Key: test-secret' }), /Keychain/);
    const test = await run.handlers.get('escalation.test-webhook')!({});
    assert.equal(test.sent, false);
    assert.match(test.message, /发送失败/);
  } finally { await run.done(); }
});

test('旧配置的 delivery: "shadow"（machine.json 或页面设置）照常读取，按实际发送处理并在日志提示', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  const run = setup({ 'github-subscriptions/escalation/settings.json': { delivery: 'shadow', delayMinutes: 5 } }, { version: 1, modules: { 'answer.escalation': true }, escalation: { delivery: 'shadow' } });
  try {
    const escalation = await run.handlers.get('escalation.snapshot')!({});
    assert.equal(escalation.status, 'running');
    // 旧设置文件照常读取，不报“设置文件不合法”。
    assert.doesNotMatch(escalation.error ?? '', /设置文件|影子|shadow/);
    assert.equal(escalation.delayMinutes, 5);
    assert.ok(lines.some(line => /影子模式已删除/.test(line) && /实际发送/.test(line)), lines.join('\n'));
  } finally { console.error = original; await run.done(); }
});
