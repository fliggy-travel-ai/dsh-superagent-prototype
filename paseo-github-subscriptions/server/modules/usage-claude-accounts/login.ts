import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APPLE_SUFFIX, isAppleRelay } from './accounts.ts';
import type { ClaudeAccountsSnapshot } from '../../../shared/claude-accounts.ts';

const exec = promisify(execFile);
export type ActiveFlow = NonNullable<ClaudeAccountsSnapshot['activeFlow']>;

/**
 * 添加 Claude 账号和重新登录的引导（同一 macOS 用户的配置目录模式）。
 * 步骤：1 写配置 2 建目录 3 开登录终端 4 等浏览器登录 5 等授权码 6 读邮箱命名。
 * 浏览器登录和粘贴授权码是人工步骤；插件只开终端、读链接、输入授权码、读邮箱并命名。
 * 授权码只写进终端，不记录、不保存；登录链接只在内存里，不写文件。
 */
export interface TerminalLike {
  readonly id: string;
  write(data: string): void;
  sendKeys(keys: readonly string[]): void;
  capture(): Promise<string[]>;
  kill(): Promise<void>;
}

export interface AuthStatus { loggedIn: boolean; email: string | null; subscriptionType: string | null }

export interface LoginPorts {
  /** 用户目录，用来拼配置目录 `~/.claude-N`。 */
  homeDirectory: string;
  providers(): Record<string, any>;
  /** 改配置前备份 config.json。 */
  backupConfig(): void;
  patchProvider(id: string, entry: Record<string, unknown>): Promise<void>;
  ensureConfigDirectory(directory: string): void;
  findLoginWorkspace(): Promise<{ id: string; cwd: string } | null>;
  createTerminal(workspaceId: string, name: string, cwd: string): Promise<TerminalLike>;
  authStatus(configDirectory: string): Promise<AuthStatus>;
  /** 写 labels.json：Anthropic 返回的邮箱 → 显示名称。 */
  setLabel(key: string, value: string): void;
  sleep(ms: number): Promise<void>;
}

