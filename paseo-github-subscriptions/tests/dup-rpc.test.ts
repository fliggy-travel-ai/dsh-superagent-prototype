import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { resolveInstance } from '../shared/instances.ts';
import { startPlugin } from '../server/core/plugin.ts';

// #1737：打开 providers.antigravity、usage.providerQuotas 后重载报 “Duplicate plugin RPC method”。
// 宿主替身和 Paseo 一样，对重复注册的 RPC、Provider 抛错。

function fakeHost() {
  const methods = new Map<string, number>();
  const providers = new Set<string>();
  const server = {
    handle(contract: { name: string }) {
      if (methods.has(contract.name)) throw new Error(`Duplicate plugin RPC method: ${contract.name}`);
      methods.set(contract.name, 1);
    },
    registerProvider(provider: { id: string }) {
      if (providers.has(provider.id)) throw new Error(`Duplicate plugin provider: ${provider.id}`);
      providers.add(provider.id);
    },
    registerUsageSource() {},
    registerSettings() { return { read: async () => ({ status: 'invalid', revision: '0', error: 'test' }), subscribe: () => () => {} }; },
    addHook() { return () => {}; }, on() { return () => {}; }, before() { return () => {}; },
  } as unknown as PluginServerContext;
  return { server, methods };
}

async function start(role: 'main' | 'provider' | null, modules: Record<string, boolean>) {
  const home = mkdtempSync(join(tmpdir(), 'dup-rpc-'));
  const state = join(home, 'github-subscriptions');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'machine.json'), JSON.stringify({ version: 1, modules }));
  const saved = { PASEO_HOME: process.env.PASEO_HOME, PASEO_GHSUB_STATE_DIR: process.env.PASEO_GHSUB_STATE_DIR, PASEO_GHSUB_MACHINE_CONFIG: process.env.PASEO_GHSUB_MACHINE_CONFIG };
  process.env.PASEO_HOME = home; process.env.PASEO_GHSUB_STATE_DIR = state; delete process.env.PASEO_GHSUB_MACHINE_CONFIG;
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  const { server, methods } = fakeHost();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = startPlugin(server, resolveInstance(role));
  } finally {
    console.error = original;
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // 临时目录里没有 daemon，插件的连接会等到超时；注册是同步完成的，清理只等 1 秒。
  return { methods, logs, close: async () => { await Promise.race([cleanup?.().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000).unref())]); rmSync(home, { recursive: true, force: true }); } };
}

const ON = { 'providers.antigravity': true, 'usage.providerQuotas': true };
const roles = [['兼容模式', null], ['main', 'main'], ['provider', 'provider']] as const;

for (const [label, role] of roles) {
  test(`${label}：打开 Antigravity 和其他 Provider 额度模块时没有重复注册`, async () => {
    const run = await start(role, ON);
    try {
      assert.deepEqual(run.logs.filter(line => /Duplicate|注册失败/.test(line)), []);
      if (role !== 'provider') {
        assert.ok(run.methods.has('antigravity.snapshot'));
        assert.ok(run.methods.has('provider-quotas.snapshot'));
      } else {
        assert.ok(run.methods.has('antigravity.snapshot'));
        assert.ok(!run.methods.has('provider-quotas.snapshot'));
      }
    } finally { await run.close(); }
  });

  test(`${label}：两个模块都关闭时，设置页要用的 RPC 由核心层兜底注册（provider 实例不需要）`, async () => {
    const run = await start(role, {});
    try {
      assert.deepEqual(run.logs.filter(line => /Duplicate|注册失败/.test(line)), []);
      assert.equal(run.methods.has('antigravity.snapshot'), role !== 'provider');
      assert.equal(run.methods.has('provider-quotas.snapshot'), role !== 'provider');
    } finally { await run.close(); }
  });
}
