import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
export function commandEvent(
  item: AgentTimelineItem,
): "bg_cmd_done" | "error" | null {
  if (item.type !== "tool_call" || item.detail.type !== "shell") return null;
  if (
    item.status === "failed" ||
    (item.status === "completed" &&
      typeof item.detail.exitCode === "number" &&
      item.detail.exitCode !== 0)
  ) {
    // gh pr checks 以 exitCode 8 表示仍有 pending 检查，不算命令失败，不产生错误事件。
    const command =
      typeof item.detail.command === "string" ? item.detail.command : "";
    if (
      item.status === "completed" &&
      item.detail.exitCode === 8 &&
      /\bgh\s+pr\s+checks?\b/.test(command)
    )
      return null;
    return "error";
  }
  if (item.status !== "completed" || typeof item.detail.exitCode !== "number")
    return null;
  const metadata = item.metadata || {};
  const background =
    metadata.background === true ||
    metadata.run_in_background === true ||
    typeof metadata.backgroundTaskId === "string";
  return background ? "bg_cmd_done" : null;
}
