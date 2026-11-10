import { MAIN_PLUGIN_ID } from '../shared/instances.ts';

const permitted = new Set([
  'capacity.snapshot', 'capacity.clear-review', 'dispatch.finalize',
  'machine.settings.snapshot', 'escalation.snapshot', 'presence.snapshot', 'provider-quotas.snapshot',
  'browser.snapshot', 'browser.usage.snapshot', 'antigravity.snapshot', 'claude-accounts.snapshot',
  'subscriptions.snapshot', 'quiet.snapshot', 'defaults.snapshot',
]);
export function parseRpcArgs(args: string[]) {
  if (args.length !== 2 || !permitted.has(args[0]!)) throw Error('只允许指定的 RPC 或只读 snapshot');
  let input: unknown;
  try { input = JSON.parse(args[1]!); } catch { throw Error('输入不是有效 JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('输入必须是 JSON 对象');
  return { method: args[0]!, input };
}
const sensitive = /(?:host|machine|server.?id|address|secret|token|credential|password|authorization|auth|api.?key|access.?key|private.?key|(?:^|[_-])key$|url)/i;
export function safeOutput(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[已隐藏地址]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[已隐藏地址]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '[已隐藏地址]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_)[a-z0-9_-]{8,}/gi, '[已隐藏密钥]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]');
  if (Array.isArray(value)) return value.map(safeOutput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.test(key)).map(([key, item]) => [key, safeOutput(item)]));
  return value;
}
export async function invokeRpc(client: { invokePluginRpc(id: string, method: string, input: unknown): Promise<unknown> }, method: string, input: unknown) {
  return safeOutput(await client.invokePluginRpc(MAIN_PLUGIN_ID, method, input));
}
