import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { startModules, summarizeError, type ModuleDefinition } from '../server/core/modules.ts';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { resolveInstance } from '../shared/instances.ts';

const fakeServer = () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const hooks = new Map<string, (input: unknown) => unknown>();
  const providers: unknown[] = [];
  const server = {
    handle(contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) { handlers.set(contract.name, handler); },
    addHook(name: string, handler: (input: unknown) => unknown) { hooks.set(name, handler); return () => hooks.delete(name); },
    on() { return () => {}; }, before() { return () => {}; },
    registerProvider(value: unknown) { providers.push(value); },
    registerUsageSource() {}, registerSettings() { throw new Error('unused'); },
  };
  return { server: server as never, handlers, hooks, providers };
};
const machine = (json?: unknown, sections = {}) => loadMachineConfig('/x/machine.json', sections, () => {
  if (json === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return JSON.stringify(json);
});
type Def = ModuleDefinition<any, Record<string, never>>;
const def = (id: string, register: Def['register'], extra: Partial<Def> = {}): Def => ({ id, label: `模块${id}`, defaultEnabled: true, appliesTo: () => true, register, ...extra });
const start = (defs: Def[], options: { json?: unknown; sections?: Record<string, never>; role?: 'main' | 'provider' | null } = {}) => {
  const fake = fakeServer();
  const proc = new EventEmitter();
  const logs: string[] = [];
  const host = startModules(defs, {
    server: fake.server, instance: resolveInstance(options.role ?? null),
    machine: machine(options.json, Object.fromEntries(defs.filter(d => d.config).map(d => [d.config!.section, d.config!.spec]))),
    services: {}, stateDirectory: '/state', baseDirectory: '/state', log: line => logs.push(line), process: proc,
  });
  return { ...fake, host, proc, logs };
};

test('一个模块注册抛错只停这个模块，其他模块照常注册', async () => {
  const run = start([
    def('a', ({ server }) => { server.handle({ name: 'a.rpc' } as never, (() => 'a') as never); }),
    def('b', () => { throw new Error('b 坏了 Bearer secret-token-value'); }),
    def('c', ({ server }) => { server.handle({ name: 'c.rpc' } as never, (() => 'c') as never); }),
  ]);
  assert.deepEqual([...run.handlers.keys()].sort(), ['a.rpc', 'c.rpc', 'modules.status']);
  const status = run.host.status();
  assert.deepEqual(status.modules.map(m => [m.id, m.state]), [['a', 'running'], ['b', 'error'], ['c', 'running']]);
  assert.match(status.modules[1]!.reason!, /b 坏了/);
  assert.ok(!status.modules[1]!.reason!.includes('secret-token-value'));
  assert.equal(run.logs.length, 1);
  assert.match(run.logs[0]!, /模块b注册失败/);
  await run.host.dispose();
});

test('模块可以指定自己的脱敏函数', async () => {
  const run = start([def('a', () => { throw new Error('x'); }, { redact: () => '自定义摘要' })]);
  assert.equal(run.host.status().modules[0]!.reason, '自定义摘要');
  assert.equal(run.logs[0], '模块a注册失败：自定义摘要');
  await run.host.dispose();
});

test('默认关闭的模块要在 machine.json 中打开；显式关闭的模块不注册', async () => {
  let opened = 0;
  const defs = [def('off', () => { opened++; }, { defaultEnabled: false }), def('on', () => { opened++; })];
  const closed = start(defs);
  assert.deepEqual(closed.host.status().modules.map(m => [m.id, m.state]), [['off', 'off'], ['on', 'running']]);
  assert.match(closed.host.status().modules[0]!.reason!, /默认关闭/);
  const toggled = start(defs, { json: { version: 1, modules: { off: true, on: false } } });
  assert.deepEqual(toggled.host.status().modules.map(m => [m.id, m.state]), [['off', 'running'], ['on', 'off']]);
  assert.match(toggled.host.status().modules[1]!.reason!, /已关闭/);
  assert.equal(opened, 2);

  // 始终开启的模块（如云端会话）即使旧配置写 false 也会启动
  let alwaysStarted = 0;
  const always = start([def('providers.cloudSession', () => { alwaysStarted++; }, { alwaysEnabled: true })], {
    json: { version: 1, modules: { 'providers.cloudSession': false } },
  });
  assert.deepEqual(always.host.status().modules.map(m => [m.id, m.state]), [['providers.cloudSession', 'running']]);
  assert.equal(alwaysStarted, 1);
  await closed.host.dispose();
  await toggled.host.dispose();
  await always.host.dispose();
});

test('不属于本实例角色的模块不出现', () => {
  const run = start([def('p', () => {}, { appliesTo: instance => instance.hostsProviders }), def('m', () => {})], { role: 'main' });
  assert.deepEqual(run.host.status().modules.map(m => m.id), ['m']);
  assert.deepEqual(run.host.status().instance, { role: 'main', legacy: false });
});

test('配置区块不合法时依赖它的模块报错，不注册', () => {
  let registered = false;
  const run = start([def('cfg', () => { registered = true; }, { config: { section: 'rules', spec: { schema: z.array(z.string()), fallback: [] } } })], { json: { version: 1, modules: { cfg: true }, rules: [1] } });
  assert.equal(registered, false);
  const [status] = run.host.status().modules;
  assert.equal(status!.state, 'error');
  assert.match(status!.reason!, /rules/);
  assert.equal(run.host.status().config.errors.length, 1);
});

test('模块拿到解析后的配置区块', () => {
  let seen: unknown;
  start([def('cfg', ({ config }) => { seen = config; }, { config: { section: 'rules', spec: { schema: z.array(z.string()), fallback: ['默认'] } } })], { json: { version: 1, rules: ['a'] } });
  assert.deepEqual(seen, ['a']);
  start([def('cfg', ({ config }) => { seen = config; }, { config: { section: 'rules', spec: { schema: z.array(z.string()), fallback: ['默认'] } } })]);
  assert.deepEqual(seen, ['默认']);
});

test('模块运行中可以报错，状态 RPC 反映出来', async () => {
  let fail: (error: unknown) => void = () => {};
  const run = start([def('a', context => { fail = context.fail; })]);
  fail(new Error('连接断开'));
  const snapshot = await run.handlers.get('modules.status')!({}, {}) as { modules: { state: string; reason?: string }[] };
  assert.equal(snapshot.modules[0]!.state, 'error');
  assert.match(snapshot.modules[0]!.reason!, /连接断开/);
});

test('未捕获的异步错误按模块记录，不让进程退出；清理后移除监听', async () => {
  const run = start([def('a', () => {}), def('b', () => {})]);
  assert.equal(run.proc.listenerCount('unhandledRejection'), 1);
  assert.equal(run.proc.listenerCount('uncaughtException'), 1);
  run.host.runInModule('b', () => { run.proc.emit('unhandledRejection', new Error('异步失败 ghp_abcdefghijklmnopqrstuvwxyz0123456789')); });
  run.proc.emit('uncaughtException', new Error('不知道是谁'));
  const statuses = run.host.status().modules;
  assert.equal(statuses[1]!.state, 'running');
  assert.match(statuses[1]!.lastUncaught!.summary, /异步失败/);
  assert.ok(!statuses[1]!.lastUncaught!.summary.includes('ghp_abcdef'));
  assert.ok(run.logs.some(line => /模块b 未捕获的异步错误/.test(line)));
  assert.ok(run.logs.some(line => /未知模块 未捕获的异常：不知道是谁/.test(line)));
  await run.host.dispose();
  assert.equal(run.proc.listenerCount('unhandledRejection'), 0);
  assert.equal(run.proc.listenerCount('uncaughtException'), 0);
});

test('处理函数、钩子和 Provider 回调在模块上下文中运行，异步错误能归属到模块', async () => {
  let current: () => string | null = () => null;
  const run = start([def('a', ({ server }) => {
    server.handle({ name: 'a.rpc' } as never, (async () => { await new Promise(resolve => setTimeout(resolve, 1)); return current(); }) as never);
    server.addHook('agent.archive.after' as never, (async () => current()) as never);
    server.registerProvider({ id: 'p', label: 'P', connect: async () => current(), status: () => current() } as never);
  })]);
  current = () => run.host.currentModule();
  assert.equal(await run.handlers.get('a.rpc')!({}, {}), 'a');
  assert.equal(await run.hooks.get('agent.archive.after')!({}), 'a');
  const provider = run.providers[0] as { connect: () => Promise<string>; status: () => string; id: string };
  assert.equal(provider.id, 'p');
  assert.equal(await provider.connect(), 'a');
  assert.equal(provider.status(), 'a');
  assert.equal(current(), null);
  await run.host.dispose();
});

test('清理按注册的倒序执行，单个清理失败不影响其他清理', async () => {
  const order: string[] = [];
  const run = start([
    def('a', () => () => { order.push('a'); }),
    def('b', () => async () => { order.push('b'); throw new Error('清理失败'); }),
    def('c', () => () => { order.push('c'); }),
  ]);
  await run.host.dispose();
  assert.deepEqual(order, ['c', 'b', 'a']);
  assert.ok(run.logs.some(line => /模块b清理失败/.test(line)));
});

test('错误摘要去掉令牌、Bearer 和 URL 查询，限制长度', () => {
  const text = summarizeError(new Error(`失败 Bearer abc.def ghp_${'x'.repeat(36)} github_pat_${'y'.repeat(40)} https://hooks.example.net/path?key=secret ${'长'.repeat(400)}`));
  assert.ok(!text.includes('abc.def'));
  assert.ok(!text.includes('xxxxxxxx'));
  assert.ok(!text.includes('yyyyyyyy'));
  assert.ok(!text.includes('secret'));
  assert.ok(text.length <= 300);
});
