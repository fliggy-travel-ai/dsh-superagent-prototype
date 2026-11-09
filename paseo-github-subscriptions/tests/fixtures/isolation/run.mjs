import '../../resolve-js-to-ts.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';

const mode = process.argv[2];
assert.ok(['cloud-fails', 'github-fails', 'github-runtime-fails', 'presence-fails', 'browser-fails'].includes(mode));
const tempHome = mkdtempSync(join(tmpdir(), 'ghsub-isolation-'));
process.env.PASEO_HOME = tempHome;
process.env.PASEO_GHSUB_STATE_DIR = tempHome;
process.env.PASEO_GHSUB_MACHINE_CONFIG = join(tempHome, 'machine.json');
writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ plugins: {} }));
writeFileSync(
  join(tempHome, 'machine.json'),
  JSON.stringify({
    version: 1,
    modules: {
      'usage.claudeAccounts': false,
      'answer.escalation': false,
      'answer.quietChildren': false,
    },
  }),
);
class FakeRuntime {
  storage = { state: { preferences: { shadow: true }, subscriptions: [{ agentId: 'agent', id: 'subscription' }] } };
  vault = { redact: error => String(error) };
  async start() { if (mode === 'github-runtime-fails') throw new Error('github runtime failed'); }
  async stop() {}
  snapshot() { return { marker: 'github snapshot' }; }
}
const fakeModule = (name, exportName, marker, failure) => {
  class Fake { async start() { if (mode === failure) throw new Error(`${marker} failed`); } async stop() {} snapshot() { return { marker }; } }
  mock.module(new URL(`../../../server/${name}.ts`, import.meta.url).href, { namedExports: { [exportName]: Fake } });
};
fakeModule('presence', 'PresenceRuntime', 'presence', 'presence-fails');
fakeModule('browser-bridge', 'BrowserBridge', 'browser', 'browser-fails');
class FakeHosts { async stop() {} }
mock.module(new URL('../../../server/presence-port.ts', import.meta.url).href, { namedExports: { PresenceHosts: FakeHosts, presencePort: () => ({}) } });
mock.module(new URL('../../../server/runtime.ts', import.meta.url).href, { namedExports: { Runtime: FakeRuntime } });
mock.module(new URL('../../../server/daemon.ts', import.meta.url).href, { namedExports: {
  connectDaemon: async () => { if (mode === 'github-fails') throw new Error('github connection failed'); return { paseo: {}, client: {}, approve() {}, close: async () => {} }; },
} });
const { default: contribute } = await import('../../../index.server.ts');
const handlers = new Map();
const hooks = new Map();
let provider;
const server = {
  registerProvider(value) { if (mode === 'cloud-fails') throw new Error('cloud registration failed Bearer pretend-secret https://example.invalid/?credential=pretend-query'); provider = value; },
  handle(contract, handler) { handlers.set(contract.name, handler); },
  addHook(name, handler) { hooks.set(name, handler); return () => hooks.delete(name); },
};
const previousError = console.error;
const logs = [];
console.error = (...args) => logs.push(args.join(' '));
const cleanup = contribute(server);
const call = name => handlers.get(name)({}, {});
try {
  if (mode === 'cloud-fails') {
    assert.equal(logs.length, 1); assert.match(logs[0], /cloud registration failed/);
    assert.ok(!logs[0].includes('pretend-secret')); assert.ok(!logs[0].includes('pretend-query')); assert.ok(!logs[0].includes('example.invalid'));
    const hook = hooks.get('agent.open.before');
    const request = await hook({ request: { purpose: 'conversation', tools: [] } });
    const tool = request.tools.find(entry => entry.name === 'github_list_subscriptions');
    assert.ok(tool);
    const result = await tool.execute({}, { agent: { id: 'agent' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { shadow: true, subscriptions: [{ agentId: 'agent', id: 'subscription' }] });
  } else {
    assert.equal((await provider.status()).available, true);
    const result = await handlers.get('cloud-session.inbox.poll')({ cloudSessionId: 'cse_abcdefgh1234', afterSeq: 0, waitMs: 0 }, {});
    assert.ok(result.epoch); assert.deepEqual(result.items, []);
    const conn = await provider.connect({ versions: [1], capabilities: [] });
    const events = []; conn.onEvent(event => events.push(event));
    await conn.send({ type: 'sessions', requestId: 'request' });
    assert.equal(events[0]?.type, 'sessions'); await conn.close();
  }
  if (mode === 'github-fails') {
    await assert.rejects(call('subscriptions.snapshot'), /github connection failed/);
  } else {
    for (const [name, marker, failure] of [
      ['subscriptions.snapshot', 'github snapshot', 'github-runtime-fails'],
      ['presence.snapshot', 'presence', 'presence-fails'],
      ['browser.snapshot', 'browser', 'browser-fails'],
    ]) {
      if (mode === failure) await assert.rejects(call(name), /failed/);
      else assert.deepEqual(await call(name), { marker });
    }
  }
} finally {
  await cleanup(); console.error = previousError; mock.reset(); rmSync(tempHome, { recursive: true, force: true });
}
