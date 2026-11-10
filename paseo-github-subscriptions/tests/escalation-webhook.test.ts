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
      "serverId",
      "needId",
      "workspaceTitle",
      "requestId",
      "answerVia",
      "prompts",
      "audience",
      "presence",
      "features",
    ])
      assert.ok(Object.hasOwn(received!, field), field);
    assert.equal(received!.schemaVersion, 1);
    assert.equal(received!.needsUser, true);
    assert.equal(received!.event, "asked");
    assert.equal(received!.machine, "macmini");
    assert.equal(received!.requestId, "问题");
    assert.equal(received!.answerVia, "paseo-permission");
    assert.equal((received!.questionSummary as { text: string }).text, "是否合并");
    assert.equal("extra" in received!, false);
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

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAskedExtra } from "../server/modules/answer-escalation/webhook.ts";
import { EscalationRecords } from "../server/modules/answer-escalation/records.ts";
import { EscalationRuntime } from "../server/modules/answer-escalation/runtime.ts";

test("asked 负载扩展字段：覆盖 AskUserQuestion、request_user_input、request_user_input_async 与云端会话，并正确标注 answerKey、audience 与 presence", () => {
  const baseNotice: Notice = {
    id: "n-1",
    key: "asked:agent-1:perm-1",
    event: "asked",
    firstSeenAt: "2026-11-10T10:00:00.000Z",
    hostId: "macmini",
    machine: "macmini",
    agentId: "agent-1",
    workspaceId: "ws-1",
    title: "1808【开发中】问答与通知",
    provider: "claude",
    permissionId: "perm-1",
    answeredBy: null,
    provenance: "not_applicable",
    questionSummary: { text: "", questions: [], options: [], recommended: [] },
    needsUser: false,
    wake: "immediate",
    coalesceWindowSeconds: 0,
    at: 1000,
    data: {
      id: "perm-1",
      kind: "question",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "先验证哪个模块？",
            header: "验证范围",
            multiSelect: false,
            options: [
              { label: "问答与通知（Recommended）", description: "工作包 A" },
              { label: "容量与迁移", description: "工作包 B" },
            ],
          },
        ],
      },
    },
  };

  // 1. AskUserQuestion -> answerVia = paseo-permission, answerKey = question
  const askExtra = buildAskedExtra(baseNotice, {
    serverId: "srv_demo_1",
    needId: "1808",
    workspaceTitle: "1808【开发中】开发自动化插件一期",
    presence: { mode: "offline", source: "bluetooth" },
  });
  const payload1 = webhookPayload({ ...baseNotice, extra: askExtra });
  assert.equal(payload1.schemaVersion, 1);
  assert.equal(payload1.serverId, "srv_demo_1");
  assert.equal(payload1.needId, "1808");
  assert.equal(payload1.workspaceTitle, "1808【开发中】开发自动化插件一期");
  assert.equal(payload1.requestId, "perm-1");
  assert.equal(payload1.answerVia, "paseo-permission");
  assert.deepEqual(payload1.presence, { mode: "offline", source: "bluetooth" });
  assert.deepEqual(payload1.features, ["prompts", "audience", "serverId"]);
  assert.deepEqual(payload1.audience, { ownerOnly: false, category: null, reason: null });
  const prompts1 = payload1.prompts as Array<Record<string, unknown>>;
  assert.equal(prompts1.length, 1);
  assert.equal(prompts1[0]!.answerKey, "先验证哪个模块？");
  assert.equal(prompts1[0]!.allowOther, true);
  assert.equal((prompts1[0]!.options as Array<{ recommended: boolean }>)[0]!.recommended, true);

  // 2. request_user_input_async (Codex) -> answerVia = paseo-permission, answerKey = header
  const codexNotice: Notice = {
    ...baseNotice,
    provider: "codex",
    data: {
      id: "perm-codex",
      kind: "question",
      name: "request_user_input_async",
      input: {
        questions: [
          {
            id: "0",
            header: "Question 1",
            question: "系统提示仍要运行，请在本机点确认后继续？",
            isOther: true,
            options: [{ label: "已点击", description: "" }],
          },
        ],
      },
    },
  };
  const codexExtra = buildAskedExtra(codexNotice, {
    serverId: "srv_demo_1",
    workspaceTitle: "【每日】屎山代码清理",
  });
  assert.equal(codexExtra.answerVia, "paseo-permission");
  assert.equal((codexExtra.prompts as Array<{ answerKey: string }>)[0]!.answerKey, "Question 1");
  // daily_task 优先级高于 local_confirm
  assert.deepEqual(codexExtra.audience, {
    ownerOnly: true,
    category: "daily_task",
    reason: "每日任务弹窗须 Yang 本人查看",
  });

  // 3. cloud-session -> answerVia = cloud-session, answerKey = question
  const cloudNotice: Notice = {
    ...baseNotice,
    provider: "cloud-session",
  };
  const cloudExtra = buildAskedExtra(cloudNotice, { serverId: "srv_demo_1" });
  assert.equal(cloudExtra.answerVia, "cloud-session");
  assert.equal((cloudExtra.prompts as Array<{ answerKey: string }>)[0]!.answerKey, "先验证哪个模块？");
});

