import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
export const capacitySnapshot = defineRpc({ name: 'capacity.snapshot', input: z.object({}), output: z.object({ generatedAt: z.string(), totalCanAdd: z.number(), recommendedProvider: z.string().nullable(), accounts: z.array(z.unknown()), excluded: z.array(z.object({ provider: z.string(), reason: z.string() })) }) });

export const capacityClearReview = defineRpc({ name: 'capacity.clear-review', input: z.object({ agentId: z.string().min(1) }), output: z.object({ ok: z.boolean(), autoResume: z.boolean().nullable() }) });
