import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QuotaAlerts,
  isQuotaError,
  postQuotaAlert,
  quotaWebhookCredentials,
  zeroedFindings,
  type QuotaAlertPayload,
  type UsageReportLike,
} from "../server/modules/answer-escalation/quota.ts";

const now = Date.parse("2026-11-05T10:00:00.000Z");
const report = (over: Partial<UsageReportLike> = {}): UsageReportLike => ({
  id: "claude-accounts:acc1",
  sourceId: "claude-accounts",
  account: { label: "a@example.com" },
  report: {
    status: "available",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        remainingPct: 0,
        resetsAt: "2026-11-05T13:00:00.000Z",
      },
    ],
    balances: [],
  },
  ...over,
});

test("0% 窗口、0 余额计入档位，过期重置与未知比例不计入", () => {
  const findings = zeroedFindings(
    report({
      report: {
        status: "available",
        windows: [
          { id: "five_hour", remainingPct: 0, resetsAt: "2026-11-05T13:00:00.000Z" },
          { id: "weekly", remainingPct: 0, resetsAt: "2026-11-05T09:00:00.000Z" },
          { id: "weekly2", remainingPct: 5, resetsAt: "2026-11-08T09:00:00.000Z" },
          { id: "novalue", remainingPct: null },
        ],
        balances: [
          { id: "credits", remaining: 0, unit: "credits" },
          { id: "credits2", remaining: null, unit: "credits" },
          { id: "usd", remaining: 3, unit: "usd" },
        ],
      },
    }),
    now,
  );
  assert.deepEqual(
    findings.map((f) => f.tier),
    ["window:five_hour", "balance:credits"],
  );
  assert.equal(findings[0].remainingPct, 0);
  assert.equal(findings[0].accountLabel, "a@example.com");
  assert.equal(zeroedFindings(report({ report: { status: "error" } }), now).length, 0);
});

test("限额报错文本识别，网络错误不误报", () => {
  assert.equal(isQuotaError("You've hit your usage limit. Resets at 3pm."), true);
  assert.equal(isQuotaError("429 insufficient balance"), true);
  assert.equal(isQuotaError("额度不足，无法继续"), true);
  assert.equal(isQuotaError("usage limit reached for this org"), true);
  assert.equal(isQuotaError("fetch failed: ECONNREFUSED"), false);
  assert.equal(isQuotaError(null), false);
});

test("凭据解析：环境变量、文件、缺省", async () => {
  assert.deepEqual(
    await quotaWebhookCredentials({ QUOTA_WEBHOOK_URL: "https://lb.example/hook", QUOTA_WEBHOOK_KEY: "tok" }),
    { url: "https://lb.example/hook", auth: "Authorization: Bearer tok" },
  );
  assert.deepEqual(
    await quotaWebhookCredentials({ QUOTA_WEBHOOK_URL: "https://lb.example/hook", QUOTA_WEBHOOK_KEY: "X-Key: v" }),
    { url: "https://lb.example/hook", auth: "X-Key: v" },
  );
  await assert.rejects(() =>
    quotaWebhookCredentials({ QUOTA_WEBHOOK_URL: "https://lb.example/hook" }),
  );
  const dir = await mkdtemp(join(tmpdir(), "quota-"));
  const path = join(dir, "quota-webhook.json");
  await writeFile(path, JSON.stringify({ url: "https://lb.example/hook", key: "filetok" }));
  await chmod(path, 0o600);
  assert.deepEqual(await quotaWebhookCredentials({}, path), {
    url: "https://lb.example/hook",
    auth: "Authorization: Bearer filetok",
  });
  assert.equal(
    await quotaWebhookCredentials({}, join(dir, "none.json"), join(dir, "no-files")),
    null,
  );
});

test("凭据解析：总控安全文件目录的 url/key 单行文件，json 优先于文件目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-files-"));
  const json = join(dir, "none.json");
  await writeFile(join(dir, "url"), "https://lb.example/hook\n");
  await writeFile(join(dir, "key"), "crsr_filetok");
  await chmod(join(dir, "key"), 0o600);
  assert.deepEqual(await quotaWebhookCredentials({}, json, join(dir)), {
    url: "https://lb.example/hook",
    auth: "Authorization: Bearer crsr_filetok",
  });
  const jsonDir = await mkdtemp(join(tmpdir(), "quota-json-"));
  await writeFile(
    join(jsonDir, "quota-webhook.json"),
    JSON.stringify({ url: "https://json.example/hook", key: "jsonkey" }),
  );
  assert.deepEqual(
    await quotaWebhookCredentials(
      {},
      join(jsonDir, "quota-webhook.json"),
      join(dir),
    ),
    { url: "https://json.example/hook", auth: "Authorization: Bearer jsonkey" },
  );
  await writeFile(join(dir, "url"), "http://insecure.example/hook");
  assert.equal(await quotaWebhookCredentials({}, json, join(dir)), null);
});

