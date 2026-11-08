import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * 云端会话在 Provider 实例中运行时，与主实例之间的调用契约。
 *
 * - 云端程序写死调用主实例 `github-subscriptions`。主实例把云端会话的 RPC 原样转给 Provider 实例。
 * - Provider 实例回答网页提问、确认网页请求时，调用主实例的浏览器桥接（本文件的两个 RPC）。
 */
const ContextSchema = z.object({
  webSessionId: z.string().min(1),
  toolUseId: z.string().min(1),
  expected: z.object({ toolName: z.string(), input: z.record(z.string(), z.unknown()) }),
});
export const WebRequestAnswerSchema = z.union([
  ContextSchema.extend({ kind: z.literal('question'), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])), otherAnswers: z.record(z.string(), z.string()).optional() }),
  ContextSchema.extend({ kind: z.literal('tool'), decision: z.enum(['allow', 'deny']) }),
]);
export const WebRequestResultSchema = z.union([
  z.object({ status: z.literal('submitted') }),
  z.object({ status: z.literal('page_not_open') }),
  z.object({ status: z.literal('unknown'), detail: z.string() }),
]);

export const cloudBridgeAnswer = defineRpc({ name: 'cloud-bridge.answer-web-request', input: WebRequestAnswerSchema, output: WebRequestResultSchema });
export const cloudBridgeConfirm = defineRpc({
  name: 'cloud-bridge.confirm-web-request',
  input: z.object({ webSessionId: z.string().min(1), toolUseId: z.string().min(1), outcome: z.enum(['answered', 'denied', 'canceled']) }),
  output: z.object({ ok: z.literal(true) }),
});
