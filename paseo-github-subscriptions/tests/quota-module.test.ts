import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { startModules } from '../server/core/modules.ts';
import { resolveInstance } from '../shared/instances.ts';

// 复制来的上游文件用 .js 导入；Node 直接跑测试时把它们解析到 .ts（生产环境由 Paseo 打包）。
const pluginRoot = new URL('../', import.meta.url).href;
const { registerHooks } = nodeModule as unknown as { registerHooks(options: { resolve: (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => unknown) => unknown }): { deregister(): void } };
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pluginRoot)) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const { claudeAccountsModule } = await import('../server/modules/usage-claude-accounts/index.ts');
hooks.deregister();

const RELAY = 'private' + 'relay.appleid.example';

function setup(options: { plugins?: Record<string, unknown>; json?: unknown; legacy?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quota-module-'));
  const home = join(root, 'paseo'); const state = join(home, 'github-subscriptions');
  mkdirSync(state, { recursive: true });
  const configDir = join(root, 'claude-2'); mkdirSync(configDir);
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acc1', organizationUuid: 'org1', emailAddress: `x@${RELAY}` } }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: options.plugins ?? {}, agents: { providers: {
    claude: { label: 'Claude · 默认' }, 'claude-2': { extends: 'claude', label: 'Claude · 旧名称', env: { CLAUDE_CONFIG_DIR: configDir } },
  } } }));
  if (options.legacy) { mkdirSync(join(home, 'claude-quota-resume')); for (const [name, text] of Object.entries(options.legacy)) writeFileSync(join(home, 'claude-quota-resume', name), text); }
  const cli = join(root, 'paseo-cli'); writeFileSync(cli, '#!/bin/sh\necho "[]"\n'); chmodSync(cli, 0o755);
  const previousCli = process.env.PASEO_CLI; process.env.PASEO_CLI = cli;
  // 默认账号读 $HOME/.claude.json：用临时目录，测试不依赖本机真实账号。
  const previousHome = process.env.HOME; process.env.HOME = root;
  const handlers = new Map<string, (input: any, context?: unknown) => Promise<any>>();
  const sources: Array<{ id: string; label: string }> = [];
  const patches: unknown[] = [];
  const server = {
    handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler as never); },
    addHook: () => () => {}, on: () => () => {}, before: () => () => {}, registerProvider: () => {},
    registerUsageSource: (source: { id: string; label: string }) => { sources.push(source); }, registerSettings: () => { throw new Error('unused'); },
  };
  const daemon = { ready: async () => ({ client: { patchDaemonConfig: async (patch: unknown) => { patches.push(patch); } }, paseo: {} }), current: () => null };
  const json = options.json ?? { version: 1, modules: { 'usage.claudeAccounts': true } };
  const machine = loadMachineConfig(join(state, 'machine.json'), { claudeAccounts: claudeAccountsModule.config!.spec }, () => JSON.stringify(json));
  const host = startModules([claudeAccountsModule], {
    server: server as never, instance: resolveInstance('main'), machine, services: { home, daemon, main: null } as never,
    stateDirectory: state, baseDirectory: state, log: () => {}, process: new EventEmitter(),
  });
  return { root, home, state, handlers, sources, patches, host, done: async () => {
    await host.dispose(); rmSync(root, { recursive: true, force: true });
    if (previousCli === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = previousCli;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  } };
}

test('模块启动：注册额度来源和约定的 RPC，状态为运行', async () => {
  const run = setup();
  try {
    assert.equal(run.host.status().modules[0]!.state, 'running');
    assert.deepEqual(run.sources.map(source => source.id), ['claude-accounts']);
    assert.deepEqual([...run.handlers.keys()].filter(name => name.startsWith('claude-accounts.')).sort(), [
      'claude-accounts.configure', 'claude-accounts.login.retry', 'claude-accounts.login.start', 'claude-accounts.login.submit-code',
      'claude-accounts.rename', 'claude-accounts.retry-status', 'claude-accounts.set-auto-resume', 'claude-accounts.snapshot',
    ]);
    const snapshot = await run.handlers.get('claude-accounts.snapshot')!({});
    assert.equal(snapshot.enabled, true);
    assert.deepEqual(snapshot.accounts.map((a: { providerId: string }) => a.providerId), ['claude', 'claude-2']);
    assert.equal(snapshot.accounts[1].appleLogin, true);
    assert.equal(snapshot.quotaName.enabled, true);
    assert.equal(snapshot.quotaName.autoResumeDefault, false);
    assert.equal(snapshot.activeFlow, null);
  } finally { await run.done(); }
});

