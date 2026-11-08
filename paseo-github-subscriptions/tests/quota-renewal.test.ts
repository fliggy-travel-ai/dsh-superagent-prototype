import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RenewalService, renewalEnvironment, hasAuthOverride, renewed } from "../server/modules/usage-claude-accounts/renewal.ts";

const initial = { fingerprint: "old", refreshable: true, expires: 1000, identity: { key: "one.org" } };
test("renewal requires actual expiry advancement on the same account", () => {
 assert.equal(renewed(initial, initial, 1000), false);
 assert.equal(renewed(initial, { ...initial, expires: 3600000 }, 1000), true);
 assert.equal(renewed(initial, { ...initial, expires: 3600000, identity: { key: "other.org" } }, 1000), false);
});
test("renewal removes inherited auth overrides and preserves account directory and proxy", () => {
 const env = renewalEnvironment({ CLAUDE_CONFIG_DIR: "/one", HTTPS_PROXY: "http://proxy", ANTHROPIC_API_KEY: "test", CLAUDE_CODE_OAUTH_TOKEN: "test", CLAUDE_CODE_USE_VERTEX: "1", CLAUDECODE: "1" });
 assert.equal(env.CLAUDE_CONFIG_DIR, "/one"); assert.equal(env.HTTPS_PROXY, "http://proxy");
 assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined); assert.equal(env.CLAUDECODE, undefined);
 assert.equal(hasAuthOverride({ ANTHROPIC_BASE_URL: "https://proxy" }), true);
 assert.equal(hasAuthOverride({ CLAUDE_CONFIG_DIR: "/one" }), false);
});
test("failed renewal backs off, coalesces checks, and successful credential reread resets it", async () => {
 let now = 1000, calls = 0, refreshed = 0;
 let state = { ...initial };
 const service = new RenewalService({ now: () => now, targets: () => [{ id: "one", env: {} }], read: async () => state,
  run: async () => { calls++; if (calls === 2) state = { ...state, expires: now + 3600000 }; return "renewed"; },
  onRenewed: async () => { refreshed++; } });
 await Promise.all([service.tick(), service.tick()]); assert.equal(calls, 1); assert.equal(refreshed, 0);
 now += 9 * 60000; await service.tick(); assert.equal(calls, 1);
 now += 60000; await service.tick(); assert.equal(calls, 2); assert.equal(refreshed, 1);
 await service.stop(); await service.tick(); assert.equal(calls, 2);
});
test("unexpected model output disables subsequent renewal attempts", async () => {
 let calls = 0;
 const service = new RenewalService({ now: () => 1000, targets: () => [{ id: "one", env: {} }, { id: "two", env: {} }], read: async () => initial,
  run: async () => { calls++; return "unexpected-model-output"; }, onRenewed: async () => {} });
 await service.tick(); await service.tick(); assert.equal(calls, 1); await service.stop();
});
test("healthy, non-refreshable, and undated credentials do not start a CLI", async () => {
 let calls = 0;
 const states = [{ ...initial, expires: 10_000_000 }, { ...initial, refreshable: false }, { ...initial, expires: undefined }];
 const service = new RenewalService({ now: () => 1000, targets: () => states.map((_, i) => ({ id: String(i), env: {} })), read: async t => states[Number(t.id)], run: async () => { calls++; return "unchanged"; }, onRenewed: async () => {} });
 await service.tick(); assert.equal(calls, 0); await service.stop();
});

test("临近过期时短暂失败，一分钟后重试，不跨过到期时间等待", async () => {
 let now = 1000, calls = 0, refreshed = 0;
 let state = { ...initial, expires: now + 4 * 60000 };
 const service = new RenewalService({ now: () => now, targets: () => [{ id: "one", env: {} }], read: async () => state,
  run: async () => { calls++; if (calls === 2) state = { ...state, expires: now + 3600000 }; return "unchanged"; },
  onRenewed: async () => { refreshed++; } });
 await service.tick(); assert.equal(calls, 1);
 now += 60000; await service.tick(); assert.equal(calls, 2); assert.equal(refreshed, 1);
 await service.stop();
});

test("到期前的失败不累计到过期后的长等待", async () => {
 let now = 1000, calls = 0;
 const state = { ...initial, expires: now + 4 * 60000 };
 const service = new RenewalService({ now: () => now, targets: () => [{ id: "one", env: {} }], read: async () => state,
  run: async () => { calls++; return "unchanged"; }, onRenewed: async () => {} });
 for (let i = 0; i < 4; i++) { await service.tick(); now += 60000; }
 await service.tick(); assert.equal(calls, 5);
 now += 9 * 60000; await service.tick(); assert.equal(calls, 5);
 now += 60000; await service.tick(); assert.equal(calls, 6);
 await service.stop();
});
