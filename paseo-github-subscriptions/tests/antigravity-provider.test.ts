import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeJsonFile } from '../server/core/provider-config.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { ProviderRegistration } from '@getpaseo/plugin/server/provider';
import { resolveInstance } from '../shared/instances.ts';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { startModules } from '../server/core/modules.ts';
import { SharedDaemon } from '../server/core/daemon.ts';
import {
  antigravityModule,
  registerAntigravityRpcs,
} from '../server/modules/providers-antigravity/index.ts';
import { createAntigravityProvider } from '../server/modules/providers-antigravity/provider.ts';
import type { Services } from '../server/modules/types.ts';

function createFakeEnv(options: {
  machineJson?: Record<string, unknown>;
  paseoConfigJson?: Record<string, unknown>;
  runningAgents?: Array<{ id: string; provider: string; status: string }>;
  patch?: (patch: unknown) => Promise<unknown>;
  neverConnect?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'ghsub-agy-test-'));
  const machinePath = join(root, 'machine.json');
  if (options.machineJson) {
    writeFileSync(machinePath, JSON.stringify(options.machineJson, null, 2));
  }
  if (options.paseoConfigJson) {
    writeFileSync(join(root, 'config.json'), JSON.stringify(options.paseoConfigJson, null, 2));
  }

  const providers: ProviderRegistration[] = [];
  const handlers = new Map<string, (input: any, ctx?: any) => Promise<any>>();
  const server = {
    registerProvider(provider: ProviderRegistration) {
      providers.push(provider);
    },
    registerUsageSource() {},
    handle(contract: { name: string }, handler: (input: any, ctx?: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  const daemon = new SharedDaemon(root, (async () => {
    if (options.neverConnect) await new Promise(() => {});
    return {
    paseo: {} as never,
    client: {
      patchDaemonConfig: async (patch: unknown) => (options.patch ? options.patch(patch) : { requestId: 'r', config: { providers: Object.fromEntries(Object.entries((patch as { providers: Record<string, unknown> }).providers)) } }),
      fetchAgents: async () => ({
        entries: (options.runningAgents ?? []).map(agent => ({ agent })),
        pageInfo: { hasMore: false },
      }),
    } as never,
    approve: async () => {},
    respond: async () => {},
    async close() {},
    };
  }) as never);

  const services: Services = { home: root, daemon, main: null };
  const sections = {
    [antigravityModule.config!.section]: antigravityModule.config!.spec,
  };
  const machine = loadMachineConfig(machinePath, sections);

  return { root, machinePath, providers, handlers, server, services, machine };
}

test('providers.antigravity：默认关闭时不注册 Provider', () => {
  const { providers, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      antigravity: {
        accounts: [{ id: 'antigravity-cy517', label: 'Antigravity · 账号一' }],
      },
    },
  });
  const host = startModules([antigravityModule], {
    server,
    instance: resolveInstance('provider'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });
  assert.equal(providers.length, 0);
  const status = host.status().modules.find(m => m.id === 'providers.antigravity');
  assert.equal(status?.state, 'off');
});

test('providers.antigravity：按配置注册多个账号，保持 antigravity-cy517 和 antigravity-beibeimao ID 不变', async () => {
  const { providers, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'providers.antigravity': true },
      antigravity: {
        accounts: [
          {
            id: 'antigravity-cy517',
            label: 'Antigravity · 账号一',
            command: ['/usr/local/bin/agy-paseo'],
          },
          {
            providerId: 'antigravity-beibeimao',
            label: 'Antigravity · 账号二',
            command: ['/usr/local/bin/agy-paseo-2'],
          },
          {
            id: 'antigravity-disabled',
            label: 'Antigravity · 停用账号',
            enabled: false,
          },
        ],
      },
    },
  });

  const host = startModules([antigravityModule], {
    server,
    instance: resolveInstance('provider'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.equal(host.status().modules[0]?.state, 'running');
  assert.deepEqual(
    providers.map(p => ({ id: p.id, label: p.label, command: p.command, icon: p.icon })),
    [
      {
        id: 'antigravity-cy517',
        label: 'Antigravity · 账号一',
        command: ['/usr/local/bin/agy-paseo'],
        icon: 'icons/antigravity.svg',
      },
      {
        id: 'antigravity-beibeimao',
        label: 'Antigravity · 账号二',
        command: ['/usr/local/bin/agy-paseo-2'],
        icon: 'icons/antigravity.svg',
      },
    ],
  );

  const created = createAntigravityProvider({
    providerId: 'antigravity-cy517',
    label: 'Antigravity · 账号一',
  });
  const noLaunchStatus = await created.status!({ launch: undefined } as never);
  assert.equal(noLaunchStatus.available, false);
  const cacheKey = await created.getCatalogCacheKey!({
    launch: { command: 'agy', args: [], env: { HOME: '/tmp/a' } },
  } as never);
  assert.equal(typeof cacheKey, 'string');
  assert.equal(cacheKey?.length, 64);
});

test('providers.antigravity：旧插件仍启用时跳过对应账号并标记模块出错', () => {
  const { providers, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'providers.antigravity': true },
      antigravity: {
        accounts: [
          { id: 'antigravity-cy517', label: 'Antigravity · 账号一' },
          { id: 'antigravity-beibeimao', label: 'Antigravity · 账号二' },
        ],
      },
    },
    paseoConfigJson: {
      plugins: {
        'antigravity-cy517-provider': { source: 'directory', path: '/tmp/p1', enabled: true },
        'antigravity-beibeimao-provider': { source: 'directory', path: '/tmp/p2', enabled: false },
      },
    },
  });

  const host = startModules([antigravityModule], {
    server,
    instance: resolveInstance('provider'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.deepEqual(providers.map(p => p.id), ['antigravity-beibeimao']);
  const modStatus = host.status().modules[0];
  assert.equal(modStatus?.state, 'error');
  assert.match(modStatus?.reason ?? '', /antigravity-cy517-provider/);
});

const baseMachine = {
  version: 1,
  modules: { 'providers.antigravity': true },
  antigravity: { accounts: [{ id: 'antigravity-cy517', label: 'Antigravity · 账号一', homeDir: '~/.agy-machine' }] },
};
const basePaseo = { agents: { providers: { 'antigravity-cy517': { enabled: true, label: 'Antigravity · 账号一', command: ['/usr/local/bin/agy-paseo'], env: { HOME: '~/.agy-1' } } } } };
const readMachine = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const backupsOf = (dir: string, name: string) => readdirSync(dir).filter(file => file.startsWith(`${name}.bak-`));

test('antigravity.snapshot：运行中会话数、账号列表；显示实际生效的 HOME（Paseo 配置优先于 machine.json）', async () => {
  const { handlers, server, services, machinePath } = createFakeEnv({
    machineJson: baseMachine, paseoConfigJson: basePaseo,
    runningAgents: [{ id: 'a1', provider: 'antigravity-cy517/gemini-3.8', status: 'running' }, { id: 'a2', provider: 'antigravity-beibeimao', status: 'idle' }, { id: 'a3', provider: 'codex', status: 'running' }],
  });
  registerAntigravityRpcs({ server, machinePath, services });
  await services.daemon.ready();
  const snapshot = await handlers.get('antigravity.snapshot')!({});
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.runningSessionsCount, 1);
  assert.equal(snapshot.reloadRequired, false);
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.accounts, [{ providerId: 'antigravity-cy517', label: 'Antigravity · 账号一', enabled: true, homeDir: '~/.agy-1' }]);
});

