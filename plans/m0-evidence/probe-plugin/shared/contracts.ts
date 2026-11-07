import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const probeEnv = defineRpc({
  name: "probe.env",
  input: z.object({}),
  output: z.object({
    hasGhToken: z.boolean(),
    ghTokenLength: z.number(),
    hasGithubToken: z.boolean(),
    pasteoHome: z.string().nullable(),
    node: z.string(),
    pid: z.number(),
    stashedPaseo: z.boolean(),
    stashedListOk: z.boolean().nullable(),
  }),
});
