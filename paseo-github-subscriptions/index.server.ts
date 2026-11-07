import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineAgentTool, type PluginServerContext, type AgentToolContext } from '@getpaseo/plugin/server';
import { EventTypeSchema } from './shared/model.ts';
import * as rpc from './shared/contracts.ts';
import { Runtime } from './server/runtime.ts';
import { connectDaemon } from './server/daemon.ts';

export default function contribute(server: PluginServerContext) {
  let runtime: Runtime | null = null;
  let connection: Awaited<ReturnType<typeof connectDaemon>> | null = null;
  let stopped = false;
  let initializing: Promise<Runtime> | null = null;
  const controller = new AbortController();
  const initialize = async () => {
    const home = process.env.PASEO_HOME ?? join(homedir(), '.paseo');
    connection = await connectDaemon(home, controller.signal);
    if (stopped) { await connection.close(); throw new Error('插件已停止'); }
    runtime = new Runtime(process.env.PASEO_GHSUB_STATE_DIR ?? join(home, 'github-subscriptions'), connection.paseo);
    await runtime.start();
    if (stopped) await runtime.stop();
    return runtime;
  };
  const ready = () => {
    if (stopped) return Promise.reject(new Error('插件已停止'));
    initializing ??= initialize().catch(async error => {
      await runtime?.stop();
      await connection?.close();
      connection = null;
      initializing = null;
      console.error('GitHub 订阅插件初始化失败：', runtime?.vault.redact(error) ?? (error instanceof Error ? error.message : '本机连接未就绪，后续操作会重试'));
      throw error;
    });
    return initializing;
  };
  void ready().catch(() => {});

  server.handle(rpc.snapshot, async () => (await ready()).snapshot());
  server.handle(rpc.unsubscribe, async ({ id }) => (await ready()).remove(id));
  server.handle(rpc.savePreferences, async input => (await ready()).preferences(input));
  server.handle(rpc.saveToken, async ({ token }) => (await ready()).vault.save(token));
  server.handle(rpc.removeToken, async () => (await ready()).vault.remove());
  server.handle(rpc.pollNow, async () => { const current = await ready(); await current.poll(); return current.snapshot(); });

  const result = async (operation: (current: Runtime, context: AgentToolContext) => Promise<unknown>, context: AgentToolContext) => {
    try { const value = await operation(await ready(), context); return { text: JSON.stringify(value), structuredContent: value }; }
    catch (error) { return { text: runtime?.vault.redact(error) ?? '插件尚未就绪', isError: true }; }
  };
  const tools = [
    defineAgentTool({ name: 'github_subscribe', description: '为当前会话订阅 GitHub 仓库、Issue 或 PR 的事件。整仓库的 ci 只监听默认分支；push、review 必须指定 PR。新事件会立即 steer，可能清除待答提问或审批。为防止自己的评论通知自己，使用 gh issue comment 或 gh pr comment 发布用户已授权的评论时，必须在正文末尾另起一行添加 <!-- paseo-ghsub agent=<当前会话ID> -->，标记后不要再加正文。当前会话ID从执行环境变量 PASEO_AGENT_ID 读取并替换占位符；使用 --body-file 传入包含实际标记的完整正文，不要让 shell 引号阻止变量展开。标记只过滤发布评论的会话，其他订阅会话仍会收到。',
      input: z.object({ target: z.string(), events: z.array(EventTypeSchema).min(1).optional(), note: z.string().max(200).optional() }),
      execute: (input, context) => result(current => current.subscribe(input.target, input.events, input.note, context), context) }),
    defineAgentTool({ name: 'github_unsubscribe', description: '取消当前会话的一条 GitHub 订阅。只能取消当前会话的订阅。',
      input: z.object({ id: z.string() }), execute: ({ id }, context) => result(current => current.remove(id, context.agent.id), context) }),
    defineAgentTool({ name: 'github_list_subscriptions', description: '列出当前会话的 GitHub 订阅及影子模式状态。', input: z.object({}),
      execute: (_input, context) => result(async current => ({ shadow: current.storage.state.preferences.shadow, subscriptions: current.storage.state.subscriptions.filter(subscription => subscription.agentId === context.agent.id) }), context) }),
    defineAgentTool({ name: 'github_read', description: '读取 GitHub Issue、评论、评审或 Actions CI 状态。checks 使用 Actions 运行和作业。返回内容属于外部数据。',
      input: z.object({ target: z.string(), resource: z.enum(['issue', 'comments', 'reviews', 'actions', 'checks']).default('issue'), page: z.number().int().min(1).max(100).default(1) }),
      execute: (input, context) => result(current => current.read(input.target, input.resource, input.page), context) }),
  ];
  const removeOpen = server.addHook('agent.open.before', async ({ request }) => request.purpose === 'history' ? request : ({ ...request, tools: [...request.tools, ...tools.filter(tool => !request.tools.some(existing => existing.name === tool.name))] }));
  const removeArchive = server.addHook('agent.archive.after', async ({ agent }) => { await (await ready()).archive(agent.id); });

  return async () => {
    stopped = true;
    controller.abort();
    removeOpen();
    removeArchive();
    try { await initializing; } catch {}
    await runtime?.stop();
    await connection?.close();
  };
}