test("EscalationRuntime：独立网页提问 enqueueExternal 与 closeExternal 生命周期，且 newObjects=false 时仍维护工作区标题", async () => {
  const dir = await mkdtemp(join(tmpdir(), "esc-ext-test-"));
  let workspacesListed = false;
  let serverRef: ReturnType<typeof createServer> | null = null;
  const receivedPayloads: Array<Record<string, unknown>> = [];

  serverRef = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    receivedPayloads.push(JSON.parse(body));
    res.end("ok");
  });
  serverRef.listen(0, "127.0.0.1");
  await once(serverRef, "listening");
  const port = (serverRef.address() as { port: number }).port;

  try {
    const fakeServer = {
      addHook: () => () => {},
    };

    const fakePaseo = {
      workspaces: {
        list: async () => {
          workspacesListed = true;
          return {
            entries: [
              {
                id: "ws-pinned",
                name: "1808【开发中】问答与通知工作区",
                workspaceDirectory: "/tmp/ws",
                projectRootPath: "/tmp/ws",
              },
            ],
            subscription: {
              subscribe: () => () => {},
              release: async () => {},
            },
          };
        },
      },
      agents: {
        list: async () => ({
          entries: [],
          subscription: {
            subscribe: ({ snapshot }: { snapshot: (arg: { entries: any[] }) => void }) => {
              snapshot({
                entries: [
                  {
                    agent: {
                      id: "agent-main-1",
                      title: "1808【开发中】主会话",
                      workspaceId: "ws-pinned",
                      provider: "claude",
                      status: "idle",
                      archivedAt: null,
                      labels: { need: "1808" },
                      pendingPermissions: [],
                    },
                  },
                ],
              });
              return () => {};
            },
            release: async () => {},
          },
        }),
        ref: () => ({
          refresh: async () => true,
          current: () => ({
            id: "agent-main-1",
            status: "idle",
            archivedAt: null,
            pendingPermissions: [],
          }),
          pendingPermissions: [],
        }),
      },
    };

    const fakeDaemon = {
      ready: async () => ({
        paseo: fakePaseo,
        client: {
          getLastServerInfoMessage: () => ({ serverId: "srv_test_mini" }),
        },
      }),
    };

    const fakeRoles = {
      read: async () => ({ pinned: new Set(["ws-pinned"]), archived: new Set<string>() }),
    };

    const runtimeSettings = {
      enabled: true,
      timezone: "Asia/Singapore",
      immediate: [{ days: "daily" as const, from: "00:00", to: "23:59" }],
      delayMinutes: 0,
    };

    const runtime = new EscalationRuntime({
      directory: dir,
      machineName: "macmini",
      section: {
        timezone: "Asia/Singapore",
        immediate: [{ days: "daily", from: "00:00", to: "23:59" }],
        delayMinutes: 0,
        newObjects: false,
        quotaAlerts: { enabled: false },
      },
      settings: {
        read: () => runtimeSettings,
        write: async () => {},
        error: () => undefined,
      } as never,
      server: fakeServer as never,
      daemon: fakeDaemon as never,
      roles: fakeRoles as never,
      credentials: async () => ({
        url: `http://127.0.0.1:${port}`,
        auth: "X-Test-Auth: ok",
      }),
      presence: () => ({ mode: "offline", source: "manual" }),
      localKeywords: () => ["本机特别确认词"],
      log: () => {},
    });

    await runtime.start();
    try {
      // 1. 验证 newObjects=false 时工作区表仍通过 watchWorkspaces 建立
      assert.equal(workspacesListed, true, "newObjects=false 时也应订阅工作区列表以维护 workspaceTitle");

      // 2. 独立网页提问通过 enqueueExternal 进入升级通道并投递到 Webhook
      runtime.enqueueExternal({
        id: "browser:q-ext-1",
        sessionId: "sess_ext_1",
        instanceId: "env-27",
        fingerprint: "fp-ext-1",
        source: "browser",
        title: "网页独立开发会话",
        url: "https://claude.ai/code/session_sess_ext_1",
        at: new Date().toISOString(),
        state: "pending",
        reason: "等待回答",
        prompts: [
          {
            question: "出现本机特别确认词时如何处理？",
            header: "确认方式",
            multiSelect: false,
            allowOther: true,
            options: [{ label: "本人确认（Recommended）", description: "", recommended: true }],
          },
        ],
      });

      for (let i = 0; i < 60 && receivedPayloads.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(receivedPayloads.length, 1, "独立网页提问应投递到 Webhook");
      const extPayload = receivedPayloads[0]!;
      assert.equal(extPayload.event, "asked");
      assert.equal(extPayload.agentId, null);
      assert.equal(extPayload.paseo_agent_id, null);
      assert.equal(extPayload.answerVia, "browser-only");
      assert.equal(extPayload.serverId, "srv_test_mini");
      assert.equal(extPayload.instanceId, "env-27");
      assert.equal(extPayload.sessionId, "sess_ext_1");
      assert.equal(extPayload.url, "https://claude.ai/code/session_sess_ext_1");
      assert.equal(extPayload.requestId, "browser:q-ext-1");
      assert.deepEqual(extPayload.presence, { mode: "offline", source: "manual" });
      assert.deepEqual(extPayload.audience, {
        ownerOnly: true,
        category: "local_confirm",
        reason: "问题涉及本机确认或本人现场操作，请用户本人确认",
      });

      // 待办升级记录已生成，且在问题结束时由 closeExternal 自动结束
      const snapBefore = await runtime.snapshot();
      assert.equal(snapBefore.pendingEvents.length, 1);
      assert.equal(snapBefore.pendingEvents[0]!.agentId, "");
      assert.equal(extPayload.correlationKey, "browser:browser:q-ext-1:fp-ext-1");
      runtime.closeExternal("browser:q-ext-1");
      await new Promise((r) => setTimeout(r, 30));
      const snapAfter = await runtime.snapshot();
      assert.equal(snapAfter.pendingEvents.length, 0, "closeExternal 应结束对应的升级待办记录");
      assert.equal(snapAfter.recentClosures?.[0]?.reason, "提问已回答或已取消");

      // 已结束的外部提问重复调用 closeExternal 时不再重复写 state.json
      const stateStat1 = await stat(join(dir, "state.json"));
      await new Promise((r) => setTimeout(r, 30));
      runtime.closeExternal("browser:q-ext-1");
      runtime.closeExternal("browser:never-opened");
      await new Promise((r) => setTimeout(r, 30));
      const stateStat2 = await stat(join(dir, "state.json"));
      assert.equal(stateStat2.mtimeMs, stateStat1.mtimeMs, "重复调用 closeExternal 不应重写 state.json");

      // 3. 验证网页提问同样遵循时段规则：非立即时段且 delayMinutes > 0 时先入 pending 等待，不立即发送
      runtimeSettings.immediate = [];
      runtimeSettings.delayMinutes = 30;
      runtime.enqueueExternal({
        id: "browser:q-ext-2",
        sessionId: "sess_ext_2",
        instanceId: "env-27",
        fingerprint: "fp-ext-2",
        source: "browser",
        title: "网页延迟时段会话",
        url: "https://claude.ai/code/session_sess_ext_2",
        at: new Date().toISOString(),
        state: "pending",
        reason: "等待回答",
        prompts: [
          {
            question: "非立即时段的网页提问是否先等待？",
            header: "时段",
            multiSelect: false,
            allowOther: true,
            options: [{ label: "是", description: "", recommended: true }],
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(receivedPayloads.length, 1, "时段外且未满 delayMinutes 时网页提问不应立即发送");

      // 切入立即时段后，等待中的网页提问在下一次 tick 立即升级发出
      runtimeSettings.immediate = [{ days: "daily", from: "00:00", to: "23:59" }];
      runtimeSettings.delayMinutes = 0;
      for (let i = 0; i < 60 && receivedPayloads.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(receivedPayloads.length, 2, "进入立即时段后待答网页提问应升级发送");
      assert.equal(receivedPayloads[1]!.requestId, "browser:q-ext-2");
    } finally {
      await runtime.stop();
    }
  } finally {
    serverRef.closeAllConnections();
    await new Promise<void>((resolve) => serverRef!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("EscalationRecords：外部网页提问（agentId 为空）不被 agentsWithOpen 纳入 Paseo 会话清扫，且可通过 closeRequest('', id) 精确关闭", async () => {
  const dir = await mkdtemp(join(tmpdir(), "esc-records-ext-"));
  try {
    const records = new EscalationRecords(join(dir, "records.json"));
    records.upsert({
      id: "notice-ext-1",
      event: "asked",
      agentId: "",
      sessionTitle: "独立网页会话",
      workspaceId: null,
      questionText: "网页提问正文",
      summary: "网页提问正文",
      at: new Date().toISOString(),
      delivery: "live",
      status: "delivered",
      acknowledged: false,
      requests: [{ agentId: "", requestId: "browser:q-1" }],
    });
    assert.deepEqual(records.agentsWithOpen(), [], "agentId 为空的外部网页提问不应进入 Paseo 会话轮询列表");
    assert.equal(records.pending().length, 1);
    const closed = records.closeRequest("", "browser:q-1", "resolved");
    assert.equal(closed.length, 1);
    assert.equal(records.pending().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
