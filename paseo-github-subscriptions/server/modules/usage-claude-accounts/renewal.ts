import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialState } from "./continuity.ts";

export type RenewalTarget = { id: string; env: NodeJS.ProcessEnv };
export const RENEW_BEFORE_MS = 5 * 60_000;
export const INITIALIZE_ARGS = [
  "--safe-mode", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--tools", "", "--settings", '{"disableAllHooks":true}',
];
export function renewalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") delete result[key];
  }
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return result;
}
export function hasAuthOverride(env: Record<string, unknown>): boolean {
  return Object.entries(env).some(([key, value]) => !!value && (
    key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN" || key === "ANTHROPIC_BASE_URL" ||
    key.startsWith("CLAUDE_CODE_OAUTH") || key.startsWith("CLAUDE_CODE_USE_")
  ));
}
export function renewed(before: CredentialState, after: CredentialState | null, now: number): boolean {
  return !!after?.expires && after.expires > (before.expires ?? 0) && after.expires > now + RENEW_BEFORE_MS &&
    before.identity?.key === after.identity?.key;
}

/** The only message written to Claude is a protocol initialize request. Never a user prompt. */
export async function initializeLogin(options: {
  target: RenewalTarget; before: CredentialState; cwd: string; signal: AbortSignal;
  read: () => Promise<CredentialState | null>; command?: string; timeoutMs?: number;
}): Promise<"renewed" | "unchanged" | "unexpected-model-output"> {
  const { target, before, cwd, signal, read } = options;
  if (signal.aborted) return "unchanged";
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const local = join(homedir(), ".local", "bin", "claude");
  const command = options.command ?? (existsSync(local) ? local : "claude");
  const child = spawn(command, INITIALIZE_ARGS, {
    cwd, env: renewalEnvironment(target.env), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let unexpected = false;
  let closed = false;
  let buffer = "";
  const close = new Promise<void>(resolve => {
    child.once("error", () => { closed = true; resolve(); });
    child.once("close", () => { closed = true; resolve(); });
  });
  const kill = () => {
    if (!child.pid || closed) return;
    try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
  };
  child.stdout.on("data", data => {
    buffer += data.toString();
    if (buffer.length > 1024 * 1024) { kill(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (["assistant", "result", "stream_event"].includes(message.type)) { unexpected = true; kill(); }
      } catch { /* CLI diagnostics are never logged by the plugin */ }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const abort = () => kill();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(kill, options.timeoutMs ?? 25_000);
  child.stdin.write(JSON.stringify({ type: "control_request", request_id: "quota-renewal", request: { subtype: "initialize" } }) + "\n");
  try {
    while (!closed && !signal.aborted) {
      const current = await read();
      if (renewed(before, current, Date.now())) {
        child.stdin.end();
        await Promise.race([close, new Promise(resolve => setTimeout(resolve, 1000))]);
        return unexpected ? "unexpected-model-output" : "renewed";
      }
      await Promise.race([close, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    return unexpected ? "unexpected-model-output" : "unchanged";
  } finally {
    clearTimeout(timeout); signal.removeEventListener("abort", abort); kill();
    await close;
  }
}

export class RenewalService {
  private deps: {
    targets: () => RenewalTarget[]; read: (target: RenewalTarget) => Promise<CredentialState | null>;
    run: (target: RenewalTarget, before: CredentialState, signal: AbortSignal) => Promise<"renewed" | "unchanged" | "unexpected-model-output">;
    onRenewed: () => Promise<void>; now?: () => number;
  };
  private attempts = new Map<string, { fingerprint: string; failures: number; nextAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private running: Promise<void> | null = null;
  private disabled = false;
  constructor(deps: RenewalService["deps"]) { this.deps = deps; }
  start() { this.schedule(20_000); }
  private schedule(ms: number) {
    if (this.controller.signal.aborted || this.disabled) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(60_000));
    }, ms);
    this.timer.unref?.();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    const task = this.check().catch(() => console.warn("登录续期检查暂时失败，将稍后重试")).finally(() => { this.running = null; });
    this.running = task; return task;
  }
  private async check() {
    const now = this.deps.now ?? Date.now;
    let changed = false;
    for (const target of this.deps.targets()) {
      if (this.controller.signal.aborted || this.disabled) break;
      const before = await this.deps.read(target);
      if (!before?.expires || !before.refreshable || before.expires > now() + RENEW_BEFORE_MS) continue;
      const attempt = this.attempts.get(target.id);
      if (attempt?.fingerprint === before.fingerprint && attempt.nextAt > now()) continue;
      let result: Awaited<ReturnType<RenewalService["deps"]["run"]>> = "unchanged";
      try { result = await this.deps.run(target, before, this.controller.signal); } catch { /* bounded retry below */ }
      if (result === "unexpected-model-output") {
        this.disabled = true;
        console.error("Claude 初始化出现非预期模型输出，已停止后台登录续期");
        break;
      }
      const after = await this.deps.read(target);
      if (renewed(before, after, now())) {
        this.attempts.delete(target.id); changed = true;
        console.info("Claude 登录已自动续期：", target.id);
      } else {
        const failures = before.expires > now() ? 0
          : attempt?.fingerprint === before.fingerprint ? attempt.failures + 1 : 1;
        // Retry transient failures while the old token still works; do not wait past its expiry.
        const delay = before.expires > now() ? 60_000
          : Math.min(6 * 60 * 60_000, 10 * 60_000 * 2 ** Math.min(failures - 1, 6));
        this.attempts.set(target.id, { fingerprint: before.fingerprint, failures, nextAt: now() + delay });
        console.warn("Claude 登录续期未完成，已延后重试：", target.id, `${delay / 60_000} 分钟`);
      }
    }
    if (changed && !this.controller.signal.aborted) await this.deps.onRenewed();
  }
  async stop() {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
