import { defineAgentTool } from '@getpaseo/plugin/server';
import { z } from 'zod';
import {
  FleetQuotasInputSchema,
  fleetProviderQuotas,
  localProviderQuotas,
  type FleetQuotasInput,
} from '../../../shared/provider-quota-tool.ts';
import { readJsonStrict } from '../../core/provider-config.ts';
import { summarizeError } from '../../core/modules.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';
import { collectFleetQuotas } from './fleet.ts';
import { collectLocalQuotas } from './local.ts';

const REMOTE_QUOTA_TIMEOUT_MS = 20_000;

function readQuotaGateSettings(machinePath: string): { minRemainingPct: number; excludeProviders: string[] } {
  const raw = readJsonStrict(machinePath)?.quotaGate;
  if (!raw || typeof raw !== 'object') return { minRemainingPct: 10, excludeProviders: [] };
  const record = raw as { minRemainingPct?: unknown; excludeProviders?: unknown };
  const minRemainingPct = typeof record.minRemainingPct === 'number'
    && Number.isFinite(record.minRemainingPct)
    && record.minRemainingPct >= 0
    && record.minRemainingPct <= 100
    ? record.minRemainingPct
    : 10;
  const excludeProviders = Array.isArray(record.excludeProviders)
    ? record.excludeProviders.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  return { minRemainingPct, excludeProviders };
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
      const gate = readQuotaGateSettings(machine.path);
      return collectLocalQuotas({
        client,
        paseoHome: services.home,
        serverId: self.id,
        hostName: self.name,
        excludeProviders: gate.excludeProviders,
        minRemainingPct: gate.minRemainingPct,
        refresh,
      });
    };

    const runFleet = async (input: FleetQuotasInput) => {
      const hosts = await main.readyHosts();
      const gate = readQuotaGateSettings(machine.path);
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
        { ...input, defaultMinRemainingPct: gate.minRemainingPct },
      );
    };

    server.handle(localProviderQuotas, async input => runLocal(input.refresh === true));
    server.handle(fleetProviderQuotas, async input => runFleet(input));

    const tool = defineAgentTool({
      name: 'provider_quotas',
      description: '查询当前 Paseo 守护进程本机及所有已配对在线主机的 Provider 剩余额度、并发会话负载与派发建议。调用无需指定主机；返回结果已按实际底层账号跨主机去重，每条账号记录的 supportedHosts 列出支持该账号的各主机 serverId、该主机上的 providerId、可用性与运行中会话数，可直接用于 create_agent 选型。离线或查询失败的主机会在 hosts 中明确报错。',
      input: z.object({
        kind: FleetQuotasInputSchema.shape.kind.describe('可选，按 Provider 类型过滤，例如 claude、codex、antigravity、glm、grok、cursor、qoder、opencode'),
        minRemainingPct: FleetQuotasInputSchema.shape.minRemainingPct.describe('可选，最低剩余额度阈值百分比（0-100），默认沿用本机 quotaGate.minRemainingPct（通常为 10）'),
        concurrencyTarget: FleetQuotasInputSchema.shape.concurrencyTarget.describe('可选，并发负载高阈值（运行中会话数），默认 3'),
        refresh: FleetQuotasInputSchema.shape.refresh.describe('可选，是否强制刷新额度缓存，默认 false'),
      }),
      execute: async input => {
        try {
          const result = await runFleet(input);
          return { text: JSON.stringify(result), structuredContent: result };
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
