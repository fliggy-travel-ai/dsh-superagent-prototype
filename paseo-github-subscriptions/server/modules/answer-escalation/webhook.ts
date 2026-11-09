import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Notice } from '../../notify/engine.ts';

const exec = promisify(execFile);

/**
 * Grok webhook。地址和鉴权头只从环境变量或 macOS Keychain 读取，服务名写在 machine.json 的
 * `escalation.webhook` 中，仓库里没有地址、凭据和服务名。
 */
export const WebhookConfigSchema = z.strictObject({
  /** 环境变量名：地址。设置后必须同时有鉴权头。 */
  urlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  authEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  /** Keychain 服务名：地址和完整鉴权头（`头名: 值`）。 */
  urlService: z.string().min(1).optional(),
  authService: z.string().min(1).optional(),
  account: z.string().min(1).default('dsh'),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export interface WebhookCredentials { url: string; auth: string }

export function webhookPayload(notice: Notice): Record<string, unknown> {
  const { target, requestId, key, ...event } = notice;
  return {
    schemaVersion: 1,
    source: 'paseo-event-notifications',
    ...event,
    agentId: notice.agentId || null,
    paseo_agent_id: notice.agentId || null,
    correlationKey: key,
    ...(notice.events ? { events: notice.events.map(webhookPayload) } : {}),
  };
}

export type KeychainReader = (service: string, account: string) => Promise<string>;
const readKeychain: KeychainReader = async (service, account) =>
  (await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 5000 })).stdout.trim();

export async function webhookCredentials(
  config: WebhookConfig | undefined,
  env: Record<string, string | undefined> = process.env,
  keychain: KeychainReader = readKeychain,
  platform: string = process.platform,
): Promise<WebhookCredentials> {
  const url = config?.urlEnv && env[config.urlEnv];
  const auth = config?.authEnv && env[config.authEnv];
  if (url) {
    if (!auth) throw Error('未设置现有鉴权头');
    return { url, auth };
  }
  if (!config?.urlService || !config.authService) throw Error('没有配置 webhook：在 machine.json 的 escalation.webhook 中写环境变量名或 Keychain 服务名');
  if (platform !== 'darwin') throw Error('没有配置现有 webhook');
  return { url: await keychain(config.urlService, config.account), auth: await keychain(config.authService, config.account) };
}

export function credentialFingerprint(credentials: WebhookCredentials): { hostname: string; fingerprint: string } {
  return { hostname: new URL(credentials.url).hostname, fingerprint: fingerprintOf(credentials) };
}
import { createHash } from 'node:crypto';
const fingerprintOf = (credentials: WebhookCredentials) => createHash('sha256').update(credentials.url + '\0' + credentials.auth).digest('hex').slice(0, 8);

export async function postNotice(notice: Notice, credentials: WebhookCredentials, signal: AbortSignal) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': notice.id };
  if (credentials.auth) {
    const split = credentials.auth.indexOf(':');
    if (split < 1) throw Error('现有鉴权头格式无效');
    headers[credentials.auth.slice(0, split)] = credentials.auth.slice(split + 1).trim();
  }
  const result = await fetch(credentials.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(webhookPayload(notice)),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!result.ok) throw Object.assign(new Error(`Webhook HTTP ${result.status}`), { httpStatus: result.status });
  return { httpStatus: result.status };
}

export type SecurityRunner = (args: string[], input: string) => Promise<void>;

/** 凭据经标准输入交给 `security -i`，不出现在命令行参数里（进程列表和错误信息都看不到）。 */
const runSecurity: SecurityRunner = (args, input) => new Promise<void>((resolve, reject) => {
  const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill(), 5000);
  child.once('error', () => { clearTimeout(timer); reject(new Error('Keychain 写入失败')); });
  child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Keychain 写入失败')); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

const quote = (value: string, what: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error(`${what}含有换行或空字符`);
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
};

/** 失败时只抛通用提示，不带地址、鉴权头或底层错误原文。 */
export async function storeWebhookCredentials(config: WebhookConfig | undefined, credentials: WebhookCredentials, run: SecurityRunner = runSecurity) {
  if (!config?.urlService || !config.authService) throw Error('没有配置 Keychain 服务名，不能保存 webhook');
  let protocol = '';
  try { protocol = new URL(credentials.url).protocol; } catch { throw new Error('Webhook 地址格式无效'); }
  if (protocol !== 'https:') throw new Error('Webhook 地址需要 HTTPS');
  if (!/^[A-Za-z][A-Za-z0-9-]*:\s*\S.*$/.test(credentials.auth)) throw new Error('鉴权头需要“头名: 值”格式');
  const input = [[config.urlService, credentials.url, '地址'], [config.authService, credentials.auth, '鉴权头']]
    .map(([service, value, what]) => `add-generic-password -U -s ${quote(service!, '服务名')} -a ${quote(config.account, '账号')} -w ${quote(value!, what!)}\n`).join('');
  try { await run(['-i'], input); } catch { throw new Error('保存 webhook 凭据失败（Keychain 写入没有成功）'); }
}
