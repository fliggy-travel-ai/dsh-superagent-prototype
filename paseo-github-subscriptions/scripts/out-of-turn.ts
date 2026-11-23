/**
 * 只读：判断一个会话是否在本轮外续跑（Antigravity 后台命令结束后自己继续工作）。
 *
 * 用法：node --experimental-strip-types scripts/out-of-turn.ts <会话 ID> [--server <serverId>] [--quiet-seconds 60]
 * 输出一行 JSON，verdict 取值：
 *   in-turn             会话在 Paseo 回合中（status=running）
 *   out-of-turn-active  空闲，但本轮外有运行中的工具，或最后一条本轮外条目在静默时间内：不要发续接
 *   out-of-turn-done    空闲，本轮外续跑已静默：读 lastAssistant 判断下一步，不要再要求它“继续”
 *   idle                空闲，最后一轮之后没有本轮外活动
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { connectDaemon } from '../server/daemon.ts';
import { connectRegisteredHost } from '../server/notify/peer.ts';
import { isAntigravityProvider, outOfTurnState, summarize, type TimelineEntryLike } from '../shared/out-of-turn.ts';

function parseArgs(argv: string[]) {
  const [agentId, ...rest] = argv;
  if (!agentId || agentId.startsWith('--')) throw new Error('缺少会话 ID');
  let serverId: string | null = null;
  let quietSeconds = 60;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = rest[++index];
    if (flag === '--server' && value) serverId = value;
    else if (flag === '--quiet-seconds' && value && Number.isFinite(Number(value))) quietSeconds = Number(value);
    else throw new Error(`无法识别的参数：${flag}`);
  }
  return { agentId, serverId, quietSeconds };
}

export function verdictOf(status: string | undefined, state: ReturnType<typeof outOfTurnState>, now: number, quietSeconds: number) {
  if (status === 'running') return 'in-turn';
  if (state.count === 0) return 'idle';
  const last = state.lastAt ? Date.parse(state.lastAt) : 0;
  return state.running > 0 || now - last < quietSeconds * 1000 ? 'out-of-turn-active' : 'out-of-turn-done';
}

async function main() {
  const { agentId, serverId, quietSeconds } = parseArgs(process.argv.slice(2));
  const daemon = await connectDaemon(process.env.PASEO_HOME ?? join(homedir(), '.paseo'));
  const peer = serverId ? await connectRegisteredHost(daemon.client, serverId) : undefined;
  try {
    const paseo = peer ? createPaseoApi(peer) : daemon.paseo;
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 200 }) as unknown as {
      agent?: { status?: string; provider?: string };
      entries: TimelineEntryLike[];
    };
    const state = outOfTurnState(page.entries);
    const status = page.agent?.status;
    console.log(JSON.stringify({
      agentId, serverId, status, provider: page.agent?.provider ?? null,
      antigravity: isAntigravityProvider(page.agent?.provider),
      verdict: verdictOf(status, state, Date.now(), quietSeconds),
      outOfTurnCount: state.count, lastAt: state.lastAt, runningTools: state.running,
      lastAssistant: summarize(state.lastAssistant, 400),
    }));
  } finally {
    await peer?.close();
    await daemon.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(`读取失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
