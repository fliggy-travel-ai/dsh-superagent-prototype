import * as cloud from '../../../shared/cloud-session.ts';
import { cloudBridgeAnswer, cloudBridgeConfirm } from '../../../shared/cloud-bridge.ts';
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
    server.handle(cloudBridgeAnswer, async request => (await main.readyBrowser()).answerWebRequest(request));
    server.handle(cloudBridgeConfirm, async input => { main.webExecutor.confirmCloud(input); return { ok: true as const }; });
  },
};
