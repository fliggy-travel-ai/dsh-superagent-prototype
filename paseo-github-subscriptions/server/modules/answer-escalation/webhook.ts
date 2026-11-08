import { execFile } from 'node:child_process';
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

export async function storeWebhookCredentials(config: WebhookConfig | undefined, credentials: WebhookCredentials, run: (file: string, args: string[]) => Promise<unknown> = (file, args) => exec(file, args, { timeout: 5000 })) {
  if (!config?.urlService || !config.authService) throw Error('没有配置 Keychain 服务名，不能保存 webhook');
  if (new URL(credentials.url).protocol !== 'https:' || !/^[A-Za-z][A-Za-z0-9-]*:\s*\S.*$/.test(credentials.auth)) throw Error('Webhook 配置需要 HTTPS 地址和“头名: 值”格式的鉴权头');
  for (const [service, value] of [[config.urlService, credentials.url], [config.authService, credentials.auth]] as const)
    await run('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', config.account, '-w', value]);
}
