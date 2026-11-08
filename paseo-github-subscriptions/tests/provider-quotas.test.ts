import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { UsageSourceRegistration } from '@getpaseo/plugin/server/usage';
import { resolveInstance } from '../shared/instances.ts';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { startModules } from '../server/core/modules.ts';
import { SharedDaemon } from '../server/core/daemon.ts';
import {
  providerQuotasModule,
  registerProviderQuotasRpcs,
} from '../server/modules/usage-provider-quotas/index.ts';
import {
  builtinPluginIdsFor,
  normalizeHideBuiltinId,
  normalizeUsagePins,
  suppressBuiltinUsagePlugins,
} from '../server/modules/usage-provider-quotas/hide-builtin.ts';
import { sanitizeUsageReport } from '../server/modules/usage-provider-quotas/server/usage-display.ts';
import { parseTokenHubCredits } from '../server/modules/usage-provider-quotas/server/token-hub-quota.ts';
import type { Services } from '../server/modules/types.ts';

function createFakeEnv(options: {
  machineJson?: Record<string, unknown>;
  paseoConfigJson?: Record<string, unknown>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'ghsub-quotas-test-'));
  const machinePath = join(root, 'machine.json');
  if (options.machineJson) {
    writeFileSync(machinePath, JSON.stringify(options.machineJson, null, 2));
  }
  if (options.paseoConfigJson) {
    writeFileSync(join(root, 'config.json'), JSON.stringify(options.paseoConfigJson, null, 2));
  }

  const usageSources: UsageSourceRegistration[] = [];
  const handlers = new Map<string, (input: any, ctx?: any) => Promise<any>>();
  const server = {
    registerProvider() {},
    registerUsageSource(source: UsageSourceRegistration) {
      usageSources.push(source);
    },
    handle(contract: { name: string }, handler: (input: any, ctx?: any) => Promise<any>) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => {};
    },
  } as unknown as PluginServerContext;

  const daemon = new SharedDaemon(root, (async () => ({
    paseo: {} as never,
    client: {} as never,
    approve: async () => {},
    respond: async () => {},
    async close() {},
  })) as never);

  const services: Services = { home: root, daemon, main: null };
  const sections = {
    [providerQuotasModule.config!.section]: providerQuotasModule.config!.spec,
  };
  const machine = loadMachineConfig(machinePath, sections);

  return { root, machinePath, usageSources, handlers, server, services, machine };
}

test('usage.providerQuotas：默认关闭时不注册任何额度来源', () => {
  const { usageSources, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      providerQuotas: {
        sources: ['antigravity', 'codex-multi'],
      },
    },
  });

  const host = startModules([providerQuotasModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.equal(usageSources.length, 0);
  assert.equal(host.status().modules[0]?.state, 'off');
});

test('usage.providerQuotas：按配置开关逐个来源启用，并确保 glm 只注册一次', () => {
  const { usageSources, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'usage.providerQuotas': true },
      providerQuotas: {
        sources: ['antigravity', 'codex-multi', 'glm', 'glm', 'qoder'],
        hideBuiltin: ['codex', 'zai-usage-source'],
      },
    },
  });

  const host = startModules([providerQuotasModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.equal(host.status().modules[0]?.state, 'running');
  assert.deepEqual(
    usageSources.map(s => s.id),
    ['antigravity', 'codex-multi', 'qoder', 'glm'],
  );
});

test('usage.providerQuotas：旧插件 provider-quotas-usage-source 仍启用时跳过冲突来源并报错', () => {
  const { usageSources, handlers, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'usage.providerQuotas': true },
      providerQuotas: {
        sources: ['antigravity', 'codex-multi'],
      },
    },
    paseoConfigJson: {
      plugins: {
        'provider-quotas-usage-source': {
          source: 'directory',
          path: '/tmp/provider-quotas-usage-source',
          enabled: true,
        },
      },
    },
  });

  const host = startModules([providerQuotasModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.equal(usageSources.length, 0);
  const modStatus = host.status().modules[0];
  assert.equal(modStatus?.state, 'error');
  assert.match(modStatus?.reason ?? '', /provider-quotas-usage-source/);

  return handlers.get('provider-quotas.snapshot')!({}).then(snap => {
    assert.equal(snap.skippedConflicts.length, 2);
    assert.equal(snap.skippedConflicts[0].legacyPluginId, 'provider-quotas-usage-source');
    assert.match(snap.error ?? '', /provider-quotas-usage-source/);
  });
});

test('usage.providerQuotas：Mac Mini 旧插件 glm-usage-source 仍启用时只跳过 glm 并保留其余来源', async () => {
  const { usageSources, handlers, server, services, machine, root } = createFakeEnv({
    machineJson: {
      version: 1,
      modules: { 'usage.providerQuotas': true },
      providerQuotas: {
        sources: ['codex-multi', 'glm'],
      },
    },
    paseoConfigJson: {
      plugins: {
        'provider-quotas-usage-source': {
          source: 'directory',
          path: '/tmp/provider-quotas-usage-source',
          enabled: false,
        },
        'glm-usage-source': {
          source: 'directory',
          path: '/tmp/glm-usage-source',
          enabled: true,
        },
      },
    },
  });

  const host = startModules([providerQuotasModule], {
    server,
    instance: resolveInstance('main'),
    machine,
    services,
    stateDirectory: root,
    baseDirectory: root,
  });

  assert.deepEqual(usageSources.map(s => s.id), ['codex-multi']);
  assert.equal(host.status().modules[0]?.state, 'error');

  const snap = await handlers.get('provider-quotas.snapshot')!({});
  assert.deepEqual(snap.skippedConflicts, [
    {
      sourceId: 'glm',
      legacyPluginId: 'glm-usage-source',
      reason: '旧插件 glm-usage-source 仍启用，已跳过额度来源 glm',
    },
  ]);
});

