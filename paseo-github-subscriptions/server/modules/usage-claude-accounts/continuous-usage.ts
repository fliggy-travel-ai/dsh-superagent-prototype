import { CrossUserUsage } from "./cross-user.ts";
import { ActiveSessions } from "./active-sessions.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageAccount, UsageReport, UsageScope } from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../../vendor/paseo-0.15.0/claude-usage-source/shared/input.ts";
import { isLocalUsageInput, type CombinedUsageInput } from "../../../shared/continuity-input.ts";
import { UsageContinuity, digest, readIdentity, type CredentialState } from "./continuity.ts";
import { discover, fetchUsage, resolveClaudeCredentials, claudeKeychainAccount } from "../../vendor/paseo-0.15.0/claude-usage-source/server/usage.ts";
import { paseoHome } from "./providers.ts";
import { cli } from "./resume.ts";
import { hasAuthOverride, initializeLogin, RenewalService, type RenewalTarget } from "./renewal.ts";

/** Keep vendor requests comfortably below the host's 20-second usage deadline. */
const boundedFetch: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });

export interface ContinuousUsageOptions {
  /** Paseo home (config.json, agents, projects). Default: PASEO_HOME or ~/.paseo. */
  home?: string;
  /** State directory (usage-history.json, cross-user-*.json, renewal/). Default: the old plugin's directory. */
  directory?: string;
  /** Start the background login renewal. Default true. */
  renewal?: boolean;
}