test('来源 ID 可以在 machine.json 里改', async () => {
  const run = setup({ json: { version: 1, modules: { 'usage.claudeAccounts': true }, claudeAccounts: { sourceId: 'claude-accounts-next' } } });
  try { assert.deepEqual(run.sources.map(source => source.id), ['claude-accounts-next']); } finally { await run.done(); }
});

test('旧插件仍启用：不注册额度来源，模块报错，页面看到原因，写操作被拒绝', async () => {
  const run = setup({ plugins: { 'claude-quota-resume': { enabled: true } } });
  try {
    assert.deepEqual(run.sources, []);
    const status = run.host.status().modules[0]!;
    assert.equal(status.state, 'error');
    assert.match(status.reason!, /claude-quota-resume.*仍启用/);
    const snapshot = await run.handlers.get('claude-accounts.snapshot')!({});
    assert.equal(snapshot.enabled, false);
    assert.match(snapshot.error, /仍启用/);
    await assert.rejects(run.handlers.get('claude-accounts.configure')!({ autoResumeDefault: true }), /仍启用/);
    assert.equal(existsSync(join(run.state, 'quota')), false);
  } finally { await run.done(); }
});

test('设置：自动继续默认值和名称带额度写入设置文件并立即生效', async () => {
  const run = setup();
  try {
    const next = await run.handlers.get('claude-accounts.configure')!({ autoResumeDefault: true, labelWithQuota: false });
    assert.equal(next.quotaName.autoResumeDefault, true);
    assert.equal(next.quotaName.enabled, false);
    assert.deepEqual(JSON.parse(readFileSync(join(run.state, 'quota', 'settings.json'), 'utf8')), { autoResumeDefault: true, labelWithQuota: false });
    // 新会话默认开：没选择过的会话算开启；单独关闭的会话保持关闭。
    assert.equal((await run.handlers.get('claude-accounts.set-auto-resume')!({ agentId: 'a', enabled: false })).enabled, false);
    assert.equal((await run.handlers.get('claude-accounts.retry-status')!({ agentId: 'b', text: 'x' }, { paseo: {} })).enabled, true);
  } finally { await run.done(); }
});

test('改名：用 config.patch 改 Provider 显示名称；Apple 账号确认真实邮箱写入 labels.json', async () => {
  const run = setup();
  try {
    await run.handlers.get('claude-accounts.rename')!({ providerId: 'claude-2', label: 'Claude · 备用' });
    assert.deepEqual(run.patches[0], { providers: { 'claude-2': { label: 'Claude · 备用' } } });
    const renamed = await run.handlers.get('claude-accounts.rename')!({ providerId: 'claude-2', realEmail: 'Real@Example.com' });
    assert.deepEqual(JSON.parse(readFileSync(join(run.state, 'labels.json'), 'utf8')), { [`x@${RELAY}`]: 'real@example.com（Apple 登录）' });
    assert.deepEqual(run.patches[1], { providers: { 'claude-2': { label: 'Claude · real@example.com（Apple 登录）' } } });
    assert.equal(renamed.accounts[1].email, 'real@example.com');
    await assert.rejects(run.handlers.get('claude-accounts.rename')!({ providerId: 'claude', realEmail: 'a@example.com' }), /不是 Apple 登录/);
    await assert.rejects(run.handlers.get('claude-accounts.rename')!({ providerId: 'nope', label: 'x' }), /不存在/);
  } finally { await run.done(); }
});

test('旧状态目录存在时启动自动复制，旧文件不动', async () => {
  const run = setup({ legacy: { 'jobs.json': '[]', 'enabled-agents.json': '["a"]', 'account-labels.json': JSON.stringify({ 'h@example.test': '真实（Apple 登录）' }) } });
  try {
    assert.equal(readFileSync(join(run.state, 'quota', 'enabled-agents.json'), 'utf8'), '["a"]');
    assert.equal(readFileSync(join(run.home, 'claude-quota-resume', 'enabled-agents.json'), 'utf8'), '["a"]');
    assert.deepEqual(JSON.parse(readFileSync(join(run.state, 'labels.json'), 'utf8')), { 'h@example.test': '真实（Apple 登录）' });
  } finally { await run.done(); }
});