test('antigravity.snapshot：守护进程没连上时不等待，运行中会话数按 0 返回', async () => {
  const { handlers, server, services, machinePath } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo, neverConnect: true });
  registerAntigravityRpcs({ server, machinePath, services });
  const started = Date.now();
  const snapshot = await handlers.get('antigravity.snapshot')!({});
  assert.ok(Date.now() - started < 1500, `耗时 ${Date.now() - started}ms`);
  assert.equal(snapshot.runningSessionsCount, 0);
});

test('machine.json 里的账号 ID 必须符合 antigravity- 规则：antigravity、cloud-session、claude 等会重复注册的 ID 被拒绝，不注册任何 Provider', () => {
  for (const id of ['antigravity', 'cloud-session', 'claude', 'codex', 'Antigravity-x', 'antigravity-']) {
    const { providers, server, services, machine, root } = createFakeEnv({ machineJson: { version: 1, modules: { 'providers.antigravity': true }, antigravity: { accounts: [{ id, label: 'x' }] } } });
    const host = startModules([antigravityModule], { server, instance: resolveInstance('provider'), machine, services, stateDirectory: root, baseDirectory: root });
    assert.equal(host.status().modules[0]?.state, 'error', id);
    assert.deepEqual(providers, [], id);
  }
});

test('读不到 Paseo 的 config.json 时按旧插件仍启用处理：不注册账号，模块出错', () => {
  const { providers, server, services, machine, root } = createFakeEnv({ machineJson: baseMachine });
  writeFileSync(join(root, 'config.json'), '{坏');
  const host = startModules([antigravityModule], { server, instance: resolveInstance('provider'), machine, services, stateDirectory: root, baseDirectory: root });
  assert.deepEqual(providers, []);
  assert.equal(host.status().modules[0]?.state, 'error');
  assert.match(host.status().modules[0]?.reason ?? '', /config\.json 无法解析/);
});

test('account.add：机器配置或 Paseo 配置损坏时报错，什么都不写', async () => {
  for (const broken of ['machine', 'paseo'] as const) {
    const { root, machinePath, handlers, server, services } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo });
    registerAntigravityRpcs({ server, machinePath, services });
    const target = broken === 'machine' ? machinePath : join(root, 'config.json');
    writeFileSync(target, '{坏');
    const other = broken === 'machine' ? join(root, 'config.json') : machinePath;
    const before = readFileSync(other, 'utf8');
    const result = await handlers.get('antigravity.account.add')!({ providerId: 'antigravity-new', label: 'Antigravity · 新' });
    assert.match(result.error, /无法解析/);
    assert.equal(readFileSync(target, 'utf8'), '{坏');
    assert.equal(readFileSync(other, 'utf8'), before);
  }
});

