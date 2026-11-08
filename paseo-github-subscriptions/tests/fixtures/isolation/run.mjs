import assert from 'node:assert/strict';
import { mock } from 'node:test';

const mode = process.argv[2];
assert.ok(['cloud-fails', 'github-fails'].includes(mode));
class FakeRuntime {
  storage = { state: { preferences: { shadow: true }, subscriptions: [{ agentId: 'agent', id: 'subscription' }] } };
  vault = { redact: error => String(error) };
  async start() {}
  async stop() {}
  snapshot() { return { marker: 'github snapshot' }; }
}
mock.module(new URL('../../../server/runtime.ts', import.meta.url).href, { namedExports: { Runtime: FakeRuntime } });
mock.module(new URL('../../../server/daemon.ts', import.meta.url).href, { namedExports: {
  connectDaemon: async () => { if (mode === 'github-fails') throw new Error('github connection failed'); return { paseo: {}, close: async () => {} }; },
} });
const { default: contribute } = await import('../../../index.server.ts');
const handlers = new Map();
const hooks = new Map();
let provider;
const server = {
  registerProvider(value) { if (mode === 'cloud-fails') throw new Error('cloud registration failed'); provider = value; },
  handle(contract, handler) { handlers.set(contract.name, handler); },
  addHook(name, handler) { hooks.set(name, handler); return () => hooks.delete(name); },
};
const previousError = console.error;
console.error = () => {};
const cleanup = contribute(server);
try {
  if (mode === 'cloud-fails') {
    assert.deepEqual(await handlers.get('subscriptions.snapshot')({}, {}), { marker: 'github snapshot' });
    const hook = hooks.get('agent.open.before');
    const request = await hook({ request: { purpose: 'conversation', tools: [] } });
    const tool = request.tools.find(entry => entry.name === 'github_list_subscriptions');
    assert.ok(tool);
    const result = await tool.execute({}, { agent: { id: 'agent' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { shadow: true, subscriptions: [{ agentId: 'agent', id: 'subscription' }] });
  } else {
    await assert.rejects(handlers.get('subscriptions.snapshot')({}, {}), /github connection failed/);
    assert.equal((await provider.status()).available, true);
    const result = await handlers.get('cloud-session.inbox.poll')({ cloudSessionId: 'cse_abcdefgh1234', afterSeq: 0, waitMs: 0 }, {});
    assert.ok(result.epoch); assert.deepEqual(result.items, []);
    const conn = await provider.connect({ versions: [1], capabilities: [] });
    const events = []; conn.onEvent(event => events.push(event));
    await conn.send({ type: 'sessions', requestId: 'request' });
    assert.equal(events[0]?.type, 'sessions');
    await conn.close();
  }
} finally {
  await cleanup();
  console.error = previousError;
  mock.reset();
}
