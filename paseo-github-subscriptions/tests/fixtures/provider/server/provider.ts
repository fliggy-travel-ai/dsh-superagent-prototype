import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
  type ProviderEvent,
  type ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
export function fixtureProvider(): ProviderRegistration {
  return {
    id: "notification-fixture",
    label: "通知验证事件源",
    async status() {
      return { available: true };
    },
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, [
        "prompt.message",
        "prompt.steer",
        "permission",
        "session.persistence",
      ]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, { turnId: string; kind: string }>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      const finish = (sessionId: string) => {
        const s = sessions.get(sessionId)!;
        emit({
          type: "timeline.item",
          sessionId,
          item: {
            id: randomUUID(),
            type: "assistant_message",
            text: "验证事件已处理",
          },
        });
        emit({
          type: "session.turn",
          sessionId,
          turnId: s.turnId,
          state: "completed",
        });
      };
      return {
        version: 1,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          listeners.clear();
          sessions.clear();
        },
        async send(input) {
          if (input.type === "catalog") {
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: [
                  { id: "deterministic", label: "固定事件，无模型费用" },
                ],
                modes: [],
                defaultModel: "deterministic",
              },
            });
            return;
          }
          if (input.type === "session.open") {
            sessions.set(input.sessionId, { turnId: "", kind: "" });
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities,
              restoration: "core",
              persistence: input.persistence ?? {
                version: 1,
                data: { sessionId: input.sessionId },
              },
              cwd: input.config.cwd,
            });
            emit({
              type: "session.config",
              sessionId: input.sessionId,
              config: {
                models: [{ id: "deterministic", label: "固定事件" }],
                modes: [],
                thinkingOptions: [],
                settings: [],
                model: "deterministic",
              },
            });
            emit({
              type: "session.ready",
              requestId: input.requestId,
              sessionId: input.sessionId,
            });
            return;
          }
          if (input.type === "session.prompt") {
            const { sessionId, prompt } = input;
            const turnId = randomUUID();
            const text =
              prompt.input.type === "message"
                ? prompt.input.content
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("")
                : prompt.input.name;
            sessions.set(sessionId, { turnId, kind: text });
            emit({
              type: "timeline.item",
              sessionId,
              item: {
                id: randomUUID(),
                type: "user_message",
                text,
                clientMessageId: prompt.clientMessageId,
              },
            });
            emit({
              type: "session.prompt_result",
              sessionId,
              clientMessageId: prompt.clientMessageId,
              result: { type: "turn", turnId },
            });
            emit({ type: "session.turn", sessionId, turnId, state: "started" });
            if (text === "ask") {
              emit({
                type: "session.permission",
                sessionId,
                request: {
                  id: "fixture-permission",
                  kind: "question",
                  name: "AskUserQuestion",
                  title: "是否合并到 master？",
                  input: {
                    questions: [
                      {
                        question: "是否合并？",
                        options: [{ label: "合并" }, { label: "等待" }],
                      },
                    ],
                  },
                },
              });
              return;
            }
            if (text === "fail") {
              emit({
                type: "session.turn",
                sessionId,
                turnId,
                state: "failed",
                error: { message: "验证用失败，不涉及真实CI" },
              });
              return;
            }
            if (text === "command" || text === "command-fail") {
              emit({
                type: "timeline.item",
                sessionId,
                item: {
                  id: randomUUID(),
                  type: "tool_call",
                  callId: randomUUID(),
                  name: "shell",
                  metadata:{background:true},
                  detail: {
                    type: "shell",
                    command: "验证专用命令",
                    exitCode: text === "command-fail" ? 1 : 0,
                    output: "固定测试输出",
                  },
                  status: "completed",
                  error: null,
                },
              });
            }
            finish(sessionId);
            return;
          }
          if (input.type === "session.permission") {
            emit({
              type: "session.permission_resolved",
              sessionId: input.sessionId,
              permissionId: input.permissionId,
            });
            finish(input.sessionId);
            return;
          }
          if (input.type === "session.interrupt") {
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if ("requestId" in input)
            emit({ type: "request.completed", requestId: input.requestId });
        },
      };
    },
  };
}
