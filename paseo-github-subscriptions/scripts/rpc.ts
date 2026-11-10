/** 本机插件 RPC：只允许明确的操作和只读快照。 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDaemon } from '../server/daemon.ts';
import { invokeRpc, parseRpcArgs } from './rpc-lib.ts';

async function main() {
  const { method, input } = parseRpcArgs(process.argv.slice(2));
  const daemon = await connectDaemon(process.env.PASEO_HOME ?? join(homedir(), '.paseo'));
  try { console.log(JSON.stringify(await invokeRpc(daemon.client, method, input))); }
  finally { await daemon.close(); }
}
main().catch(() => { console.error('本机 RPC 调用失败，请检查方法、输入和守护进程状态。'); process.exitCode = 1; });
