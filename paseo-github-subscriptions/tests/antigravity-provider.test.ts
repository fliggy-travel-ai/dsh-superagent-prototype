import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  const daemon = new SharedDaemon(root, (async () => ({
    paseo: {} as never,
    client: {
      fetchAgents: async () => ({
        entries: (options.runningAgents ?? []).map(agent => ({ agent })),
        pageInfo: { hasMore: false },
      }),
    } as never,
    approve: async () => {},
    respond: async () => {},
    async close() {},
  })) as never);

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

test('antigravity.* RPC：snapshot、account.add（写两处配置）与 account.toggle 返回 reloadRequired: true', async () => {
  const { root, machinePath, handlers, server, services } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'providers.antigravity': true },
      antigravity: {
        accounts: [
          { id: 'antigravity-cy517', label: 'Antigravity · 账号一', homeDir: '~/.agy-1' },
        ],
      },
    },
    paseoConfigJson: {
      agents: {
        providers: {
          'antigravity-cy517': {
            enabled: true,
            label: 'Antigravity · 账号一',
            command: ['/usr/local/bin/agy-paseo'],
            env: { HOME: '~/.agy-1' },
          },
        },
      },
    },
    runningAgents: [
      { id: 'a1', provider: 'antigravity-cy517/gemini-3.8', status: 'running' },
      { id: 'a2', provider: 'antigravity-beibeimao', status: 'idle' },
      { id: 'a3', provider: 'codex', status: 'running' },
    ],
  });

  registerAntigravityRpcs({ server, machinePath, services });

  // 1. 初始快照
  const initial = await handlers.get('antigravity.snapshot')!({});
  assert.equal(initial.enabled, true);
  assert.equal(initial.reloadRequired, false);
  assert.equal(initial.runningSessionsCount, 1);
  assert.equal(initial.error, null);
  assert.deepEqual(initial.accounts, [
    {
      providerId: 'antigravity-cy517',
      label: 'Antigravity · 账号一',
      enabled: true,
      homeDir: '~/.agy-1',
    },
  ]);

  // 2. 添加新账号：同时写 machine.json 与 config.json，并调用 paseo.config.patch
  const patched: unknown[] = [];
  const afterAdd = await handlers.get('antigravity.account.add')!(
    {
      providerId: 'antigravity-beibeimao',
      label: 'Antigravity · 账号二',
      homeDir: '~/.agy-2',
      proxy: 'http://127.0.0.1:7897',
    },
    {
      paseo: {
        config: {
          patch: async (payload: unknown) => {
            patched.push(payload);
          },
        },
      },
    },
  );

  assert.equal(afterAdd.reloadRequired, true);
  assert.equal(afterAdd.error, null);
  assert.equal(afterAdd.accounts.length, 2);
  assert.deepEqual(afterAdd.accounts[1], {
    providerId: 'antigravity-beibeimao',
    label: 'Antigravity · 账号二',
    enabled: true,
    homeDir: '~/.agy-2',
  });
  assert.equal(patched.length, 1);

  const savedMachine = JSON.parse(readFileSync(machinePath, 'utf8'));
  assert.equal(savedMachine.antigravity.accounts.length, 2);
  assert.equal(savedMachine.antigravity.accounts[1].providerId, 'antigravity-beibeimao');

  const savedPaseoConfig = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  assert.deepEqual(savedPaseoConfig.agents.providers['antigravity-beibeimao'], {
    enabled: true,
    label: 'Antigravity · 账号二',
    command: ['agy'],
    env: {
      HOME: '~/.agy-2',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
    },
  });

  // 3. 重复添加同名账号返回错误且不破坏列表
  const duplicateAdd = await handlers.get('antigravity.account.add')!({
    providerId: 'antigravity-beibeimao',
    label: '重复账号',
  });
  assert.match(duplicateAdd.error ?? '', /已存在/);
  assert.equal(duplicateAdd.accounts.length, 2);

  // 4. 切换账号启用状态：更新两处配置并返回 reloadRequired: true
  const afterToggle = await handlers.get('antigravity.account.toggle')!({
    providerId: 'antigravity-beibeimao',
    enabled: false,
  });
  assert.equal(afterToggle.reloadRequired, true);
  assert.equal(afterToggle.accounts[1]?.enabled, false);

  const toggledPaseoConfig = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  assert.equal(toggledPaseoConfig.agents.providers['antigravity-beibeimao'].enabled, false);
});
