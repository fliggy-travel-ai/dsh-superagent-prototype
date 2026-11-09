import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { QuestionPromptSchema } from './presence.ts';

export const TodoTypeSchema = z.enum(['ask', 'web', 'stall', 'esc', 'read']);
export type TodoType = z.infer<typeof TodoTypeSchema>;

export const TodoLabelSchema = z.enum(['网页提问', '网页等待', '停滞会话', '升级事件', '代答未读']);
export type TodoLabel = z.infer<typeof TodoLabelSchema>;

export const TodoItemSchema = z.strictObject({
  id: z.string().min(1),
  type: TodoTypeSchema,
  label: TodoLabelSchema,
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  sourceLabel: z.string().min(1),
  sessionTitle: z.string().min(1),
  at: z.string(),
  ageText: z.string(),
  text: z.string(),
  url: z.string().optional(),
  agentId: z.string().optional(),
  question: z.strictObject({
    questionId: z.string().min(1),
    fingerprint: z.string().min(1),
    prompts: z.array(QuestionPromptSchema),
  }).optional(),
  readReceipt: z.strictObject({
    questionId: z.string().min(1),
    fingerprint: z.string().min(1),
  }).optional(),
  escalationId: z.string().optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoLogKindSchema = z.enum(['web-approval', 'auto-answer', 'escalation', 'quiet-merge']);
export type TodoLogKind = z.infer<typeof TodoLogKindSchema>;

export const TodoLogLabelSchema = z.enum(['网页权限点击', '离线代答', '升级投递', '子会话归并']);
export type TodoLogLabel = z.infer<typeof TodoLogLabelSchema>;

export const TodoLogItemSchema = z.strictObject({
  id: z.string().min(1),
  at: z.string(),
  kind: TodoLogKindSchema,
  label: TodoLogLabelSchema,
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  detail: z.string(),
});
export type TodoLogItem = z.infer<typeof TodoLogItemSchema>;

export const TodoLocalSnapshotSchema = z.strictObject({
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  items: z.array(TodoItemSchema),
  logs: z.array(TodoLogItemSchema),
  accountsNeedingAttention: z.number().int().nonnegative().default(0),
});
export type TodoLocalSnapshot = z.infer<typeof TodoLocalSnapshotSchema>;

export const TodoHostStatusSchema = z.strictObject({
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  online: z.boolean(),
  responded: z.boolean(),
  error: z.string().nullable(),
  accountsNeedingAttention: z.number().int().nonnegative().default(0),
});
export type TodoHostStatus = z.infer<typeof TodoHostStatusSchema>;

export const TodoMergedSnapshotSchema = z.strictObject({
  items: z.array(TodoItemSchema),
  logs: z.array(TodoLogItemSchema),
  hosts: z.array(TodoHostStatusSchema),
  warning: z.string().nullable(),
});
export type TodoMergedSnapshot = z.infer<typeof TodoMergedSnapshotSchema>;

export const TodoActionInputSchema = z.strictObject({
  hostId: z.string().min(1),
  action: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('answer'),
      questionId: z.string().min(1),
      answers: z.record(z.string(), z.array(z.string()).max(30)),
      otherAnswers: z.record(z.string(), z.string().max(2000)).optional(),
    }),
    z.strictObject({
      type: z.literal('read'),
      questionId: z.string().min(1),
      fingerprint: z.string().min(1),
    }),
    z.strictObject({
      type: z.literal('ack-escalation'),
      escalationId: z.string().min(1),
      agentId: z.string().optional(),
    }),
  ]),
});
export type TodoActionInput = z.infer<typeof TodoActionInputSchema>;

export const TodoActionOutputSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string(),
});
export type TodoActionOutput = z.infer<typeof TodoActionOutputSchema>;

export const todoLocal = defineRpc({
  name: 'todo.local',
  input: z.object({}),
  output: TodoLocalSnapshotSchema,
});

export const todoList = defineRpc({
  name: 'todo.list',
  input: z.object({}),
  output: TodoMergedSnapshotSchema,
});

export const todoAct = defineRpc({
  name: 'todo.act',
  input: TodoActionInputSchema,
  output: TodoActionOutputSchema,
});
