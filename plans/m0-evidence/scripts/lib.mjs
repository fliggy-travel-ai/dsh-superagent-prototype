import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
export const HOME = "/tmp/m0/home";
export async function connect() {
  const lock = JSON.parse(readFileSync(join(HOME, "paseo.pid"), "utf8"));
  const client = createHostClient(lock.listen, {
    clientId: "m0-" + randomUUID(), clientType: "cli",
    localCredential: () => readFileSync(join(HOME, "local-credential"), "utf8").trim() || undefined,
    reconnect: { enabled: true },
  });
  await client.connect();
  return { client, paseo: createPaseoApi(client) };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, msg, timeout = 60000, step = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  throw new Error("等待超时：" + msg);
}
export async function timelineSummary(agent) {
  const page = await agent.timeline.refetch({ direction: "tail", limit: 200 });
  return page.entries.map(({ item }) => {
    const base = { type: item.type };
    if (item.type === "user_message" || item.type === "assistant_message") base.text = String(item.text).slice(0, 160);
    if (item.type === "tool_call") { base.name = item.name; base.status = item.status; base.detail = item.detail?.type === "shell" ? { cmd: String(item.detail.command).slice(0, 80), exit: item.detail.exitCode } : item.detail?.type; base.error = item.error ?? undefined; }
    if (item.type === "error") base.text = String(item.message ?? "").slice(0, 160);
    return base;
  });
}
