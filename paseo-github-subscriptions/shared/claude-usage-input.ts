// 逐字复制自 server/vendor/paseo-0.15.0/claude-usage-source/shared/input.ts（Paseo 自带插件 claude-usage-source）。
// shared/ 不能引入 server/（Paseo 插件编译器规则），所以这里另存一份；tests/plugin-boundaries.test.ts 核对两份一致，
// vendor 副本升级时同步更新本文件。
import { z } from "zod";

export const routeSchema = z.discriminatedUnion("store", [
  z.object({ store: z.enum(["claude", "pi"]), path: z.string().min(1) }).strict(),
  z
    .object({
      store: z.literal("omp"),
      path: z.string().min(1),
      credentialId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      store: z.literal("keychain"),
      service: z.string().optional(),
      account: z.string().optional(),
    })
    .strict(),
]);
export const inputSchema = z.object({ route: routeSchema }).strict();
export type UsageInput = z.infer<typeof inputSchema>;
