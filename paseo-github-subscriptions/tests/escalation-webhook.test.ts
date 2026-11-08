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
