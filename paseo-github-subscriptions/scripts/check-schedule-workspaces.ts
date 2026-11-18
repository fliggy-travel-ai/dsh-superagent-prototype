import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createHostClient } from '@getpaseo/client/node';
import { connectDaemon } from '../server/daemon.ts';
import { ModulesSnapshotSchema } from '../shared/modules.ts';

type Client = Pick<DaemonClient, 'invokePluginRpc' | 'fetchWorkspaces'>;
class ScheduleWorkspaceCheckError extends Error {
  readonly pending: boolean;
  constructor(message: string, pending = false) { super(message); this.pending = pending; }
}

export async function checkScheduleWorkspaces(client: Client, workspaceId?: string) {
  const snapshot = ModulesSnapshotSchema.parse(await client.invokePluginRpc('github-subscriptions', 'modules.status', {}));
  const module = snapshot.modules.find(entry => entry.id === 'schedules.workspaces');
  if (!module) throw new ScheduleWorkspaceCheckError('缺少定时任务工作区模块，请检查这台机器的部署文件和模块注册');
  if (module.state !== 'running') throw new ScheduleWorkspaceCheckError(`定时任务工作区模块未运行：${module.state}`);
  if (!workspaceId) return { module: module.state };
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ includeBackground: true, page: { limit: 100, cursor } });
    const workspace = page.entries.find(entry => entry.id === workspaceId);
    if (workspace) {
      if (!workspace.pinnedAt) throw new ScheduleWorkspaceCheckError('指定的定时任务工作区尚未置顶', true);
      const title = workspace.title ?? workspace.name;
      if (!title?.startsWith('【每日】')) throw new ScheduleWorkspaceCheckError('指定的定时任务工作区尚未同步每日任务标题', true);
      return { module: module.state, workspaceId, title, pinnedAt: workspace.pinnedAt };
    }
    if (!page.pageInfo.hasMore) break;
    if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw new ScheduleWorkspaceCheckError('工作区列表不完整');
    cursor = page.pageInfo.nextCursor;
  } while (cursor);
  throw new ScheduleWorkspaceCheckError('这台机器没有指定的活动工作区');
}

export async function checkScheduleHost(host: string | null, workspaceId?: string) {
  let remote: ReturnType<typeof createHostClient> | undefined;
  let connection: Awaited<ReturnType<typeof connectDaemon>> | undefined;
  try {
    try {
      if (host) {
        remote = createHostClient(host, { clientId: 'schedule-workspaces-check', clientType: 'cli', reconnect: { enabled: false } });
        await remote.connect();
      }
      else connection = await connectDaemon(process.env.PASEO_HOME ?? join(homedir(), '.paseo'));
    } catch { throw new ScheduleWorkspaceCheckError('无法连接目标守护进程，请检查现有连接配置'); }
    const deadline = Date.now() + 30_000;
    while (true) {
      try { return await checkScheduleWorkspaces(remote ?? connection!.client, workspaceId); }
      catch (error) {
        if (!(error instanceof ScheduleWorkspaceCheckError) || !error.pending || Date.now() >= deadline) throw error;
        await delay(1000);
      }
    }
  } catch (error) {
    if (error instanceof ScheduleWorkspaceCheckError) throw error;
    throw new ScheduleWorkspaceCheckError('无法读取模块或工作区状态，请检查插件日志');
  } finally {
    await remote?.close().catch(() => {});
    await connection?.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const both = args.includes('--both');
  const macbook = args.includes('--macbook');
  let workspaceId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--workspace') {
      workspaceId = args[++index];
      if (!workspaceId || workspaceId.startsWith('--')) throw new ScheduleWorkspaceCheckError('--workspace 缺少工作区编号');
    } else if (!['--both', '--macbook'].includes(arg!)) throw new ScheduleWorkspaceCheckError('存在未知参数，请使用 --both、--macbook 或 --workspace');
  }
  if (both && (macbook || workspaceId)) throw new ScheduleWorkspaceCheckError('--both 单独检查两台机器的模块；工作区验收请单独指定机器');
  const host = process.env.MACBOOK_PASEO_HOST;
  if ((both || macbook) && !host) throw new ScheduleWorkspaceCheckError('尚未配置 MacBook 连接');
  const targets = both ? [['本机', null], ['MacBook', host!]] as const : [[macbook ? 'MacBook' : '本机', macbook ? host! : null]] as const;
  for (const [machine, target] of targets) {
    try { console.log(JSON.stringify({ machine, ...await checkScheduleHost(target, workspaceId) })); }
    catch (error) {
      console.error(`${machine}：${error instanceof Error ? error.message : '定时任务工作区验收失败'}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(error => { console.error(error instanceof ScheduleWorkspaceCheckError ? error.message : '定时任务工作区检查失败，请检查参数与连接配置'); process.exitCode = 1; });
}
