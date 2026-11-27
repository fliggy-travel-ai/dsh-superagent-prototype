import { defineAgentTool } from '@getpaseo/plugin/server';
import { z } from 'zod';
import {
  FleetQuotasInputSchema,
  fleetProviderQuotas,
  formatFleetQuotasMarkdown,
  localProviderQuotas,
  type FleetQuotasInput,
} from '../../../shared/provider-quota-tool.ts';
import { readJsonStrict } from '../../core/provider-config.ts';
import { summarizeError } from '../../core/modules.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';
import { collectFleetQuotas } from './fleet.ts';
import { collectLocalQuotas } from './local.ts';

const REMOTE_QUOTA_TIMEOUT_MS = 20_000;

function readQuotaGateExclusions(machinePath: string): string[] {
  const raw = readJsonStrict(machinePath)?.quotaGate;
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as { excludeProviders?: unknown };
  return Array.isArray(record.excludeProviders)
    ? record.excludeProviders.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

/** Provider 额度查询工具：提供跨主机按账号去重的额度 RPC 与会话 MCP 工具 `provider_quotas`。 */
export const quotaToolModule: Module = {
  id: 'providers.quotaTool',
  label: 'Provider 额度查询工具',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server, services, machine } = context;
    const main = mainOf(context);

    const runLocal = async (refresh: boolean, selfOverride?: { id: string; name: string }) => {
      const { client } = await services.daemon.ready();
      const hosts = await main.readyHosts();
      const self = selfOverride ?? await hosts.selfHost();
      return collectLocalQuotas({
        client,
        paseoHome: services.home,
        serverId: self.id,
        hostName: self.name,
        excludeProviders: readQuotaGateExclusions(machine.path),
        refresh,
      });
    };

    const runFleet = async (input: FleetQuotasInput) => {
      const hosts = await main.readyHosts();
      return collectFleetQuotas(
        {
          hosts: () => hosts.hosts(),
          selfId: () => hosts.selfId(),
          local: (self, refresh) => runLocal(refresh, self),
          remote: (host, refresh) => hosts.invokePlugin(
            host.id,
            localProviderQuotas.name,
            { refresh },
            REMOTE_QUOTA_TIMEOUT_MS,
          ),
        },
        input,
      );
    };

    server.handle(localProviderQuotas, async input => runLocal(input.refresh === true));
    server.handle(fleetProviderQuotas, async input => runFleet(input));

    const tool = defineAgentTool({
      name: 'provider_quotas',
      description: '查询当前 Paseo 守护进程本机及所有已配对在线主机的 Provider 剩余额度、并发会话负载与派发建议。调用无需指定主机；返回高压缩 Markdown 表格（顶部列出主机别名 H1/H2→serverId 与状态，下表为按实际底层账号跨主机去重并按推荐度排序的账号），默认隐藏不可用/共享窗口低于 1% 的账号与不可用主机（传 includeUnavailable=true 可查看全部），可直接用于 create_agent 选型。离线或查询失败的主机在顶部主机行明确报错。',
      input: z.object({
        kind: FleetQuotasInputSchema.shape.kind.describe('可选，按 Provider 类型过滤，例如 claude、codex、antigravity、glm、grok、cursor、qoder、opencode'),
        concurrencyTarget: FleetQuotasInputSchema.shape.concurrencyTarget.describe('可选，并发负载高阈值（运行中会话数），默认 3'),
        refresh: FleetQuotasInputSchema.shape.refresh.describe('可选，是否强制刷新额度缓存，默认 false'),
        includeUnavailable: FleetQuotasInputSchema.shape.includeUnavailable.describe('可选，是否展示不可用/已耗尽账号与不可用主机，默认 false（隐藏不可用项）'),
      }),
      execute: async input => {
        try {
          const result = await runFleet(input);
          return { text: formatFleetQuotasMarkdown(result, { includeUnavailable: input.includeUnavailable === true }) };
        } catch (error) {
          return { text: `查询 Provider 额度失败：${summarizeError(error)}`, isError: true };
        }
      },
    });

    const removeOpen = server.addHook('agent.open.before', async ({ request }) =>
      request.purpose === 'history'
        ? request
        : ({
          ...request,
          tools: request.tools.some(existing => existing.name === tool.name)
            ? request.tools
            : [...request.tools, tool],
        }));

    return () => {
      removeOpen();
    };
  },
};