export function nextProviderId(providers: Record<string, unknown>): string {
  let max = 1;
  for (const id of Object.keys(providers)) {
    const match = /^claude-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `claude-${max + 1}`;
}

/** 把终端折成多行的登录链接拼回完整链接。code_challenge 和 state 都必须是 43 个字符，否则说明拼接有误。 */
export function extractLoginUrl(lines: readonly string[]): string | null {
  const text = lines.map(line => line.replace(/\n$/, '')).join('');
  const start = text.indexOf('https://claude.com/');
  if (start < 0) return null;
  const end = text.indexOf('Paste code here', start);
  const url = (end >= 0 ? text.slice(start, end) : text.slice(start)).trim();
  const query = new URL(url).searchParams;
  for (const key of ['code_challenge', 'state']) {
    const length = (query.get(key) ?? '').length;
    if (length !== 43) throw new Error(`${key} 长度是 ${length}，应该是 43：链接拼接有误`);
  }
  return url;
}

export function parseAuthStatus(output: string): AuthStatus {
  try {
    const value = JSON.parse(output) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
    const email = typeof value.email === 'string' ? value.email : null;
    return { loggedIn: value.loggedIn === true || (value.loggedIn === undefined && !!email), email, subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null };
  } catch {
    const email = /email"?\s*[:=]\s*"?([^\s",}]+)/i.exec(output)?.[1] ?? null;
    return { loggedIn: !!email, email, subscriptionType: null };
  }
}

/** 建配置目录：各账号自己的记录、临时目录和缓存；技能和用户级提示词链接到共享目录。已有内容不动。 */
export function ensureConfigDirectory(directory: string, sharedDirectory: string) {
  mkdirSync(join(directory, 'projects'), { recursive: true });
  for (const sub of [join('tmp'), join('cache', 'xdg')]) {
    const path = join(directory, sub);
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  chmodSync(join(directory, 'cache'), 0o700);
  for (const name of ['skills', 'CLAUDE.md']) {
    const source = join(sharedDirectory, name);
    const target = join(directory, name);
    if (existsSync(source) && !existsSync(target)) symlinkSync(source, target);
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ATTEMPTS = 40;
const POLL_MS = 500;

export class LoginFlows {
  private readonly ports: LoginPorts;
  private flow: (ActiveFlow & { terminal: TerminalLike | null }) | null = null;

  constructor(ports: LoginPorts) { this.ports = ports; }

  current(): ActiveFlow | null {
    if (!this.flow) return null;
    const { terminal: _terminal, ...flow } = this.flow;
    return flow;
  }

  private configDirectory(id: string): string {
    return `${this.ports.homeDirectory}/.${id}`;
  }
  private display(directory: string) { return directory.startsWith(`${this.ports.homeDirectory}/`) ? `~${directory.slice(this.ports.homeDirectory.length)}` : directory; }

  async start(input: { providerId?: string; browserProfile?: string }): Promise<ActiveFlow> {
    if (this.flow && this.flow.error === null && this.flow.step >= 3) await this.flow.terminal?.kill().catch(() => {});
    const providers = this.ports.providers();
    const existing = input.providerId !== undefined;
    const id = input.providerId ?? nextProviderId(providers);
    if (existing && !providers[id]) throw new Error(`Provider ${id} 不存在`);
    const configured = providers[id]?.env?.CLAUDE_CONFIG_DIR as string | undefined;
    const configDir = configured ?? this.configDirectory(id);
    this.flow = { providerId: id, configDir: this.display(configDir), step: 1, terminalId: null, workspaceId: null, loginUrl: null, detectedEmail: null, requiresRealEmailConfirmation: false, error: null, terminal: null };
    const flow = this.flow;
    try {
      if (!existing) {
        this.ports.backupConfig();
        const number = id.slice('claude-'.length);
        const models = providers.claude?.models;
        await this.ports.patchProvider(id, {
          extends: 'claude', label: `Claude ${number}（待登录）`, description: `第 ${number} 个 Claude 账号（配置目录 ${this.display(configDir)}）`,
          env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_TMPDIR: `${configDir}/tmp`, TMPDIR: `${configDir}/tmp`, XDG_CACHE_HOME: `${configDir}/cache/xdg` },
          ...(models !== undefined ? { models: JSON.parse(JSON.stringify(models)) } : {}),
          enabled: true,
        });
      }
      flow.step = 2;
      this.ports.ensureConfigDirectory(configDir);
      flow.step = 3;
      const workspace = await this.ports.findLoginWorkspace();
      if (!workspace) throw new Error('没有名为“账号登录”的工作区。先在 Paseo 中创建这个工作区，再重试。');
      flow.workspaceId = workspace.id;
      const number = id.replace(/^claude-?/, '') || '1';
      flow.terminal = await this.ports.createTerminal(workspace.id, `Claude ${number} 登录`, workspace.cwd);
      flow.terminalId = flow.terminal.id;
      await this.runLogin(flow, configDir);
    } catch (error) { flow.error = error instanceof Error ? error.message : String(error); }
    return this.current()!;
  }

  /** 在终端里启动登录命令并读出链接。BROWSER 指向 true，避免系统默认浏览器自动打开授权页。 */
  private async runLogin(flow: NonNullable<typeof this.flow>, configDir: string) {
    flow.error = null; flow.loginUrl = null;
    flow.terminal!.write(`clear; BROWSER=/usr/bin/true CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude auth login --claudeai`);
    flow.terminal!.sendKeys(['Enter']);
    flow.step = 4;
    let waitedForPrompt = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await this.ports.sleep(POLL_MS);
      const lines = await flow.terminal!.capture();
      const url = extractLoginUrl(lines);
      if (url) {
        flow.loginUrl = url;
        waitedForPrompt = lines.join('').includes('Paste code here');
        if (waitedForPrompt) { flow.step = 5; return; }
      }
    }
    throw new Error(flow.loginUrl ? '读到了登录链接，但终端没有出现授权码输入框' : '没有读到登录链接，请查看登录终端');
  }

  async retry(providerId: string): Promise<ActiveFlow> {
    const flow = this.requireFlow(providerId);
    if (!flow.terminal) throw new Error('登录终端还没有打开，请重新开始');
    flow.terminal.sendKeys(['C-c']);
    try {
      let back = false;
      for (let attempt = 0; attempt < 10 && !back; attempt++) {
        await this.ports.sleep(POLL_MS);
        back = !(await flow.terminal.capture()).join('').includes('Paste code here');
      }
      if (!back) throw new Error('终端没有回到命令行，请在终端中手动按 Ctrl-C 后再试');
      const configured = this.ports.providers()[providerId]?.env?.CLAUDE_CONFIG_DIR as string | undefined;
      await this.runLogin(flow, configured ?? this.configDirectory(providerId));
    } catch (error) { flow.error = error instanceof Error ? error.message : String(error); }
    return this.current()!;
  }

  private requireFlow(providerId: string) {
    if (!this.flow || this.flow.providerId !== providerId) throw new Error(`没有正在进行的 ${providerId} 登录引导`);
    return this.flow;
  }

  /** 把授权码输入终端，等待登录完成，再读邮箱并命名。返回 null 表示流程已结束。 */
  async submitCode(input: { providerId: string; code: string; realEmail?: string }): Promise<ActiveFlow | null> {
    const flow = this.requireFlow(input.providerId);
    if (!flow.terminal || flow.step < 5) throw new Error('还没有读到登录链接，不能提交授权码');
    flow.error = null;
    flow.terminal.write(input.code);
    flow.terminal.sendKeys(['Enter']);
    flow.step = 6;
    const configDir = (this.ports.providers()[input.providerId]?.env?.CLAUDE_CONFIG_DIR as string | undefined) ?? this.configDirectory(input.providerId);
    let status: AuthStatus | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.ports.sleep(1000);
      const current = await this.ports.authStatus(configDir).catch(() => null);
      if (current?.loggedIn) { status = current; break; }
    }
    if (!status) { flow.step = 5; flow.error = '登录还没有完成：授权码可能无效或已过期。点“重新触发”后再试。'; return this.current(); }
    flow.detectedEmail = status.email;
    const apple = !!status.email && isAppleRelay(status.email);
    if (apple && !input.realEmail) { flow.requiresRealEmailConfirmation = true; return this.current(); }
    if (apple) { await this.confirmRealEmail(input.providerId, input.realEmail!); return null; }
    await this.finish(flow, status.email ? `Claude · ${status.email}` : null);
    return null;
  }

  /** Apple 登录：确认真实邮箱后写 labels.json 并命名。没有等待确认的流程时返回 false。 */
  async confirmRealEmail(providerId: string, realEmail: string): Promise<boolean> {
    const flow = this.flow;
    if (!flow || flow.providerId !== providerId || !flow.requiresRealEmailConfirmation || !flow.detectedEmail) return false;
    const real = realEmail.trim().toLowerCase();
    this.ports.setLabel(flow.detectedEmail, `${real}${APPLE_SUFFIX}`);
    await this.finish(flow, `Claude · ${real}${APPLE_SUFFIX}`);
    return true;
  }

  private async finish(flow: NonNullable<typeof this.flow>, label: string | null) {
    if (label) await this.ports.patchProvider(flow.providerId, { label });
    await flow.terminal?.kill().catch(() => {});
    this.flow = null;
  }
}

/** 读取 `claude auth status`（用户目录里的 claude，没有时用 PATH 中的）。 */
export async function readAuthStatus(configDirectory: string): Promise<AuthStatus> {
  const local = join(homedir(), '.local', 'bin', 'claude');
  const command = existsSync(local) ? local : 'claude';
  const { stdout } = await exec(command, ['auth', 'status'], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory }, timeout: 15_000 });
  return parseAuthStatus(stdout);
}
