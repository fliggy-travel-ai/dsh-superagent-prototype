import { MAIN_PLUGIN_ID } from '../shared/instances.ts';

type Client = { invokePluginRpc(id: string, method: string, input: unknown): Promise<unknown> };
type Snapshot = { settings: Record<string, unknown> & { mode: string }; observation: { mode: string; reason: string } };
export const STATUS_EXIT: Record<string, number> = { online: 20, offline: 21, unknown: 22 };
const MODES = new Set(['auto', 'online', 'offline']);

/** 切换问答模式（只改 mode，其余设置保持），或读取当前判定。返回给 shell 的退出码可用 `paseo script ls --json` 远程读回。 */
export async function runPresenceMode(client: Client, action: string): Promise<{ exitCode: number; line: string }> {
  const read = async () => await client.invokePluginRpc(MAIN_PLUGIN_ID, 'presence.snapshot', {}) as Snapshot;
  if (action === 'status') {
    const snap = await read();
    return { exitCode: STATUS_EXIT[snap.observation.mode] ?? 22, line: `设置=${snap.settings.mode} 判定=${snap.observation.mode}（${snap.observation.reason}）` };
  }
  if (!MODES.has(action)) throw Error('参数只能是 auto、online、offline 或 status');
  const before = await read();
  await client.invokePluginRpc(MAIN_PLUGIN_ID, 'presence.configure', { ...before.settings, mode: action });
  const after = await read();
  const ok = after.settings.mode === action;
  return { exitCode: ok ? 0 : 1, line: `${ok ? '已切换' : '切换未生效'}：设置=${after.settings.mode} 判定=${after.observation.mode}（${after.observation.reason}）` };
}