function fixture(reportsByAccount: Record<string, UsageReportLike[]>, enabled: () => boolean = () => true) {
  const posted: QuotaAlertPayload[] = [];
  const audits: Record<string, unknown>[] = [];
  let available = true;
  let clock = now;
  const alerts = new QuotaAlerts({
    listReports: async () => ({
      reports: Object.values(reportsByAccount).flat(),
    }),
    listAgentReports: async (agentId) => ({
      reports:
        agentId === "主会话"
          ? (reportsByAccount["claude-accounts:acc1"] || [])
          : [],
    }),
    credentials: async () => (available ? { url: "http://x", auth: "Authorization: Bearer t" } : null),
    post: async (payload) => {
      posted.push(payload);
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    mains: () => [
      { agentId: "主会话", workspaceId: "wks", title: "1566", provider: "claude-5" },
    ],
    machine: "macmini",
    hostId: "macmini",
    statePath: join(tmpdir(), `quota-alerts-${process.pid}-${posted.length}-${Math.random().toString(36).slice(2)}.json`),
    now: () => clock,
    enabled,
  });
  return { alerts, posted, audits, set: (r: UsageReportLike[]) => { reportsByAccount["claude-accounts:acc1"] = r; }, recover: () => (available = true), cut: () => (available = false), tick: (ms: number) => (clock += ms) };
}

test("升级通知关闭时额度报警不发送，重新开启后仍能发送", async () => {
  let enabled = false;
  const f = fixture({ "claude-accounts:acc1": [report()] }, () => enabled);
  await f.alerts.start();
  f.alerts.stop();
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 0);
  enabled = true;
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 1);
});

test("同一账号同一档只推一次，恢复后重新武装", async () => {
  const f = fixture({ "claude-accounts:acc1": [report()] });
  await f.alerts.start();
  f.alerts.stop();
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].event, "quota_zero");
  assert.equal(f.posted[0].remainingPct, 0);
  assert.equal(f.posted[0].resetsAt, "2026-11-05T13:00:00.000Z");
  assert.deepEqual(f.posted[0].affectedMainAgentIds, ["主会话"]);
  assert.equal(f.posted[0].account.label, "a@example.com");
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 1);
  f.set([
    report({
      report: {
        status: "available",
        windows: [{ id: "five_hour", remainingPct: 40, resetsAt: "2026-11-05T13:00:00.000Z" }],
        balances: [],
      },
    }),
  ]);
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.filter((p) => p.event === "quota_zero").length, 1);
  assert.ok(f.audits.some((a) => a.phase === "quota-recovered"));
  // 报告回到 0%：同账号同档重新武装并再次推送。
  f.set([report()]);
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.filter((p) => p.event === "quota_zero").length, 2);
  f.alerts.stop();
});

test("会话限额报错但报告未到 0% 时按报错档推送并有过期", async () => {
  const f = fixture({
    "claude-accounts:acc1": [
      report({
        report: {
          status: "available",
          windows: [{ id: "five_hour", remainingPct: 12, resetsAt: "2026-11-05T13:00:00.000Z" }],
          balances: [],
        },
      }),
    ],
  });
  await f.alerts.start();
  f.alerts.stop();
  await f.alerts.onSessionQuotaError("主会话", "You've hit your usage limit");
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].event, "quota_error");
  assert.equal(f.posted[0].remainingPct, 12);
  assert.match(f.posted[0].error!.message, /usage limit/);
  await f.alerts.onSessionQuotaError("主会话", "You've hit your usage limit");
  assert.equal(f.posted.length, 1);
  f.tick(7 * 3600_000);
  await f.alerts.onSessionQuotaError("主会话", "You've hit your usage limit");
  assert.equal(f.posted.length, 2);
  f.alerts.stop();
});

test("凭据未就位不占用档位，就位后可推送", async () => {
  const f = fixture({ "claude-accounts:acc1": [report()] });
  await f.alerts.start();
  f.alerts.stop();
  f.cut();
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 0);
  assert.ok(f.audits.some((a) => a.phase === "quota-alert-waiting-credentials"));
  f.recover();
  await f.alerts.onSessionQuotaError("主会话", "usage limit");
  assert.equal(f.posted.length, 1);
  f.alerts.stop();
});

test("HTTP 回调携带鉴权、幂等键与约定字段", async () => {
  let received: Record<string, unknown> | undefined;
  let auth: string | undefined;
  let key: string | undefined;
  const server = createServer(async (req, res) => {
    auth = req.headers.authorization as string;
    key = req.headers["idempotency-key"] as string;
    let body = "";
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    await postQuotaAlert(
      {
        schemaVersion: 1,
        source: "paseo-event-notifications",
        kind: "quota_alert",
        event: "quota_zero",
        id: "uuid-1",
        correlationKey: "acc|window:five_hour",
        machine: "macmini",
        hostId: "macmini",
        account: { id: "acc", label: "a@example.com" },
        provider: "claude-accounts",
        remainingPct: 0,
        resetsAt: "2026-11-05T13:00:00.000Z",
        window: { id: "window:five_hour", label: "Session", kind: "window" },
        affectedMainAgentIds: ["主会话"],
        affectedMainAgents: [{ agentId: "主会话", workspaceId: null, title: null, provider: "claude-5" }],
        detectedAt: "2026-11-05T10:00:00.000Z",
      },
      { url: `http://127.0.0.1:${address.port}`, auth: "Authorization: Bearer quota-secret" },
    );
    assert.equal(auth, "Bearer quota-secret");
    assert.equal(key, "uuid-1");
    assert.equal(received!.kind, "quota_alert");
    for (const field of ["account", "remainingPct", "resetsAt", "affectedMainAgentIds", "affectedMainAgents"])
      assert.ok(Object.hasOwn(received!, field), field);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
