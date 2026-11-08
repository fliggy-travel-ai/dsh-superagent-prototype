import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { SpeechEventSchema, SpeechResultSchema } from './speech.ts';

export const PresenceSettingsSchema = z.strictObject({
  mode: z.enum(['auto', 'online', 'offline']).default('auto'),
  paused: z.boolean().default(false),
  speechEnabled: z.boolean().default(true),
  sourceHostId: z.string().max(200).nullable().default(null),
});
export const PresenceObservationSchema = z.strictObject({
  mode: z.enum(['online', 'offline', 'unknown']),
  observedAt: z.string().nullable(), reason: z.string(),
  source: z.enum(['bluetooth', 'manual', 'unavailable']),
});
export const QuestionPromptSchema = z.strictObject({
  question: z.string().min(1).max(4000), header: z.string().max(200).optional(),
  multiSelect: z.boolean().default(false),
  options: z.array(z.strictObject({ label: z.string().min(1).max(1000), description: z.string().max(4000).default(''), recommended: z.boolean() })).max(30),
});
export const BrowserQuestionSchema = z.strictObject({
  id: z.string().min(1).max(200), sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  fingerprint: z.string().min(1).max(128), prompts: z.array(QuestionPromptSchema).min(1).max(10),
});
export const QuestionAnswerSchema = z.strictObject({ id: z.string(), answers: z.record(z.string(), z.array(z.string()).min(1).max(30)) });
export const QuestionReadSchema = z.strictObject({ id: z.string(), fingerprint: z.string() });
export const QuestionSchema = BrowserQuestionSchema.extend({
  source: z.enum(['native', 'browser']), title: z.string(), instanceId: z.string().optional(),
  url: z.string().optional(), at: z.string(),
  state: z.enum(['pending', 'submitted', 'resolved', 'unknown']), reason: z.string(),
  answer: z.strictObject({ source: z.enum(['user', 'automatic']), answers: QuestionAnswerSchema.shape.answers, readAt: z.string().optional() }).optional(),
  browserSubmittedAt: z.string().optional(),
});
export const BrowserDecisionSchema = z.strictObject({
  id: z.string(), sessionId: z.string(), fingerprint: z.string(),
  answers: QuestionAnswerSchema.shape.answers, expiresAt: z.number(),
});
export const PresenceSnapshotSchema = z.strictObject({
  settings: PresenceSettingsSchema, observation: PresenceObservationSchema,
  questions: z.array(QuestionSchema), hostName: z.string(),
  hosts: z.array(z.strictObject({ id: z.string(), name: z.string(), online: z.boolean() })),
  error: z.string().nullable(),
  speech: z.array(SpeechEventSchema).optional(),
});
export type PresenceSettings = z.infer<typeof PresenceSettingsSchema>;
export type PresenceObservation = z.infer<typeof PresenceObservationSchema>;
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>;
export type BrowserQuestion = z.infer<typeof BrowserQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type QuestionRead = z.infer<typeof QuestionReadSchema>;
export type BrowserDecision = z.infer<typeof BrowserDecisionSchema>;
export type PresenceSnapshot = z.infer<typeof PresenceSnapshotSchema>;
export const isUnreadAutomaticAnswer = (question: Question) => question.state === 'resolved' && question.answer?.source === 'automatic' && !question.answer.readAt;
export const isQuestionTodo = (question: Question) => question.state !== 'resolved' || isUnreadAutomaticAnswer(question);
export const presenceSnapshot = defineRpc({ name: 'presence.snapshot', input: z.object({}), output: PresenceSnapshotSchema });
export const presenceConfigure = defineRpc({ name: 'presence.configure', input: PresenceSettingsSchema, output: PresenceSnapshotSchema });
export const presenceAnswer = defineRpc({ name: 'presence.answer', input: QuestionAnswerSchema, output: PresenceSnapshotSchema });
export const presenceRead = defineRpc({ name: 'presence.read', input: QuestionReadSchema, output: PresenceSnapshotSchema });
export const presenceLocal = defineRpc({ name: 'presence.local', input: z.object({}), output: PresenceObservationSchema });
export const presenceSpeak = defineRpc({ name: 'presence.speak', input: z.strictObject({ id: z.string().max(200), text: z.string().max(500) }), output: SpeechResultSchema });
export const presenceSpeakCancel = defineRpc({ name: 'presence.speak-cancel', input: z.strictObject({ id: z.string().min(1).max(200) }), output: z.strictObject({ cancelled: z.boolean() }) });