test('provider-quotas.* RPC：模块未开启时也能查看快照并修改配置，写回 machine.json 且标记 reloadRequired: true', async () => {
  const { machinePath, handlers, server, services } = createFakeEnv({
    machineJson: {
      version: 1,
    },
  });

  registerProviderQuotasRpcs({ server, machinePath, services });

  const initial = await handlers.get('provider-quotas.snapshot')!({});
  assert.deepEqual(initial, {
    enabled: false,
    enabledSources: [],
    hideBuiltin: [],
    skippedConflicts: [],
    reloadRequired: false,
    error: null,
  });

  const updated = await handlers.get('provider-quotas.configure')!({
    enabled: true,
    enabledSources: ['antigravity', 'codex-multi', 'grok-multi'],
    hideBuiltin: ['codex', 'grok'],
  });

  assert.deepEqual(updated, {
    enabled: true,
    enabledSources: ['antigravity', 'codex-multi', 'grok-multi'],
    hideBuiltin: ['codex', 'grok'],
    skippedConflicts: [],
    reloadRequired: true,
    error: null,
  });

  const savedMachine = JSON.parse(readFileSync(machinePath, 'utf8'));
  assert.equal(savedMachine.modules['usage.providerQuotas'], true);
  assert.deepEqual(savedMachine.providerQuotas, {
    sources: ['antigravity', 'codex-multi', 'grok-multi'],
    hideBuiltin: ['codex', 'grok'],
  });
});

test('usage.providerQuotas：隐藏内置额度来源配置项与侧栏固定项过滤、脱敏及 TokenHub 计算', async () => {
  assert.equal(normalizeHideBuiltinId('codex'), 'codex');
  assert.equal(normalizeHideBuiltinId('zai-usage-source'), 'zai');
  assert.equal(normalizeHideBuiltinId('unknown-source'), null);
  assert.deepEqual(builtinPluginIdsFor(['codex', 'grok-usage-source', 'codex']), [
    'codex-usage-source',
    'grok-usage-source',
  ]);

  const patchedPayloads: Array<Record<string, unknown>> = [];
  const disabledIds: string[] = [];
  const { root } = createFakeEnv({
    paseoConfigJson: {
      plugins: {
        'github-subscriptions': { source: 'directory', path: '/tmp/ghsub', enabled: true },
      },
    },
  });

  const suppressRes = await suppressBuiltinUsagePlugins(['codex', 'zai'], {
    paseoHome: root,
    patchPlugins: async plugins => {
      patchedPayloads.push(plugins);
    },
    disablePlugin: async id => {
      disabledIds.push(id);
    },
  });
  assert.deepEqual(suppressRes.disabledPluginIds, ['codex-usage-source', 'zai-usage-source']);
  assert.deepEqual(disabledIds, ['codex-usage-source', 'zai-usage-source']);
  assert.equal(patchedPayloads.length, 2);
  assert.equal('codex-usage-source' in patchedPayloads[0]!, true);
  assert.equal('codex-usage-source' in patchedPayloads[1]!, false);

  const normalizedPins = normalizeUsagePins(
    [
      { sourceId: 'codex', windowId: '5h' },
      { sourceId: 'codex-multi', windowId: 'weekly' },
      { sourceId: 'codex-multi', windowId: 'effective' },
      { sourceId: 'claude-browser', windowId: '5h' },
    ],
    { hideBuiltin: ['codex'] },
  );
  assert.deepEqual(normalizedPins, [
    { sourceId: 'codex-multi', windowId: 'effective' },
    { sourceId: 'claude-browser', windowId: '5h' },
  ]);

  const sanitized = sanitizeUsageReport(
    {
      status: 'available',
      planLabel: 'Enterprise',
      windows: [{ id: 'effective', label: '5-hour limit', summary: true, remainingPct: 80 }],
      details: [{ id: 'provider_id', label: 'Provider ID', value: 'codex' }],
    },
    Date.parse('2026-11-09T00:00:00Z'),
  );
  assert.equal(sanitized.status, 'available');

  const credits = parseTokenHubCredits(
    {
      errorCode: 0,
      data: {
        zoneId: 'Asia/Shanghai',
        cycle: { startDate: '2026-11-01', nextStartDate: '2026-12-01' },
      },
    },
    {
      errorCode: 0,
      data: [
        {
          quotaPolicyCount: 1,
          credits: 250,
          quotaPolicy: { type: 0, creditsQuota: 1000 },
        },
      ],
    },
    Date.parse('2026-11-09T00:00:00Z'),
  );
  assert.equal(credits.total, 1000);
  assert.equal(credits.used, 250);
  assert.equal(credits.remaining, 750);
  assert.equal(credits.remainingPct, 75);
});
