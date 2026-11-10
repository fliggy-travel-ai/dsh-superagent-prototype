import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
export const capacitySnapshot = defineRpc({ name: 'capacity.snapshot', input: z.object({}), output: z.object({ generatedAt: z.string(), totalCanAdd: z.number(), recommendedProvider: z.string().nullable(), accounts: z.array(z.unknown()), excluded: z.array(z.object({ provider: z.string(), reason: z.string() })) }) });
