import { defineAgentTool } from "@getpaseo/plugin/server";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { probeEnv } from "./shared/contracts.ts";
import { envFacts } from "./server/env.ts";

export default function contribute(server: PluginServerContext) {
  // 试验：从处理函数上下文里留存 paseo，之后在处理函数外使用（对应方案 2.3 的“常驻连接”替代做法）。
  let stashed: any = null;
  server.handle(probeEnv, async (_input, context: any) => {
    if (context?.paseo) stashed = context.paseo;
    let stashedListOk: boolean | null = null;
    if (stashed) {
      try {
        await stashed.agents.list({});
        stashedListOk = true;
      } catch {
        stashedListOk = false;
      }
    }
    return { ...envFacts(), stashedPaseo: !!stashed, stashedListOk };
  });
  const tool = defineAgentTool({
    name: "ghsub_probe_env",
    description: "探针：返回插件进程环境是否有 GH_TOKEN（只返回有无和长度）。",
    input: z.object({}),
    async execute(_input, context) {
      if (context.paseo) stashed = context.paseo;
      return { text: JSON.stringify(envFacts()), structuredContent: envFacts() };
    },
  });
  const remove = server.addHook("agent.open.before", async ({ request }: any) => {
    console.log("agent.open.before purpose=" + request.purpose + " provider=" + request.provider + " tools=" + JSON.stringify((request.tools ?? []).length));
    return { ...request, tools: [...(request.tools ?? []), tool] };
  });
  console.log("探针已启动 env=" + JSON.stringify(envFacts()));
  return () => remove();
}
