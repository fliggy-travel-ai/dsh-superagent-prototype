import assert from "node:assert/strict";
import { test } from "node:test";
import { accountQuota, applyQuotaLabels, baseLabel, type Quota, withQuota } from "../server/modules/usage-claude-accounts/labels.ts";

const key = "acct.org";
const now = Date.parse("2026-11-02T12:00:00Z");
const resetAt = Date.parse("2026-11-04T17:30:00Z");
const quota = (remainingPct: number, weeklyResetAt: number | null = null): Quota => ({ remainingPct, weeklyResetAt });
const report = (windows: object[], sourceId = "claude-accounts", status = "available") => ({
  id: `${sourceId}:${key}`,
  sourceId,
  report: { status, windows },
});

test("取 5 小时额度和每周额度中剩余较少的一个", () => {
  const reports = [report([
    { id: "five_hour", usedPct: 19, remainingPct: 81 },
    { id: "weekly", usedPct: 36, remainingPct: 64 },
    { id: "weekly_model_fable", usedPct: 99, remainingPct: 1 },
  ])];
  assert.deepEqual(accountQuota(reports, key), quota(64));
});

test("没有剩余百分比时用已用百分比计算，并限制在 0 到 100", () => {
  assert.deepEqual(accountQuota([report([{ id: "five_hour", usedPct: 120 }])], key), quota(0));
  assert.deepEqual(accountQuota([report([{ id: "weekly", usedPct: 12.4 }])], key), quota(88));
});

test("账号不匹配、额度不可用或来源不是 Claude 时返回空", () => {
  const windows = [{ id: "five_hour", remainingPct: 50 }];
  assert.equal(accountQuota([report(windows)], "other"), null);
  assert.equal(accountQuota([report(windows, "claude-accounts", "unavailable")], key), null);
  assert.equal(accountQuota([report(windows, "codex")], key), null);
  assert.deepEqual(accountQuota([report(windows, "claude")], key), quota(50));
});

test("额度放在“Claude · ”和账号名之间，可以重复替换和去除，旧版格式会被去除", () => {
  const name = "Claude · a@example.com（Apple 登录）";
  const shown = (pct: number) => `Claude · 剩 ${pct}% · a@example.com（Apple 登录）`;
  assert.equal(withQuota(name, quota(62)), shown(62));
  assert.equal(withQuota(shown(62), quota(5)), shown(5));
  assert.equal(withQuota(shown(62), null), name);
  assert.equal(withQuota(`剩 62%｜${name}`, quota(7)), shown(7));
  assert.equal(withQuota(`${name}｜剩 62%`, quota(7)), shown(7));
  assert.equal(withQuota("Work", quota(30)), "剩 30% · Work");
  assert.equal(withQuota("剩 30% · Work", null), "Work");
  assert.equal(baseLabel(name), name);
});

test("只修改指定的 Provider，缺少额度时恢复原名称", () => {
  const providers: Record<string, { label?: unknown }> = {
    claude: { label: "Claude · a" },
    "claude-2": { label: "Claude · 剩 40% · b" },
    "claude-3": {},
    codex: { label: "Codex" },
  };
  const changed = applyQuotaLabels(providers, ["claude", "claude-2", "claude-3"], new Map([["claude", quota(70)]]));
  assert.deepEqual(changed, ["claude", "claude-2"]);
  assert.equal(providers.claude.label, "Claude · 剩 70% · a");
  assert.equal(providers["claude-2"].label, "Claude · b");
  assert.equal(providers["claude-3"].label, undefined);
  assert.equal(providers.codex.label, "Codex");
  assert.deepEqual(applyQuotaLabels(providers, ["claude"], new Map([["claude", quota(70)]])), []);
});

test("每周额度耗尽时，显示每周重置倒计时而不是 5 小时重置倒计时", () => {
  const value = accountQuota([report([
    { id: "five_hour", remainingPct: 0, resetsAt: "2026-11-02T13:00:00Z" },
    { id: "weekly", remainingPct: 0, resetsAt: "2026-11-04T17:30:00Z" },
  ])], key);
  assert.deepEqual(value, quota(0, resetAt));
  assert.equal(withQuota("Claude · 剩 0% · a", value, now), "Claude · 重置剩余 2d5h30m · a");
});

test("没有剩余百分比时，已用每周额度 100% 也显示倒计时", () => {
  const value = accountQuota([report([{ id: "weekly", usedPct: 100, resetsAt: "2026-11-04T17:30:00Z" }])], key);
  assert.equal(withQuota("Claude · a", value, now), "Claude · 重置剩余 2d5h30m · a");
});

