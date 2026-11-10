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
  /** 自动模式下每台主机的识别结果（mode=online 表示该主机识别到锚定设备）。 */
  hosts: z.array(z.strictObject({ name: z.string().max(200), mode: z.enum(['online', 'offline', 'unknown']), reason: z.string().max(300) })).max(20).optional(),
});
export const QuestionPromptSchema = z.strictObject({
  question: z.string().min(1).max(4000), header: z.string().max(200).optional(),
  multiSelect: z.boolean().default(false),
  allowOther: z.boolean().optional(),
  options: z.array(z.strictObject({ label: z.string().min(1).max(1000), description: z.string().max(4000).default(''), recommended: z.boolean() })).max(30),
});
export const BrowserQuestionSchema = z.strictObject({
  id: z.string().min(1).max(200), sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  fingerprint: z.string().min(1).max(128), prompts: z.array(QuestionPromptSchema).min(1).max(10),
  toolUseId: z.string().min(1).max(200).optional(),
  pages: z.number().int().min(1).max(10).optional(),
});
export const QuestionAnswerSchema = z.strictObject({
  id: z.string(),
  answers: z.record(z.string(), z.array(z.string()).max(30)),
  otherAnswers: z.record(z.string(), z.string().max(2000)).optional(),
});
export const QuestionSchema = BrowserQuestionSchema.extend({
  source: z.enum(['native', 'browser']), title: z.string(), instanceId: z.string().optional(),
  url: z.string().optional(), at: z.string(),
  state: z.enum(['pending', 'submitted', 'resolved', 'unknown']), reason: z.string(),
  answer: z.strictObject({
    source: z.enum(['user', 'automatic']),
    answers: QuestionAnswerSchema.shape.answers,
    otherAnswers: QuestionAnswerSchema.shape.otherAnswers,
    readAt: z.string().optional(),
  }).optional(),
  delegatedTo: z.string().optional(),
  browserSubmittedAt: z.string().optional(),
  // 云端提问对应的网页会话（session_<后缀>）；网页作答未确认时据此找回提问。
  webSessionId: z.string().max(200).optional(),
  // 网页作答未确认、等待用户去 claude.ai 重试；扫描不自动结束，云端确认后清除。
  webRetry: z.boolean().optional(),
  // 云端已记录工具结果；之后到的网页结果不再重新打开提问。
  cloudConfirmed: z.boolean().optional(),
});
export const BrowserDecisionSchema = z.strictObject({
  id: z.string(), sessionId: z.string(), fingerprint: z.string(),
  answers: QuestionAnswerSchema.shape.answers,
  otherAnswers: QuestionAnswerSchema.shape.otherAnswers,
  source: z.enum(['automatic', 'manual']).optional(),
  expiresAt: z.number(),
});
export const LocalSpeechInputSchema = z.strictObject({ enabled: z.boolean() });
export const LocalSpeechStateSchema = z.strictObject({ enabled: z.boolean(), configured: z.boolean().optional() });
export const PresenceSnapshotSchema = z.strictObject({
  settings: PresenceSettingsSchema, observation: PresenceObservationSchema,
  questions: z.array(QuestionSchema), hostName: z.string(),
  hosts: z.array(z.strictObject({ id: z.string(), name: z.string(), online: z.boolean() })),
  error: z.string().nullable(),
  speech: z.array(SpeechEventSchema).optional(),
  localSpeechEnabled: z.boolean().optional(),
  hasSpeechTarget: z.boolean().optional(),
});
export type LocalSpeechState = z.infer<typeof LocalSpeechStateSchema>;
export type PresenceSettings = z.infer<typeof PresenceSettingsSchema>;
export type PresenceObservation = z.infer<typeof PresenceObservationSchema>;
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>;
export type BrowserQuestion = z.infer<typeof BrowserQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type BrowserDecision = z.infer<typeof BrowserDecisionSchema>;
export type PresenceSnapshot = z.infer<typeof PresenceSnapshotSchema>;
export const isQuestionTodo = (question: Question) => !question.delegatedTo && question.state !== 'resolved';
export const presenceSnapshot = defineRpc({ name: 'presence.snapshot', input: z.object({}), output: PresenceSnapshotSchema });
export const presenceConfigure = defineRpc({ name: 'presence.configure', input: PresenceSettingsSchema, output: PresenceSnapshotSchema });
export const presenceAnswer = defineRpc({ name: 'presence.answer', input: QuestionAnswerSchema, output: PresenceSnapshotSchema });
export const presenceLocal = defineRpc({ name: 'presence.local', input: z.object({}), output: PresenceObservationSchema });
export const presenceLocalSpeech = defineRpc({ name: 'presence.local-speech', input: z.object({}), output: LocalSpeechStateSchema });
export const presenceConfigureLocalSpeech = defineRpc({ name: 'presence.configure-local-speech', input: LocalSpeechInputSchema, output: PresenceSnapshotSchema });
export const presenceSpeak = defineRpc({ name: 'presence.speak', input: z.strictObject({ id: z.string().max(200), text: z.string().max(500) }), output: SpeechResultSchema });
export const presenceSpeakCancel = defineRpc({ name: 'presence.speak-cancel', input: z.strictObject({ id: z.string().min(1).max(200) }), output: z.strictObject({ cancelled: z.boolean() }) });
