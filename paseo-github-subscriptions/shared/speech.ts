import { z } from 'zod';

export const SpeechResultSchema = z.object({
  played: z.boolean(),
  cancelled: z.boolean().optional(),
  engine: z.enum(['neural', 'system']).optional(),
  detail: z.string().max(500).optional(),
  retryAt: z.number().optional(),
});
export const SpeechEventSchema = SpeechResultSchema.extend({ id: z.string(), at: z.string(), hostId: z.string().nullable() });
export type SpeechResult = z.infer<typeof SpeechResultSchema>;
export type SpeechEvent = z.infer<typeof SpeechEventSchema>;
export const SPEECH_COOLDOWN_MS = 180_000;
