import * as cloud from '../../../shared/cloud-session.ts';
import { cloudBridgeAnswer, cloudBridgeConfirm } from '../../../shared/cloud-bridge.ts';
import { cloudSessionStatus, providersInstanceStatus, CloudSessionStatusSchema } from '../../../shared/provider-instance.ts';
import { ModulesSnapshotSchema } from '../../../shared/modules.ts';
import { PROVIDER_PLUGIN_ID } from '../../../shared/instances.ts';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { mainOf, type Module } from '../types.ts';

/**
 * 主实例中的云端会话入口（Provider 单独一个实例时）。
 *
 * 云端程序写死调用 `github-subscriptions`（paseo-cloud-session/cloud/src/main.js），所以主实例保留云端会话的 RPC，
 * 原样转给 Provider 实例；同时为 Provider 实例提供网页提问的回答和确认。
 * 主实例重载期间云端调用会失败，云端程序按原有逻辑重试。
 */
export const cloudGatewayModule: Module = {
  id: 'providers.cloudGateway',
  label: '云端会话转发',
  defaultEnabled: true,
  appliesTo: instance => instance.role === 'main' && !instance.legacy,
  register(context) {
    const { server, services } = context;
    const main = mainOf(context);
    const forward = <Contract extends Parameters<PluginServerContext['handle']>[0]>(contract: Contract) => {
      server.handle(contract, (async (input: unknown) => (await services.daemon.ready()).client.invokePluginRpc(PROVIDER_PLUGIN_ID, contract.name, input)) as never);
    };
    for (const contract of [cloud.ensureSession, cloud.pushTimeline, cloud.pollInbox, cloud.ackInbox, cloud.forwardMcp, cloud.notifyPendingRequest, cloud.resolvePendingRequest]) forward(contract);
    server.handle(cloudSessionStatus, async () => {
      try {
        const res = await (await services.daemon.ready()).client.invokePluginRpc(PROVIDER_PLUGIN_ID, cloudSessionStatus.name, {});
        return CloudSessionStatusSchema.parse(res);
      } catch {
        return { enabled: false, onlineSessions: 0, unackedMessages: 0 };
      }
    });
    server.handle(providersInstanceStatus, async () => {
      try {
        const { client } = await services.daemon.ready();
        const [modRaw, cloudRaw] = await Promise.all([
          client.invokePluginRpc(PROVIDER_PLUGIN_ID, 'modules.status', {}),
          client.invokePluginRpc(PROVIDER_PLUGIN_ID, cloudSessionStatus.name, {}).catch(() => null),
        ]);
        const modSnap = ModulesSnapshotSchema.parse(modRaw);
        const cloudStat = cloudRaw ? CloudSessionStatusSchema.parse(cloudRaw) : { enabled: false, onlineSessions: 0, unackedMessages: 0 };
        const hasError = modSnap.modules.some(m => m.state === 'error');
        const firstError = modSnap.modules.find(m => m.state === 'error')?.reason ?? null;
        return {
          instanceState: hasError ? ('error' as const) : ('running' as const),
          instanceError: firstError,
          runningSessionsCount: cloudStat.onlineSessions,
          providers: modSnap.modules.map(m => ({
            id: m.id,
            label: m.label,
            available: m.state === 'running',
            runningSessions: m.id === 'providers.cloudSession' ? cloudStat.onlineSessions : 0,
          })),
          cloudSession: cloudStat,
        };
      } catch {
        return {
          instanceState: 'stopped' as const,
          instanceError: '已停止或启动失败，请在 设置 → 插件 查看日志',
          runningSessionsCount: 0,
          providers: [],
          cloudSession: { enabled: false, onlineSessions: 0, unackedMessages: 0 },
        };
      }
    });
    server.handle(cloudBridgeAnswer, async request => (await main.readyBrowser()).answerWebRequest(request));
    server.handle(cloudBridgeConfirm, async input => { main.webExecutor.confirmCloud(input); return { ok: true as const }; });
  },
};
