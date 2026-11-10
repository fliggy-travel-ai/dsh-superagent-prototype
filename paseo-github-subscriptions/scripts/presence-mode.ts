/** 本机切换问答模式：node … scripts/presence-mode.ts auto|online|offline|status */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDaemon } from '../server/daemon.ts';
import { runPresenceMode } from './presence-mode-lib.ts';

async function main() {
  const action = process.argv[2] ?? '';
  const daemon = await connectDaemon(process.env.PASEO_HOME ?? join(homedir(), '.paseo'));
  try {
    const { exitCode, line } = await runPresenceMode(daemon.client, action);
    console.log(line); process.exitCode = exitCode;
  } finally { await daemon.close(); }
}
main().catch(error => { console.error(`问答模式切换失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
