import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GRACE_MS = 30_000;
const PROMPT = "额度已恢复。请先检查会话进度和当前工作状态，然后继续完成未完成的任务。若任务已经完成，请不要重复操作。";
type Report = { sourceId?: string; report?: { status?: string; windows?: { id?: string; usedPct?: number | null; remainingPct?: number | null; resetsAt?: string | null }[] } };
type Snapshot = { Id: string; Status: string; Archived: boolean; UpdatedAt: string; PendingPermissions?: unknown[] };
type Job = { agentId: string; resetAt: number; updatedAt: string; phase: "pending" | "sending" };
// "claude" is Paseo's bundled source (default login); "claude-accounts" is this module's default source ID.
export const DEFAULT_CLAUDE_SOURCES: ReadonlySet<string> = new Set(["claude", "claude-accounts"]);

export function isQuotaError(text: string): boolean {
  return /(?:you(?:'|’)ve hit your (?:(?:session|usage|5.hour) )?limit|(?:session|5.hour|usage) (?:limit|quota) (?:reached|exceeded)|usage_limit_reached)/i.test(text);
}

export function findReset(reports: Report[], now: number, sources: ReadonlySet<string> = DEFAULT_CLAUDE_SOURCES): number | null {
  const matches = reports.filter(r => sources.has(r.sourceId ?? "") && r.report?.status === "available");
  if (matches.length !== 1) return null;
  const windows = matches[0].report?.windows?.filter(w => w.id === "five_hour") ?? [];
  if (windows.length !== 1) return null;
  const w = windows[0];
  if (!((w.usedPct != null && w.usedPct >= 100) || (w.remainingPct != null && w.remainingPct <= 0))) return null;
  const reset = Date.parse(w.resetsAt ?? "");
  return Number.isFinite(reset) && reset > now && reset <= now + 6 * 60 * 60 * 1000 ? reset : null;
}

function cliPath(): string {
  return process.env.PASEO_CLI || (process.platform === "darwin" ? "/Applications/Paseo.app/Contents/Resources/bin/paseo" : "paseo");
}
export async function cli(args: string[]): Promise<string> {
  const { stdout } = await exec(cliPath(), args, { timeout: 25_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  return stdout;
}

export class ResumeService {
  private readonly isClaudeProvider: (id: string) => boolean;
  private readonly sources: ReadonlySet<string>;
  /** The global default for sessions the user has not decided on (new sessions). */
  private readonly autoResumeDefault: () => boolean;
  constructor(options: { isClaudeProvider?: (id: string) => boolean; directory?: string; sources?: ReadonlySet<string>; autoResumeDefault?: () => boolean } = {}) {
    this.isClaudeProvider = options.isClaudeProvider ?? (id => id === "claude");
    this.sources = options.sources ?? DEFAULT_CLAUDE_SOURCES;
    this.autoResumeDefault = options.autoResumeDefault ?? (() => false);
    this.directory = options.directory ?? join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-quota-resume");
    this.path = join(this.directory, "jobs.json");
    this.enabledPath = join(this.directory, "enabled-agents.json");
    this.disabledPath = join(this.directory, "disabled-agents.json");
  }
  private jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = new Set<string>();
  private generations = new Map<string, number>();
  private readonly directory: string;
  private readonly path: string;
  // Sessions the user opted into. Kept apart from jobs because a new turn deletes the job but not the choice.
  private readonly enabledPath: string;
  // Sessions the user opted out of. Only matters when the global default is on.
  private readonly disabledPath: string;
  private enabled = new Set<string>();
  private disabled = new Set<string>();
  private stopped = false;

  async start() {
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(saved)) throw new Error("invalid jobs file");
      for (const job of saved) {
        if (typeof job.agentId === "string" && typeof job.resetAt === "number" && typeof job.updatedAt === "string" && job.phase === "pending") this.jobs.set(job.agentId, job);
        else if (job.phase === "sending") console.warn("上次发送结果未知，已停止自动重试：", job.agentId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("无法读取待恢复任务：", String(error));
    }
    try {
      const saved = JSON.parse(readFileSync(this.enabledPath, "utf8"));
      if (!Array.isArray(saved)) throw new Error("invalid enabled file");
      for (const id of saved) if (typeof id === "string") this.enabled.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("无法读取已开启自动继续的会话：", String(error));
    }
    try {
      const saved = JSON.parse(readFileSync(this.disabledPath, "utf8"));
      if (!Array.isArray(saved)) throw new Error("invalid disabled file");
      for (const id of saved) if (typeof id === "string") this.disabled.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("无法读取已关闭自动继续的会话：", String(error));
    }
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
    await Promise.all([this.tick(), this.scanExisting()]);
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  retryAt(agentId: string): number | null {
    const job = this.jobs.get(agentId);
    return job?.phase === "pending" ? job.resetAt + GRACE_MS : null;
  }
  /** An explicit choice wins; otherwise the global default applies. */
  isEnabled(agentId: string): boolean {
    return this.enabled.has(agentId) || (this.autoResumeDefault() && !this.disabled.has(agentId));
  }
  private write(path: string, value: unknown) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  }
  private save() {
    this.write(this.path, [...this.jobs.values()]);
  }
  // The job stays while disabled: it keeps the card visible, and re-enabling needs no new scan.
  setEnabled(agentId: string, enabled: boolean) {
    const changed = enabled !== this.isEnabled(agentId);
    // Record the choice even when it equals the current default, so a later change of the default keeps it.
    if (enabled) { this.enabled.add(agentId); this.disabled.delete(agentId); } else { this.enabled.delete(agentId); this.disabled.add(agentId); }
    this.write(this.enabledPath, [...this.enabled]);
    this.write(this.disabledPath, [...this.disabled]);
    if (changed) console.info(enabled ? "已开启自动继续：" : "已关闭自动继续：", agentId);
  }
  /** Sessions with an explicit choice, for the settings page. */
  explicitCounts(): { enabled: number; disabled: number } { return { enabled: this.enabled.size, disabled: this.disabled.size }; }
  pendingCount(): number { return [...this.jobs.values()].filter(job => job.phase === "pending").length; }
  async cancel(agentId: string) {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    if (this.jobs.delete(agentId)) { this.save(); console.info("已取消待恢复任务：", agentId); }
  }
  async forget(agentId: string) {
    await this.cancel(agentId);
    const known = this.enabled.delete(agentId) || this.disabled.delete(agentId);
    if (known) { this.write(this.enabledPath, [...this.enabled]); this.write(this.disabledPath, [...this.disabled]); console.info("已清除自动继续选择：", agentId); }
  }
  async consider(agentId: string, text: string) {
    if (this.jobs.has(agentId)) return;
    if (!isQuotaError(text)) return;
    const generation = this.generations.get(agentId) ?? 0;
    try {
      const reports = JSON.parse(await cli(["usage", "--agent", agentId, "--refresh", "--json"])) as Report[];
      const resetAt = findReset(reports, Date.now(), this.sources);
      if (!resetAt) { console.warn("未确认该会话的 5 小时额度重置时间，未安排自动继续：", agentId); return; }
      const snap = JSON.parse(await cli(["inspect", agentId, "--json"])) as Snapshot;
      if (this.stopped || generation !== (this.generations.get(agentId) ?? 0)) return;
      if (snap.Id !== agentId || snap.Archived || !["idle", "error"].includes(snap.Status) || !snap.UpdatedAt || snap.PendingPermissions?.length) return;
      this.jobs.set(agentId, { agentId, resetAt, updatedAt: snap.UpdatedAt, phase: "pending" });
      this.save();
      console.info(this.isEnabled(agentId) ? "已安排额度恢复后继续：" : "检测到额度耗尽，自动继续未开启，已记录重置时间：", agentId, new Date(resetAt + GRACE_MS).toISOString());
    } catch (error) { console.warn("无法安排自动继续：", agentId, String(error)); }
  }
  private async scanExisting() {
    try {
      const agents = JSON.parse(await cli(["ls", "--global", "--background", "--json"])) as { id: string; provider: string; status: string }[];
      for (const agent of agents) {
        if (this.stopped) return;
        if (!this.isClaudeProvider(agent.provider?.split("/")[0] ?? "") || !["idle", "error"].includes(agent.status) || this.jobs.has(agent.id)) continue;
        try {
          const snapshot = JSON.parse(await cli(["inspect", agent.id, "--json"])) as Snapshot;
          if (!snapshot.UpdatedAt || Date.now() - Date.parse(snapshot.UpdatedAt) > 5 * 60 * 60 * 1000) continue;
          const tail = await cli(["logs", agent.id, "--tail", "1"]);
          await this.consider(agent.id, tail);
        } catch (error) { console.warn("无法检查已有会话：", agent.id, String(error)); }
      }
    } catch (error) { console.warn("无法检查已有 Claude 会话：", String(error)); }
  }
  async tick() {
    const pending: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (this.stopped || job.phase !== "pending" || !this.isEnabled(job.agentId) || Date.now() < job.resetAt + GRACE_MS || this.processing.has(job.agentId)) continue;
      this.processing.add(job.agentId);
      pending.push(this.fire(job).finally(() => this.processing.delete(job.agentId)));
    }
    await Promise.all(pending);
  }
  private async fire(job: Job) {
    try {
      const snap = JSON.parse(await cli(["inspect", job.agentId, "--json"])) as Snapshot;
      if (this.stopped || this.jobs.get(job.agentId) !== job || !this.isEnabled(job.agentId)) return;
      if (snap.Id !== job.agentId || snap.Archived || !["idle", "error"].includes(snap.Status) || snap.UpdatedAt !== job.updatedAt || snap.PendingPermissions?.length) {
        await this.cancel(job.agentId);
        console.info("会话状态已改变，未自动继续：", job.agentId);
        return;
      }
      job.phase = "sending";
      this.save();
      await cli(["send", job.agentId, PROMPT, "--no-wait", "--json"]);
      console.info("已发送继续消息：", job.agentId);
    } catch (error) {
      if (job.phase === "sending") console.error("发送结果未知，已停止自动重试：", job.agentId, String(error));
      else { console.warn("暂时无法检查会话，将稍后重试：", job.agentId, String(error)); return; }
    }
    if (this.jobs.get(job.agentId) === job) { this.jobs.delete(job.agentId); this.save(); }
  }
}