test("只有 5 小时或特定模型的每周额度耗尽时，保持剩余百分比", () => {
  const value = accountQuota([report([
    { id: "five_hour", remainingPct: 0, resetsAt: "2026-11-02T13:00:00Z" },
    { id: "weekly", remainingPct: 50, resetsAt: "2026-11-04T17:30:00Z" },
    { id: "weekly_model_fable", remainingPct: 0, resetsAt: "2026-11-04T17:30:00Z" },
  ])], key);
  assert.equal(withQuota("Claude · a", value, now), "Claude · 剩 0% · a");
});

test("每周额度还有小于 0.5% 的剩余时，不显示重置倒计时", () => {
  const value = accountQuota([report([{ id: "weekly", remainingPct: 0.4, resetsAt: "2026-11-04T17:30:00Z" }])], key);
  assert.deepEqual(value, quota(0));
});

test("每周重置时间缺失或无效时，保持剩 0%", () => {
  for (const resetsAt of [undefined, null, "", "invalid"]) {
    const value = accountQuota([report([{ id: "weekly", remainingPct: 0, resetsAt }])], key);
    assert.equal(withQuota("Claude · a", value, now), "Claude · 剩 0% · a");
  }
});

test("倒计时按分钟更新，跨天和跨小时正确，到期后不显示负数", () => {
  const value = quota(0, resetAt);
  assert.equal(withQuota("Work", value, now + 60_000), "重置剩余 2d5h29m · Work");
  assert.equal(withQuota("Work", value, resetAt - 24 * 60 * 60_000), "重置剩余 1d0h0m · Work");
  assert.equal(withQuota("Work", value, resetAt - 60 * 60_000), "重置剩余 0d1h0m · Work");
  assert.equal(withQuota("Work", value, resetAt - 59_999), "重置剩余 0d0h1m · Work");
  assert.equal(withQuota("Work", value, resetAt), "重置剩余 0d0h0m · Work");
  assert.equal(withQuota("Work", value, resetAt + 60_000), "重置剩余 0d0h0m · Work");
});

test("倒计时可以重复替换，额度恢复、缺失或插件停止后清除旧倒计时", () => {
  const label = "Claude · 重置剩余 2d5h30m · a";
  assert.equal(withQuota(label, quota(0, resetAt), now + 60_000), "Claude · 重置剩余 2d5h29m · a");
  assert.equal(withQuota(label, quota(80), now), "Claude · 剩 80% · a");
  assert.equal(withQuota(label, null, now), "Claude · a");
  assert.equal(baseLabel("重置剩余 0d1h2m · Work"), "Work");
  const providers = { claude: { label: "Claude · a" } };
  const values = new Map([["claude", quota(0, resetAt)]]);
  assert.deepEqual(applyQuotaLabels(providers, ["claude"], values, now), ["claude"]);
  assert.equal(providers.claude.label, label);
  assert.deepEqual(applyQuotaLabels(providers, ["claude"], values, now), []);
  assert.deepEqual(applyQuotaLabels(providers, ["claude"], new Map(), now), ["claude"]);
  assert.equal(providers.claude.label, "Claude · a");
});

test("历史额度标注上次剩，过滤已重置窗口，并可恢复原名称", () => {
  const now = Date.parse("2026-11-03T05:00:00Z");
  const reports = [{ sourceId: "claude-accounts", id: "claude-accounts:history", report: { status: "unavailable" }, lastSuccessful: {
    fetchedAt: "2026-11-03T04:30:00Z", report: { status: "available", windows: [
      { id: "five_hour", remainingPct: 1, resetsAt: "2026-11-03T04:59:00Z" },
      { id: "weekly", remainingPct: 40, resetsAt: "2026-11-07T05:00:00Z" },
    ] },
  } }];
  const quota = accountQuota(reports, "history", now);
  assert.deepEqual(quota, { remainingPct: 40, weeklyResetAt: null, historical: true });
  const label = withQuota("Claude · user@example.invalid", quota, now);
  assert.equal(label, "Claude · 上次剩 40% · user@example.invalid");
  assert.equal(withQuota(label, quota, now), label);
  assert.equal(withQuota(label, null), "Claude · user@example.invalid");
  assert.equal(accountQuota(reports, "history", now + 25 * 3600_000), null);
});

test("实时额度优先于历史额度，历史窗口没有重置时间时不显示", () => {
  const now = Date.parse("2026-11-03T05:00:00Z");
  const stale = { sourceId: "claude-accounts", id: "claude-accounts:history", report: { status: "error" }, lastSuccessful: {
    fetchedAt: "2026-11-03T04:30:00Z", report: { status: "available", windows: [{ id: "weekly", remainingPct: 40 }] },
  } };
  assert.equal(accountQuota([stale], "history", now), null);
  const live = { sourceId: "claude", id: "claude:history", report: { status: "available", windows: [{ id: "weekly", remainingPct: 20 }] } };
  assert.deepEqual(accountQuota([stale, live], "history", now), { remainingPct: 20, weeklyResetAt: null });
});
