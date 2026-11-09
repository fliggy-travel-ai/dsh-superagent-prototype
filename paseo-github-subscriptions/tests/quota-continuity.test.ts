import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageContinuity, digest, routeKey, readIdentity, HISTORY_MS } from "../server/modules/usage-claude-accounts/continuity.ts";
import type { UsageInput } from "../server/vendor/paseo-0.15.0/claude-usage-source/shared/input.ts";

const input: UsageInput = { route: { store: "claude", path: "/test/.credentials.json" } };
const original = { key: "account.org", label: "test@example.invalid", harness: "Claude", input };
const fallback = { key: routeKey(input), harness: "Claude", input };
const credential = { fingerprint: digest("fake-access-a"), expires: 1, refreshable: true, identity: { key: original.key, label: original.label } };
const report = { status: "available" as const, windows: [{ id: "five_hour", label: "5 小时", remainingPct: 20, resetsAt: "2026-11-03T06:00:00Z" }] };
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "quota-continuity-test-"));
 let now = Date.parse("2026-11-03T05:00:00Z");
 const path = join(dir, "cache.json");
 return { dir, path, create: () => new UsageContinuity(path, () => now), advance: (ms: number) => { now += ms; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}
test("expired identity stays stable across plugin restart and token rotation", () => {
 const f = fixture(); try {
  const first = f.create(); first.observe(original, credential, credential); first.record(input, credential, credential, report);
  const second = f.create();
  const rotated = { ...credential, fingerprint: digest("fake-access-b") };
  assert.equal(second.observe(fallback, rotated, rotated).key, original.key);
  assert.equal(second.observe(fallback, rotated, rotated).label, original.label);
  assert.equal(second.cached(original.key)?.report.windows[0].remainingPct, 20);
  // A local fallback can show old history, but must not accept fresh quota before the API verifies the new token's identity.
  assert.equal(second.matches(input, original.key, rotated), false);
  assert.equal(second.record(input, rotated, rotated, report), false);
 } finally { f.close(); }
});
test("API identity wins; credential or account changes in flight reject the result", () => {
 const f = fixture(); try {
  const cache = f.create();
  const localMismatch = { ...credential, identity: { key: "local.other" } };
  assert.equal(cache.observe(original, localMismatch, localMismatch).key, original.key);
  assert.equal(cache.observe(fallback, localMismatch, localMismatch).key, original.key);
  assert.equal(cache.matches(input, original.key, localMismatch), true);
  const changed = { ...localMismatch, fingerprint: digest("different") };
  assert.equal(cache.record(input, localMismatch, changed, report), false);
  assert.equal(cache.observe(original, localMismatch, changed).key, fallback.key);
  assert.equal(cache.cached(original.key), null);
 } finally { f.close(); }
});
test("verified token fallback works; missing metadata never invents an identity", () => {
 const f = fixture(); try {
  const cache = f.create(); const noIdentity = { ...credential, identity: undefined };
  assert.deepEqual(cache.observe(fallback, noIdentity, noIdentity), fallback);
  cache.observe(original, noIdentity, noIdentity);
  assert.equal(cache.observe(fallback, noIdentity, noIdentity).key, original.key);
  assert.equal(cache.matches(input, original.key, noIdentity), true);
  assert.equal(cache.observe(fallback, null, null).key, fallback.key);
  assert.equal(cache.matches(input, original.key, noIdentity), false);
 } finally { f.close(); }
});
test("history stores no email or token-derived value and expires after a day", () => {
 const f = fixture(); try {
  const cache = f.create(); cache.observe(original, credential, credential); cache.record(input, credential, credential, report);
  const raw = readFileSync(f.path, "utf8");
  for (const secret of [credential.fingerprint, original.label, "fake-access-a", input.route.store === "claude" ? input.route.path : ""]) assert.equal(raw.includes(secret), false);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  f.advance(HISTORY_MS + 1); assert.equal(cache.cached(original.key), null);
 } finally { f.close(); }
});
test("identity file parsing tolerates missing or malformed state", () => {
 const f = fixture(); try {
  const path = join(f.dir, ".claude.json"); assert.equal(readIdentity(path), undefined);
  writeFileSync(path, "bad"); assert.equal(readIdentity(path), undefined);
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: "account", organizationUuid: "org", emailAddress: original.label } }));
  assert.deepEqual(readIdentity(path), { key: original.key, label: original.label });
 } finally { f.close(); }
});
