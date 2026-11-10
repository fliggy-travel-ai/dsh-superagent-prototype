import { readFile } from 'node:fs/promises';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { MAIN_PLUGIN_ID } from '../../../shared/instances.ts';
import { issueOf } from '../dispatch-finalize/finalize.ts';
import type { MigrationAgent, MigrationPort } from './migrate.ts';

const quota = /(?:usage.?limit|quota (?:reached|exceeded)|hit your.{0,30}limit|payment required|billing (?:issue|error)|达到限额|需要付款)/i;
const providerPrefix = /^(?:you(?:'|’)ve hit your|usage_limit_reached|payment required|billing (?:issue|error)|\/upgrade\s+to\s+increase\s+your\s+usage\s+limit|credit balance is too low)/i;
const shortLimit = /(?:hit your.{0,30}limit|(?:session|5.hour|usage) (?:limit|quota) (?:reached|exceeded)|usage_limit_reached|\/upgrade\s+to\s+increase\s+your\s+usage\s+limit|credit balance is too low|payment required|billing (?:issue|error)|需要(?:付款|支付)|请(?:先)?(?:付款|支付)|(?:需要|请(?:先)?)升级(?:套餐|订阅|账户|账号|计划))/i;
export function classifyOutput(items: Array<{ type: string; text?: string; message?: string }>): 'ok' | 'quota' | 'unknown' {
  for (const item of items) {
    if ((item.type === 'error' || item.type === 'notification') && (quota.test(item.message ?? '') || shortLimit.test(item.message ?? ''))) return 'quota';
    if (item.type === 'assistant_message' && item.text?.trim()) {
      const text = item.text.trim();
      if ((text.length <= 240 || providerPrefix.test(text)) && shortLimit.test(text)) return 'quota';
      return 'ok';
    }
  }
  return 'unknown';
}
export function daemonMigrationPort(client: DaemonClient, templatePath: string | undefined, audit: MigrationPort['audit'], notify: MigrationPort['notify'], signal: AbortSignal, journal: MigrationPort['journal']): MigrationPort {
  const delay = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(Error('stopped'));
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(Error('stopped')); }; signal.addEventListener('abort', stop, { once: true });
  });
  const timeline = async (id: string) => (await client.fetchAgentTimeline(id, { direction: 'tail', limit: 100 })).entries.map(e => e.item);
  const handoffs = new Map<string, { lastUser: string; pending: unknown }>();
  const read = async (id: string) => (await client.fetchAgent(id))?.agent ?? null;
  return {
    read, journal, continueWork: async id => { await client.sendAgentMessage(id, '迁移已取消，请继续原工作。', { activeTurnBehavior: 'steer' }); }, update: (id, labels) => client.updateAgent(id, { labels }), delay, audit, notify,
    autoResume: async id => {
      const value = await client.invokePluginRpc(MAIN_PLUGIN_ID, 'claude-accounts.retry-status', { agentId: id, text: '' }) as { enabled?: boolean };
      if (typeof value?.enabled !== 'boolean') throw Error('resume_unavailable'); return value.enabled;
    },
    setAutoResume: async (id, enabled) => { const result = await client.invokePluginRpc(MAIN_PLUGIN_ID, 'claude-accounts.set-auto-resume', { agentId: id, enabled }) as { enabled?: boolean }; if (result?.enabled !== enabled) throw Error('resume_unavailable'); },
    stop: async (agent, reason, markWeeklyStop) => {
      const original = await read(agent.id); if (!original) throw Error('source_unavailable');
      const messages = await timeline(agent.id);
      const last = [...messages].reverse().find(i => i.type === 'user_message');
      handoffs.set(agent.id, { lastUser: last?.type === 'user_message' ? last.text : '无', pending: original.pendingPermissions });
      if (reason === 'five_hour') { await client.cancelAgent(agent.id); return true; }
      const before = new Set((await timeline(agent.id)).filter(i => i.type === 'assistant_message').map(i => JSON.stringify(i)));
      markWeeklyStop();
      await client.sendAgentMessage(agent.id, '请在安全位置停止当前工作，保存进度，并回复“已停止，可以迁移”。请不要继续执行任务。', { activeTurnBehavior: 'steer' });
      for (let elapsed = 0; elapsed < 600_000; elapsed += 5000) {
        await delay(5000);
        const items = await timeline(agent.id);
        const current = await read(agent.id);
        if (current && !current.activeTurn && items.some(i => i.type === 'assistant_message' && !before.has(JSON.stringify(i)) && /已停止[，,\s]*可以迁移/.test(i.text))) return true;
      }
      return false;
    },
    create: async (agent, provider, markRequest) => {
      const current = await read(agent.id); if (!current || !agent.workspaceId || !agent.model) throw Error('source_unavailable');
      const handoff = handoffs.get(agent.id); if (!handoff) throw Error('source_unavailable');
      const template = templatePath ? await readFile(templatePath, 'utf8') : '请接续原会话的工作。先读需求单及全部评论，再运行 paseo logs 查看原会话最近 150 条记录，核对工作区现状后继续。遵守现行常设授权。';
      const prompt = `${template}\n\n需求单号：${issueOf(agent)}\n工作区：${agent.workspaceId}\n原会话：${agent.id}\n原会话最后一条用户消息：\n${handoff.lastUser}\n原会话待答请求：\n${JSON.stringify(handoff.pending)}\n`;
      const issueKey = agent.labels.need ? 'need' : 'issue';
      markRequest();
      const created = await client.createAgent({ cwd: agent.cwd, workspaceId: agent.workspaceId, provider, model: agent.model, modeId: current.currentModeId || 'bypassPermissions', title: agent.title ?? undefined, labels: { [issueKey]: agent.labels[issueKey]!, role: 'main' }, initialPrompt: prompt });
      return created.id;
    },
    finalize: async id => { const result = await client.invokePluginRpc(MAIN_PLUGIN_ID, 'dispatch.finalize', { agentId: id }) as { ok?: boolean }; return result?.ok === true; },
    verify: async id => {
      await delay(20_000);
      for (let i = 0; i <= 4; i++) {
        const items = await timeline(id);
        const result = classifyOutput(items);
        if (result !== 'unknown') return result;
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
