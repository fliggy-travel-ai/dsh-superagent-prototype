import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountQuota, applyQuotaLabels, DEFAULT_CLAUDE_SOURCES, type Quota, type Report } from "./labels.ts";
import { configDirProviders, paseoHome } from "./providers.ts";
import { cli } from "./resume.ts";
import type { discover } from "../../vendor/paseo-0.15.0/claude-usage-source/server/usage.ts";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

const INTERVAL_MS = 60_000;
const FIRST_DELAY_MS = 15_000;

/**
 * Every minute, writes each Claude account's quota or weekly reset countdown into its provider
 * display name in config.json and reloads the daemon config. Reports come from the daemon's usage cache.
 * On stop, the original display names are restored.
 */
export class QuotaLabelService {
  private discover: typeof discover;
  private cached: (key: string) => { at: number; report: UsageReport } | null;
  private readonly sourceId: string;
  private readonly sources: ReadonlySet<string>;
  private readonly lastQuotas = new Map<string, Quota | null>();
  private enabled: boolean;
  constructor(options: { discover: typeof discover; cached?: (key: string) => { at: number; report: UsageReport } | null; home?: string; sourceId?: string; enabled?: boolean }) {
    this.discover = options.discover;
    this.cached = options.cached ?? (() => null);
    this.home = options.home ?? paseoHome(process.env);
    this.path = join(this.home, "config.json");
    this.sourceId = options.sourceId ?? "claude-accounts";
    this.sources = new Set(["claude", this.sourceId]);
    this.enabled = options.enabled ?? true;
  }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly home: string;
  private readonly path: string;

  start() {
    this.schedule(FIRST_DELAY_MS);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
    try { await this.write(new Map()); }
    catch (error) { console.warn("无法恢复账号显示名称：", String(error)); }
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.update()
        .catch((error) => console.warn("无法更新账号额度显示：", String(error)))
        .finally(() => { this.running = null; this.schedule(INTERVAL_MS); });
    }, delay);
    this.timer.unref?.();
  }

  /** Provider ID to launch environment for the default login and each CLAUDE_CONFIG_DIR login. */
  private providerEnvs(): Map<string, Record<string, string>> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string" && key !== "CLAUDE_CONFIG_DIR") base[key] = value;
    }
    const envs = new Map([["claude", base]]);
    for (const [id, env] of configDirProviders({ ...process.env, PASEO_HOME: this.home })) envs.set(id, { ...base, ...env });
    return envs;
  }

  /** Switch the feature at run time. Turning it off restores the original display names. */
  async setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (this.stopped) return;
    if (enabled) { await (this.running ?? Promise.resolve()); this.running = this.update().catch((error) => console.warn("无法更新账号额度显示：", String(error))).finally(() => { this.running = null; }); await this.running; return; }
    await (this.running ?? Promise.resolve());
    try { this.lastQuotas.clear(); await this.write(new Map()); }
    catch (error) { console.warn("无法恢复账号显示名称：", String(error)); }
  }

  /** The last quota seen for each provider, for the settings page. */
  quotas(): ReadonlyMap<string, Quota | null> { return this.lastQuotas; }

  private async update() {
    if (!this.enabled) return;
    const reports = JSON.parse(await cli(["usage", "ls", "--json"])) as Report[];
    const quotas = new Map<string, Quota | null>();
    for (const [id, env] of this.providerEnvs()) {
      try {
        const [account] = await this.discover({ kind: "session", provider: "claude", env });
        let quota = account ? accountQuota(reports, account.key, Date.now(), this.sources) : null;
        if (!quota && account) {
          const cached = this.cached(account.key);
          if (cached?.report.status === "available") quota = accountQuota([{ sourceId: this.sourceId, id: `${this.sourceId}:${account.key}`,
            report: { status: "error" }, lastSuccessful: { fetchedAt: new Date(cached.at).toISOString(), report: cached.report } }], account.key, Date.now(), this.sources);
        }
        quotas.set(id, quota);
        this.lastQuotas.set(id, quota);
      } catch (error) { console.warn("无法识别账号：", id, String(error)); }
    }
    if (!this.stopped && this.enabled) await this.write(quotas);
  }

  private async write(quotas: Map<string, Quota | null>) {
    const config = JSON.parse(readFileSync(this.path, "utf8"));
    const providers = config?.agents?.providers;
    if (!providers) return;
    const ids = Object.keys(providers).filter((id) => id === "claude" || providers[id]?.extends === "claude");
    const changed = applyQuotaLabels(providers, ids, quotas);
    if (changed.length === 0) return;
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
    await cli(["reload", "--json"]);
    // 显示名称含邮箱，日志只写 Provider 编号和剩余百分比。
    console.info("已更新账号额度显示：", changed.map((id) => { const quota = quotas.get(id); return `${id}=${quota ? `${quota.historical ? "上次剩" : "剩"} ${quota.remainingPct}%` : "无额度"}`; }).join("，"));
  }
}
