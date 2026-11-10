import { readFile } from 'node:fs/promises';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { MAIN_PLUGIN_ID } from '../../../shared/instances.ts';
import { finalize, issueOf } from '../dispatch-finalize/finalize.ts';
import { finalizePort } from '../dispatch-finalize/index.ts';
import type { MigrationAgent, MigrationPort } from './migrate.ts';

const quota = /(?:limit|quota|payment|billing|额度|限额|付款|支付)/i;
export function daemonMigrationPort(client: DaemonClient, templatePath: string | undefined, audit: MigrationPort['audit'], notify: MigrationPort['notify'], signal: AbortSignal): MigrationPort {
  const delay = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(Error('stopped'));
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(Error('stopped')); }; signal.addEventListener('abort', stop, { once: true });
  });
  const timeline = async (id: string) => (await client.fetchAgentTimeline(id, { direction: 'tail', limit: 100 })).entries.map(e => e.item);
  const read = async (id: string) => (await client.fetchAgent(id))?.agent ?? null;
  return {
    read, update: (id, labels) => client.updateAgent(id, { labels }), delay, audit, notify,
    autoResume: async id => {
      const value = await client.invokePluginRpc(MAIN_PLUGIN_ID, 'claude-accounts.retry-status', { agentId: id, text: '' }) as { enabled?: boolean };
      if (typeof value?.enabled !== 'boolean') throw Error('resume_unavailable'); return value.enabled;
    },
    setAutoResume: async (id, enabled) => { const result = await client.invokePluginRpc(MAIN_PLUGIN_ID, 'claude-accounts.set-auto-resume', { agentId: id, enabled }) as { enabled?: boolean }; if (result?.enabled !== enabled) throw Error('resume_unavailable'); },
    stop: async (agent, reason) => {
      if (reason === 'five_hour') { await client.cancelAgent(agent.id); return true; }
      const before = new Set((await timeline(agent.id)).filter(i => i.type === 'assistant_message').map(i => JSON.stringify(i)));
      await client.sendAgentMessage(agent.id, '请在安全位置停止当前工作，保存进度，并回复“已停止，可以迁移”。请不要继续执行任务。', { activeTurnBehavior: 'steer' });
      for (let elapsed = 0; elapsed < 600_000; elapsed += 5000) {
        await delay(5000);
        const items = await timeline(agent.id);
        const current = await read(agent.id);
        if (current && !current.activeTurn && items.some(i => i.type === 'assistant_message' && !before.has(JSON.stringify(i)) && /已停止[，,\s]*可以迁移/.test(i.text))) return true;
      }
      return false;
    },
    create: async (agent, provider) => {
      const current = await read(agent.id); if (!current || !agent.workspaceId || !agent.model) throw Error('source_unavailable');
      const items = await timeline(agent.id);
      const lastUser = [...items].reverse().find(i => i.type === 'user_message');
      const template = templatePath ? await readFile(templatePath, 'utf8') : '请接续原会话的工作。先读需求单及全部评论，再运行 paseo logs 查看原会话最近 150 条记录，核对工作区现状后继续。遵守现行常设授权。';
      const prompt = `${template}\n\n需求单号：${issueOf(agent)}\n工作区：${agent.workspaceId}\n原会话：${agent.id}\n原会话最后一条用户消息：\n${lastUser?.type === 'user_message' ? lastUser.text : '无'}\n原会话待答请求：\n${JSON.stringify(current.pendingPermissions)}\n`;
      const issueKey = agent.labels.need ? 'need' : 'issue';
      const created = await client.createAgent({ cwd: agent.cwd, workspaceId: agent.workspaceId, provider, model: agent.model, modeId: 'bypassPermissions', title: agent.title ?? undefined, labels: { [issueKey]: agent.labels[issueKey]!, role: 'main' }, initialPrompt: prompt });
      return created.id;
    },
    finalize: async id => (await finalize(finalizePort(client), id)).ok,
    verify: async id => {
      await delay(20_000);
      for (let i = 0; i <= 4; i++) {
        const items = await timeline(id);
        for (const item of items) {
          const text = item.type === 'assistant_message' ? item.text : item.type === 'error' || item.type === 'notification' ? item.message : '';
          if (text && quota.test(text)) return 'quota';
          if (item.type === 'assistant_message' && text.trim()) return 'ok';
        }
        if (i < 4) await delay(5000);
      }
      return 'unknown';
    },
    children: async id => {
      const result: string[] = []; let cursor: string | undefined;
      do {
        const page = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
        for (const { agent } of page.entries) if (agent.labels['paseo.parent-agent-id'] === id) result.push(agent.id);
        if (!page.pageInfo.hasMore) break;
        if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('list_incomplete'); cursor = page.pageInfo.nextCursor;
      } while (true);
      return result;
    },
    serverId: () => { const id = client.getLastServerInfoMessage()?.serverId; if (!id) throw Error('server_unavailable'); return id; },
    archive: async id => { await client.archiveAgent(id); },
  };
}
