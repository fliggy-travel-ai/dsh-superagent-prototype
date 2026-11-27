import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageReportEntry } from '../providers-quota-gate/reports.ts';

function sha16(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function hashed(prefix: string, raw: string): string {
  return `${prefix}:${sha16(raw)}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveHome(raw: string, home: string): string {
  return raw.trim().replace(/^~(?=\/|$)/, home);
}

function extractEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
  return match ? match[1]!.trim().toLowerCase() : null;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function reportDetail(report: UsageReportEntry | undefined, id: string): string | null {
  if (!report || report.report.status !== 'available') return null;
  const found = report.report.details?.find(item => item.id === id);
  return found?.value?.trim() || null;
}

function reportAccountLabel(report: UsageReportEntry | undefined): string | null {
  const account = report?.account as { label?: unknown } | undefined;
  return typeof account?.label === 'string' && account.label.trim() ? account.label.trim() : null;
}

export interface IdentityInput {
  serverId: string;
  providerId: string;
  kind: string;
  env: NodeJS.ProcessEnv;
  home: string;
  label?: string;
  claudeKey?: string;
  report?: UsageReportEntry;
  proxied?: boolean;
}

/**
 * 为单个主机上的 Provider 解析跨主机一致且不泄漏明文凭据/邮箱的底层账号键。
 * 无法可靠确认底层账号时退回 `host:<serverId>:<providerId>`，避免误合并不同账号。
 */
export function resolveAccountKey(input: IdentityInput): string {
  const { serverId, providerId, kind, env, home, label, claudeKey, report, proxied } = input;
  if (proxied) return `proxied:${serverId}:${providerId}`;
  const userHome = resolveHome(env.HOME || home, home);

  if (kind === 'claude') {
    if (claudeKey) return `claude:${claudeKey}`;
    if (report && (report.sourceId === 'claude-accounts' || report.sourceId === 'claude')) {
      const suffix = report.id.slice(report.sourceId.length + 1).trim();
      if (suffix && suffix !== 'default') return `claude:${suffix}`;
    }
    const email = extractEmail(reportAccountLabel(report)) ?? extractEmail(label);
    if (email) {
      const apple = /(?:Apple\s*登录|Apple)/i.test(`${reportAccountLabel(report) ?? ''} ${label ?? ''}`);
      return hashed('claude-email', `${email}${apple ? ':apple' : ''}`);
    }
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'codex') {
    if (report?.sourceId === 'codex' && report.id.startsWith('codex:')) {
      const suffix = report.id.slice('codex:'.length).trim().toLowerCase();
      if (suffix && suffix !== 'default') return hashed('codex', suffix);
    }
    const codexHome = resolveHome(env.CODEX_HOME || join(userHome, '.codex'), home);
    const auth = readJson(join(codexHome, 'auth.json'));
    const tokens = auth?.tokens && typeof auth.tokens === 'object' ? (auth.tokens as Record<string, unknown>) : null;
    const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id.trim().toLowerCase() : '';
    if (accountId) return hashed('codex', accountId);
    const jwt = decodeJwtPayload(tokens?.id_token);
    const authClaim = jwt?.['https://api.openai.com/auth'];
    const jwtAccountId = authClaim && typeof authClaim === 'object'
      ? (authClaim as Record<string, unknown>).chatgpt_account_id
      : undefined;
    if (typeof jwtAccountId === 'string' && jwtAccountId.trim()) {
      return hashed('codex', jwtAccountId.trim().toLowerCase());
    }
    const jwtEmail = typeof jwt?.email === 'string' ? jwt.email.trim().toLowerCase() : null;
    const email = jwtEmail
      ?? extractEmail(reportDetail(report, 'email'))
      ?? extractEmail(reportAccountLabel(report))
      ?? extractEmail(label);
    if (email) return hashed('codex-email', email);
    const apiKey = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : (env.OPENAI_API_KEY?.trim() ?? '');
    if (apiKey) return hashed('codex-key', apiKey);
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'antigravity') {
    const token = readJson(join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
    const tokenEmail = typeof token?.id_token_email === 'string' ? extractEmail(token.id_token_email) : null;
    const email = tokenEmail
      ?? extractEmail(reportAccountLabel(report))
      ?? extractEmail(label);
    if (email) return hashed('antigravity', email);
    if (report?.sourceId === 'antigravity' && report.id.startsWith('antigravity:')) {
      const suffix = report.id.slice('antigravity:'.length).trim().toLowerCase();
      if (suffix && suffix !== 'default') return `antigravity:${suffix.slice(0, 16)}`;
    }
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'glm') {
    const configHome = resolveHome(env.XDG_CONFIG_HOME || join(userHome, '.config'), home);
    const creds = readJson(join(configHome, 'glm-acp-agent', 'credentials.json'));
    const apiKey = (typeof creds?.z_ai_api_key === 'string' ? creds.z_ai_api_key : env.Z_AI_API_KEY)?.trim();
    if (apiKey) return hashed('glm', apiKey);
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'grok') {
    const grokHome = resolveHome(env.GROK_HOME || join(userHome, '.grok'), home);
    const auth = readJson(join(grokHome, 'auth.json'));
    if (auth) {
      for (const value of Object.values(auth)) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as Record<string, unknown>;
        const userId = typeof entry.user_id === 'string' ? entry.user_id.trim().toLowerCase() : '';
        if (userId) return hashed('grok', userId);
        const email = typeof entry.email === 'string' ? extractEmail(entry.email) : null;
        if (email) return hashed('grok-email', email);
      }
    }
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'cursor') {
    if (report?.sourceId === 'cursor' && report.id.startsWith('cursor:')) {
      const suffix = report.id.slice('cursor:'.length).replace(/^account-/, '').trim().toLowerCase();
      if (suffix && suffix !== 'default') return `cursor:${suffix.slice(0, 16)}`;
    }
    const auth = readJson(join(userHome, '.cursor', 'auth.json'));
    const jwt = decodeJwtPayload(auth?.accessToken ?? auth?.access_token);
    const sub = typeof jwt?.sub === 'string' ? jwt.sub.trim().toLowerCase() : '';
    if (sub) return hashed('cursor', sub);
    const email = (typeof jwt?.email === 'string' ? extractEmail(jwt.email) : null) ?? extractEmail(label);
    if (email) return hashed('cursor-email', email);
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'qoder') {
    const email = extractEmail(reportDetail(report, 'email')) ?? extractEmail(label);
    if (email) {
      const org = reportDetail(report, 'organization')?.toLowerCase() ?? '';
      return hashed('qoder', org ? `${email}:${org}` : email);
    }
    return `host:${serverId}:${providerId}`;
  }

  if (kind === 'opencode') {
    const email = extractEmail(reportDetail(report, 'email')) ?? extractEmail(label);
    if (email) return hashed('opencode', email);
    return `host:${serverId}:${providerId}`;
  }

  return `host:${serverId}:${providerId}`;
}