export class ContinuousUsage {
  private activeSessions: ActiveSessions;
  private crossUser: CrossUserUsage;
  readonly history: UsageContinuity;
  private routes = new Map<string, NodeJS.ProcessEnv>();
  private renewal: RenewalService;
  private readonly home: string;
  private readonly renewalEnabled: boolean;
  constructor(options: ContinuousUsageOptions = {}) {
    this.home = options.home ?? paseoHome(process.env);
    const directory = options.directory ?? join(this.home, "claude-quota-resume");
    this.renewalEnabled = options.renewal ?? true;
    this.activeSessions = new ActiveSessions(this.home);
    this.crossUser = new CrossUserUsage({ directory });
    this.history = new UsageContinuity(join(directory, "usage-history.json"));
    this.renewal = new RenewalService({
      targets: () => this.targets(),
      read: target => this.targetState(target),
      run: (target, before, signal) => initializeLogin({ target, before, signal,
        cwd: join(directory, "renewal"), read: () => this.targetState(target) }),
      onRenewed: async () => { await cli(["usage", "ls", "--refresh", "--json"]); },
    });
  }
  start() { if (this.renewalEnabled) this.renewal.start(); }
  stop() { return this.renewal.stop(); }
  private inputs(env: NodeJS.ProcessEnv): UsageInput[] {
    const home = env.HOME || homedir();
    const dir = env.CLAUDE_CONFIG_DIR;
    return [
      { route: { store: "keychain", service: `Claude Code-credentials${dir ? `-${digest(dir.normalize("NFC")).slice(0, 8)}` : ""}`, account: claudeKeychainAccount(env.USER) } },
      { route: { store: "claude", path: join(dir || join(home, ".claude"), ".credentials.json") } },
    ];
  }
  private async read(input: UsageInput, env: NodeJS.ProcessEnv) {
    const record = await resolveClaudeCredentials(input, { env });
    if (!record) return { record: null, state: null };
    const identityPath = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME || homedir(), ".claude.json");
    const state: CredentialState = { fingerprint: digest(record.oauth.accessToken), expires: record.expires,
      refreshable: !!record.oauth.refreshToken, identity: readIdentity(identityPath) };
    return { record, state };
  }
  private async targetState(target: RenewalTarget): Promise<CredentialState | null> {
    for (const input of this.inputs(target.env)) {
      const { state } = await this.read(input, target.env);
      if (state) return state;
    }
    return null;
  }
  /** The login of this provider cannot be used: no credentials, or expired with nothing to renew from. */
  async needsLogin(env: NodeJS.ProcessEnv): Promise<boolean> {
    if (this.crossUser.handles(env.CLAUDE_CONFIG_DIR)) return false;
    const state = await this.targetState({ id: "", env });
    return !state || (state.expires !== undefined && state.expires <= Date.now() && !state.refreshable);
  }
  /** The account identity (email as Anthropic reports it) kept in the provider's .claude.json, if any. */
  identityEmail(env: NodeJS.ProcessEnv): string | null {
    return readIdentity(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME || homedir(), ".claude.json"))?.label ?? null;
  }
  private targets(): RenewalTarget[] {
    const config = JSON.parse(readFileSync(join(this.home, "config.json"), "utf8"));
    const providers = config.agents?.providers ?? {};
    const base = { ...process.env }; delete base.CLAUDE_CONFIG_DIR;
    const seen = new Set<string>();
    return Object.entries(providers).flatMap(([id, value]) => {
      const provider = value as { extends?: string; enabled?: boolean; env?: Record<string, string> };
      if (provider.enabled === false || (id !== "claude" && provider.extends !== "claude") || hasAuthOverride(provider.env ?? {})) return [];
      if (id !== "claude" && !provider.env?.CLAUDE_CONFIG_DIR) return [];
      const env = { ...base, ...provider.env };
      if (this.crossUser.handles(env.CLAUDE_CONFIG_DIR)) return [];
      const key = env.CLAUDE_CONFIG_DIR || "default";
      if (seen.has(key)) return [];
      seen.add(key); return [{ id, env }];
    });
  }
  /** Used by both global quota discovery and provider-name discovery. */
  discover = async (scope: UsageScope): Promise<UsageAccount[]> => {
    const env = scope.kind === "session" ? scope.env : process.env;
    if (this.crossUser.handles(env.CLAUDE_CONFIG_DIR)) return this.crossUser.discover(env.CLAUDE_CONFIG_DIR!);
    const managed = scope.kind === "global" || scope.provider === "claude";
    if (!managed) return (await discover(scope, {}, boundedFetch)).map(a => ({ ...a, input: { ...(a.input as object), accountKey: a.key } }));
    const before = new Map<string, CredentialState | null>();
    for (const input of this.inputs(env)) {
      const id = JSON.stringify(input.route);
      this.routes.set(id, env); before.set(id, (await this.read(input, env)).state);
    }
    const accounts = await discover(scope, {}, boundedFetch);
    const result: UsageAccount[] = [];
    for (const account of accounts) {
      const input = account.input as UsageInput;
      let stable = account;
      if (input.route.store === "keychain" || input.route.store === "claude") {
        const id = JSON.stringify(input.route);
        stable = this.history.observe(account, before.get(id) ?? null, (await this.read(input, env)).state);
      }
      result.push({ ...stable, input: { ...input, accountKey: stable.key } });
    }
    return result;
  };
  fetch = async (input: CombinedUsageInput): Promise<UsageReport> => {
    if (!isLocalUsageInput(input)) {
      const report = await this.crossUser.fetch(input.route.configDir, input.accountKey);
      return this.withSessionCount(report, { CLAUDE_CONFIG_DIR: input.route.configDir });
    }
    if (input.route.store !== "claude" && input.route.store !== "keychain") return fetchUsage(input, boundedFetch);
    const env = this.routes.get(JSON.stringify(input.route));
    if (!env) return { status: "error", error: "正在重新确认账号，请稍后刷新额度" };
    const before = await this.read(input, env);
    if (!before.state) return { status: "error", error: "未找到登录凭据，请在对应账号的 Claude Code 终端登录" };
    // Expired first-time logins without metadata can still show the upstream sign-in remedy.
    if (!this.history.matches(input, input.accountKey, before.state)) {
      if ((before.state.identity?.key === input.accountKey || input.accountKey === digest(JSON.stringify(input.route))) && before.state.expires !== undefined && before.state.expires <= Date.now()) {
        return this.history.restoreMessage(input.accountKey, { status: "unavailable", problem: { kind: "expired", expiresAt: new Date(before.state.expires).toISOString(), refreshedBy: "claude" } });
      }
      return { status: "error", error: "登录凭据已变化，正在重新确认账号；请刷新额度，旧会话请重新打开" };
    }
    let report: UsageReport;
    try {
      report = await fetchUsage(input, boundedFetch, {
        env, readKeychainCredentials: async () => before.record ? { claudeAiOauth: { ...before.record.oauth, expiresAt: before.record.expires } } : null,
      });
    } catch (error) {
      const limited = error instanceof Error && error.message.startsWith("Rate limited by Claude.");
      report = { status: "error", error: limited ? "额度接口暂时限流，将按服务要求等待后自动重试" : "额度查询暂时失败，后台会自动重试" };
    }
    const after = await this.read(input, env);
    if (!after.state || before.state.fingerprint !== after.state.fingerprint || before.state.identity?.key !== after.state.identity?.key) {
      return { status: "error", error: "查询期间登录发生变化，结果已丢弃，请刷新额度" };
    }
    this.history.record(input, before.state, after.state, report);
    // Keep normal structured problems; after reload, display disk history as unavailable text.
    return this.withSessionCount(this.history.restoreMessage(input.accountKey, report), env);
  };
  private async withSessionCount(report: UsageReport, env: NodeJS.ProcessEnv): Promise<UsageReport> {
    if (report.status !== 'available') return report;
    let value: string;
    try { value = String(await this.activeSessions.count(env)); } catch { value = '暂不可用'; }
    return { ...report, details: [{ id: 'active_sessions', label: '未关闭会话（不含空闲子会话）', value }, ...(report.details || [])] };
  }
}