test('account.add：先备份两处配置，直接写 Paseo 配置（command/env/label）再写机器配置，提示需要重载；不用 config.patch', async () => {
  const patches: unknown[] = [];
  const { root, machinePath, handlers, server, services } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo, patch: async p => { patches.push(p); return { config: {} }; } });
  registerAntigravityRpcs({ server, machinePath, services });
  const result = await handlers.get('antigravity.account.add')!({ providerId: 'antigravity-beibeimao', label: 'Antigravity · 账号二', homeDir: '~/.agy-2', proxy: 'http://127.0.0.1:7897' });
  assert.equal(result.error, null);
  assert.equal(result.reloadRequired, true);
  assert.deepEqual(result.accounts[1], { providerId: 'antigravity-beibeimao', label: 'Antigravity · 账号二', enabled: true, homeDir: '~/.agy-2' });
  assert.deepEqual(patches, []);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).agents.providers['antigravity-beibeimao'], {
    enabled: true, label: 'Antigravity · 账号二', command: ['agy'], env: { HOME: '~/.agy-2', HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' },
  });
  assert.equal(readMachine(machinePath).antigravity.accounts[1].providerId, 'antigravity-beibeimao');
  assert.equal(backupsOf(root, 'config.json').length, 1);
  assert.equal(backupsOf(root, 'machine.json').length, 1);
  const duplicate = await handlers.get('antigravity.account.add')!({ providerId: 'antigravity-beibeimao', label: '重复' });
  assert.match(duplicate.error, /已存在/);
  const invalid = handlers.get('antigravity.account.add');
  assert.ok(invalid);
});

test('account.add：第二处（机器配置）写入失败时，用备份恢复第一处（Paseo 配置）', async () => {
  const { root, machinePath, handlers, server, services } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo });
  const before = readFileSync(join(root, 'config.json'), 'utf8');
  registerAntigravityRpcs({ server, machinePath, services, writeJson: (path, data) => { if (path === machinePath) throw new Error('磁盘已满'); writeJsonFile(path, data); } });
  const result = await handlers.get('antigravity.account.add')!({ providerId: 'antigravity-new', label: 'Antigravity · 新' });
  assert.match(result.error, /磁盘已满.*已恢复/);
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), before);
  assert.equal(readMachine(machinePath).antigravity.accounts.length, 1);
});

test('account.toggle：先备份机器配置，只发 { providers: { [id]: { enabled } } } 并检查返回', async () => {
  const patches: unknown[] = [];
  const { root, machinePath, handlers, server, services } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo, patch: async p => { patches.push(p); return { requestId: 'r', config: { providers: { 'antigravity-cy517': { enabled: false } } } }; } });
  registerAntigravityRpcs({ server, machinePath, services });
  const result = await handlers.get('antigravity.account.toggle')!({ providerId: 'antigravity-cy517', enabled: false });
  assert.deepEqual(patches, [{ providers: { 'antigravity-cy517': { enabled: false } } }]);
  assert.equal(result.error, null);
  assert.equal(result.accounts[0].enabled, false);
  assert.equal(result.reloadRequired, true);
  assert.equal(readMachine(machinePath).antigravity.accounts[0].enabled, false);
  assert.equal(backupsOf(root, 'machine.json').length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).agents.providers['antigravity-cy517'].enabled, true, '不再直接改 Paseo 配置，由守护进程保存');
});

test('account.toggle：补丁失败或返回值与请求不符时，机器配置恢复原样并报错', async () => {
  for (const patch of [async () => { throw new Error('守护进程拒绝'); }, async () => ({ config: { providers: { 'antigravity-cy517': { enabled: true } } } }), async () => ({ config: {} })]) {
    const { machinePath, handlers, server, services } = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo, patch });
    const before = readFileSync(machinePath, 'utf8');
    registerAntigravityRpcs({ server, machinePath, services });
    const result = await handlers.get('antigravity.account.toggle')!({ providerId: 'antigravity-cy517', enabled: false });
    assert.match(result.error, /没有生效.*machine\.json 已恢复/);
    assert.equal(readFileSync(machinePath, 'utf8'), before);
    assert.equal(result.accounts[0].enabled, true);
  }
});

test('“需要重载”由实际注册情况推出：配置变化后为 true，重载（重新注册）后自动清除', async () => {
  const env = createFakeEnv({ machineJson: baseMachine, paseoConfigJson: basePaseo });
  const start = () => startModules([antigravityModule], { server: env.server, instance: resolveInstance('provider'), machine: loadMachineConfig(env.machinePath, { [antigravityModule.config!.section]: antigravityModule.config!.spec }), services: env.services, stateDirectory: env.root, baseDirectory: env.root });
  start();
  assert.equal((await env.handlers.get('antigravity.snapshot')!({})).reloadRequired, false);
  await env.handlers.get('antigravity.account.toggle')!({ providerId: 'antigravity-cy517', enabled: false });
  assert.equal((await env.handlers.get('antigravity.snapshot')!({})).reloadRequired, true);
  start();
  assert.equal((await env.handlers.get('antigravity.snapshot')!({})).reloadRequired, false);
});
