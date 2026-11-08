import test from "node:test";
import assert from "node:assert/strict";
import { commandEvent } from "../server/notify/commands.ts";
const shell = {
  type: "tool_call" as const,
  callId: "命令",
  name: "shell",
  detail: { type: "shell" as const, command: "cat report.md", exitCode: 0 },
  status: "completed" as const,
  error: null,
};
test("前台读文件成功不报后台完成，明确后台任务成功才通知", () => {
  assert.equal(commandEvent(shell), null);
  assert.equal(
    commandEvent({ ...shell, metadata: { background: true } }),
    "bg_cmd_done",
  );
  assert.equal(
    commandEvent({ ...shell, metadata: { run_in_background: true } }),
    "bg_cmd_done",
  );
});
test("gh pr checks exitCode 8 表示 pending，不算错误事件", () => {
  assert.equal(
    commandEvent({
      ...shell,
      detail: { ...shell.detail, command: "gh pr checks 491", exitCode: 8 },
    }),
    null,
  );
  assert.equal(
    commandEvent({
      ...shell,
      detail: {
        ...shell.detail,
        command: "gh pr checks 491 --watch --fail-fast",
        exitCode: 8,
      },
    }),
    null,
  );
  assert.equal(
    commandEvent({
      ...shell,
      detail: { ...shell.detail, command: "gh pr checks 491", exitCode: 1 },
    }),
    "error",
  );
  assert.equal(
    commandEvent({
      ...shell,
      detail: { ...shell.detail, command: "make test", exitCode: 8 },
    }),
    "error",
  );
  assert.equal(
    commandEvent({
      ...shell,
      status: "failed",
      error: "gh pr checks 网络错误",
      detail: { ...shell.detail, command: "gh pr checks", exitCode: 0 },
    }),
    "error",
  );
});

test("前台和后台命令失败均报告错误，不伪称后台完成", () => {
  assert.equal(
    commandEvent({ ...shell, detail: { ...shell.detail, exitCode: 1 } }),
    "error",
  );
  assert.equal(
    commandEvent({ ...shell, status: "failed", error: "失败" }),
    "error",
  );
});

import { shellCommandNotice } from "../server/notify/commands.ts";
test("时间线订阅：只有带退出码的终态或失败的 shell 调用产生事件，键含会话和调用编号", () => {
  const failed = { ...shell, status: "failed" as const, detail: { type: "shell" as const, command: "make", exitCode: 2 } };
  const notice = shellCommandNotice("child", failed)!;
  assert.equal(notice.event, "error");
  assert.equal(notice.key, "command:child:命令");
  assert.equal(notice.data.callId, "命令");
  assert.equal(shellCommandNotice("child", { ...failed, status: "running" as never }), null);
  assert.equal(shellCommandNotice("child", { ...failed, status: "completed" as const, detail: { type: "shell" as const, command: "make" } as never }), null);
  assert.equal(shellCommandNotice("child", shell), null);
  assert.equal(shellCommandNotice("child", { ...shell, metadata: { background: true } })!.event, "bg_cmd_done");
  assert.equal(shellCommandNotice("child", { type: "assistant_message", text: "x" } as never), null);
});
