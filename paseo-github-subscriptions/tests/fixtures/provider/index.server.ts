import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fixtureProvider } from "./server/provider.ts";
export default function (server: PluginServerContext) {
  server.registerProvider(fixtureProvider());
  return () => {};
}
