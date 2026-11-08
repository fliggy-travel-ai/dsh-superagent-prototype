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
