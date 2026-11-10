import '../../resolve-js-to-ts.mjs';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const role = process.argv[2] === 'legacy' ? null : process.argv[2];
const state = mkdtempSync(join(tmpdir(), 'ghsub-roles-'));
const fakeCli = join(state, 'paseo-cli');
writeFileSync(fakeCli, '#!/bin/sh\necho "[]"\n');
chmodSync(fakeCli, 0o755);
process.env.PASEO_CLI = fakeCli;
process.env.HOME = state;
process.env.PASEO_HOME = state;
process.env.PASEO_GHSUB_STATE_DIR = state;
process.env.PASEO_GHSUB_MACHINE_CONFIG = join(state, 'machine.json');
writeFileSync(join(state, 'config.json'), JSON.stringify({ plugins: {} }));
writeFileSync(join(state, 'machine.json'), JSON.stringify({ version: 1, modules: { 'providers.defaults': true }, agentDefaults: [{ provider: 'qoder', modeId: 'yolo' }] }));
const base = new URL('../../../', import.meta.url);
const at = path => new URL(path, base).href;
mock.module(at('shared/instance.ts'), { namedExports: { INSTANCE_ROLE: role } });
class Fake { async start() {} async stop() {} snapshot() { return {}; } }
for (const [file, name] of [['server/presence.ts', 'PresenceRuntime'], ['server/browser-bridge.ts', 'BrowserBridge'], ['server/runtime.ts', 'Runtime']]) mock.module(at(file), { namedExports: { [name]: Fake } });
mock.module(at('server/presence-port.ts'), { namedExports: { PresenceHosts: class { async stop() {} }, presencePort: () => ({}) } });
const invoked = [];
mock.module(at('server/daemon.ts'), { namedExports: { connectDaemon: async () => ({ paseo: {}, client: { invokePluginRpc: async (...args) => { invoked.push(args); return { forwarded: true }; } }, approve() {}, close: async () => {} }) } });
const { default: contribute } = await import(at('index.server.ts'));
const handlers = new Map(); const hooks = new Map(); const providers = []; const usage = [];
const server = {
  registerProvider(value) { providers.push(value.id); }, registerUsageSource(value) { usage.push(value.id); },
  handle(contract, handler) { handlers.set(contract.name, handler); },
  addHook(name, handler) { hooks.set(name, handler); return () => hooks.delete(name); },
};
const cleanup = contribute(server);
try {
  const status = await handlers.get('modules.status')({}, {});
  const ids = status.modules.map(m => m.id);
  const cloudRpc = 'cloud-session.inbox.poll';
  if (role === 'provider') {
    assert.deepEqual(status.instance, { role: 'provider', legacy: false });
    assert.deepEqual(ids, ['providers.cloudSession', 'providers.antigravity']);
    assert.deepEqual(providers, ['cloud-session']);
    assert.deepEqual(usage, []);
    assert.ok(handlers.has(cloudRpc));
    assert.ok(!handlers.has('subscriptions.snapshot'));
    assert.ok(!handlers.has('cloud-bridge.answer-web-request'));
    assert.deepEqual([...hooks.keys()], []);
  } else if (role === 'main') {
    assert.deepEqual(status.instance, { role: 'main', legacy: false });
    assert.ok(!ids.includes('providers.cloudSession'));
    assert.ok(!ids.includes('providers.antigravity'));
    assert.ok(ids.includes('providers.cloudGateway'));
    assert.ok(ids.includes('usage.providerQuotas'));
    assert.deepEqual(providers, []);
    assert.deepEqual(usage, ['claude-browser', 'claude-accounts']);
    assert.ok(handlers.has('cloud-bridge.answer-web-request'));
    assert.ok(handlers.has('antigravity.snapshot'));
    assert.ok(handlers.has('provider-quotas.snapshot'));
    const result = await handlers.get(cloudRpc)({ cloudSessionId: 'cse_abcdefgh1234', afterSeq: 0, waitMs: 0 }, {});
    assert.deepEqual(result, { forwarded: true });
    assert.deepEqual(invoked, [['dev-automation-providers', cloudRpc, { cloudSessionId: 'cse_abcdefgh1234', afterSeq: 0, waitMs: 0 }]]);
    const created = await hooks.get('agent.create.before')({ request: { config: { provider: 'qoder' } } }, {});
    assert.equal(created.config.modeId, 'yolo');
  } else {
    assert.deepEqual(status.instance, { role: 'main', legacy: true });
    assert.ok(ids.includes('providers.cloudSession'));
    assert.ok(!ids.includes('providers.cloudGateway'));
    assert.deepEqual(providers, ['cloud-session']);
    assert.ok(!handlers.has('cloud-bridge.answer-web-request'));
    assert.ok(handlers.has('subscriptions.snapshot'));
  }
  assert.ok(status.modules.every(m => m.state !== 'error'), JSON.stringify(status.modules));
} finally {
  await cleanup(); mock.reset(); rmSync(state, { recursive: true, force: true });
}
