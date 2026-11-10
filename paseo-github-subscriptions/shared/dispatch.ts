import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const dispatchFinalize = defineRpc({ name: 'dispatch.finalize', input: z.object({ agentId: z.string().min(1) }), output: z.object({ ok: z.boolean(), reason: z.string().nullable() }) });
