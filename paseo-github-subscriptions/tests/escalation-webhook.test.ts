import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Engine, emptyState, type Notice } from "../server/notify/engine.ts";
import { postNotice, webhookPayload } from "../server/modules/answer-escalation/webhook.ts";
test("单事件 HTTP 使用现有鉴权头、稳定标识并包含完整字段", async () => {
  let received: Record<string, unknown> | undefined;
  let auth: string | undefined;
  let key: string | undefined;
  const server = createServer(async (req, res) => {
    auth = req.headers["x-test-auth"] as string;
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
    const notices: Notice[] = [];
    const e = new Engine(
      {
        hostId: "macmini",
        machine: "macmini",
        delivery: "live",
        mains: ["主会话"],
        children: {},
      },
      emptyState(),
      async () => {},
      async (n) => {
        notices.push(n);
      },
      async () => true,
    );
    e.metadata({
      id: "主会话",
      workspaceId: "工作区",
      title: "1566【开发中】通知",
      provider: "codex",
    });
    await e.asked(
      "主会话",
      "问题",
      {
        kind: "question",
        name: "AskUserQuestion",
        title: "合并到 master？",
        input: {
          questions: [{ question: "是否合并", options: ["合并", "等待"] }],
        },
      },
      Date.parse("2026-11-04T12:00:00+08:00"),
    );
    await e.tick(Date.parse("2026-11-04T12:00:00+08:00"));
    await postNotice(
      notices[0],
      {
        url: `http://127.0.0.1:${address.port}`,
        auth: "X-Test-Auth: 测试".replace("测试", "test-secret"),
      },
      new AbortController().signal,
    );
    assert.equal(auth, "test-secret");
    assert.equal(key, notices[0].id);
    for (const field of [
      "event",
      "machine",
      "agentId",
      "workspaceId",
      "title",
      "provider",
      "permissionId",
      "questionSummary",
      "firstSeenAt",
      "answeredBy",
    ])
      assert.ok(Object.hasOwn(received!, field), field);
    assert.equal(received!.needsUser, true);
    assert.equal(received!.event, "asked");
    assert.equal(received!.machine, "macmini");
    assert.match(received!.firstSeenAt as string, /Z$/);
    assert.equal(Array.isArray(received), false);
    assert.equal(webhookPayload(notices[0]).correlationKey, notices[0].key);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { storeWebhookCredentials } from "../server/modules/answer-escalation/webhook.ts";
const SECRET_URL = "https://example.test/hook/test-secret-path";
const SECRET_AUTH = "X-Key: test-secret-value";
const cfg = { urlService: "svc-url", authService: "svc-auth", account: "acct" };

test("保存 webhook：凭据只经标准输入交给 security -i，不出现在命令行参数里", async () => {
  const calls: Array<{ args: string[]; input: string }> = [];
  await storeWebhookCredentials(cfg, { url: SECRET_URL, auth: SECRET_AUTH }, async (args, input) => { calls.push({ args, input }); });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ["-i"]);
  assert.ok(!JSON.stringify(calls[0]!.args).includes("test-secret"));
  const lines = calls[0]!.input.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^add-generic-password -U -s "svc-url" -a "acct" -w "https:\/\/example\.test\/hook\/test-secret-path"$/);
  assert.match(lines[1]!, /-s "svc-auth" .* -w "X-Key: test-secret-value"$/);
});

test("保存 webhook：引号、反斜杠被转义；换行和空字符被拒绝", async () => {
  const calls: string[] = [];
  await storeWebhookCredentials(cfg, { url: SECRET_URL, auth: 'X-Key: a"b\\c' }, async (_args, input) => { calls.push(input); });
  assert.match(calls[0]!, /-w "X-Key: a\\"b\\\\c"/);
  await assert.rejects(storeWebhookCredentials(cfg, { url: SECRET_URL, auth: "X-Key: a\nadd-generic-password -s x" }, async () => {}), /鉴权头/);
});

test("保存 webhook 失败时只抛通用提示，不带地址、鉴权头或底层错误原文", async () => {
  for (const credentials of [{ url: SECRET_URL, auth: SECRET_AUTH }, { url: "not a url test-secret", auth: SECRET_AUTH }, { url: "http://example.test/test-secret", auth: SECRET_AUTH }, { url: SECRET_URL, auth: "没有冒号 test-secret" }]) {
    await assert.rejects(storeWebhookCredentials(cfg, credentials, async () => { throw new Error(`Command failed: security -w ${credentials.url} ${credentials.auth}`); }), (error: Error) => {
      assert.ok(!error.message.includes("test-secret"), error.message);
      assert.ok(!error.message.includes("example.test"), error.message);
      return true;
    });
  }
  await assert.rejects(storeWebhookCredentials(undefined, { url: SECRET_URL, auth: SECRET_AUTH }, async () => {}), /Keychain/);
});
