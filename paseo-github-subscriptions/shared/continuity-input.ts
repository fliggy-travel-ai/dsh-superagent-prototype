import { z } from "zod";
import { inputSchema } from "./claude-usage-input.ts";

const accountKey = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const localInput = inputSchema.extend({ accountKey });
const crossUserInput = z.object({ route: z.object({ store: z.literal("cross-user"), configDir: z.string().min(1) }).strict(), accountKey }).strict();
export const continuityInput = z.union([localInput, crossUserInput]);
export type ContinuityInput = z.infer<typeof localInput>;
export type CombinedUsageInput = z.infer<typeof continuityInput>;
export function isLocalUsageInput(input: CombinedUsageInput): input is ContinuityInput {
  return input.route.store !== "cross-user";
}
