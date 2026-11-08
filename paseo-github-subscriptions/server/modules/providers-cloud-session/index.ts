import { registerCloudSession, createCloudSession, redactError } from '../../cloud-session/index.ts';
import type { AnswerWebRequest, ResolveWebRequest } from '../../../shared/web-request.ts';
import { cloudBridgeAnswer, cloudBridgeConfirm } from '../../../shared/cloud-bridge.ts';
import { providersInstanceStatus } from '../../../shared/provider-instance.ts';
import { MAIN_PLUGIN_ID } from '../../../shared/instances.ts';
import type { Module } from '../types.ts';

/**
 * 云端会话 Provider（`cloud-session`）。
 *
 * - Provider 实例：网页提问的回答和确认转给主实例的浏览器桥接。
 * - 兼容模式（没有角色文件）：和整合前一样在主实例中运行，直接调用本实例的浏览器桥接。
 */
export const cloudSessionModule: Module = {
  id: 'providers.cloudSession',
  label: '云端会话',
  defaultEnabled: true,
  appliesTo: instance => instance.hostsProviders,
  redact: error => redactError(error).replace(/[\r\n]+/g, ' '),
  register(context) {
    const { services } = context;
    let answerWebRequest: AnswerWebRequest;
    let resolveWebRequest: ResolveWebRequest;
    if (services.main) {
      const main = services.main;
      answerWebRequest = async request => (await main.readyBrowser()).answerWebRequest(request);
      resolveWebRequest = input => main.webExecutor.confirmCloud(input);
    } else {
      const invoke = async (name: string, input: unknown) => (await services.daemon.ready()).client.invokePluginRpc(MAIN_PLUGIN_ID, name, input);
      answerWebRequest = async request => cloudBridgeAnswer.output.parse(await invoke(cloudBridgeAnswer.name, request));
      resolveWebRequest = input => { void invoke(cloudBridgeConfirm.name, input).catch(error => console.error('云端会话确认网页请求失败：', redactError(error))); };
    }
    const instance = createCloudSession(undefined, answerWebRequest, resolveWebRequest);
    if (context.instance.legacy) {
      context.server.handle(providersInstanceStatus, async () => {
        const cloudStatus = instance.status();
        return {
          instanceState: 'legacy' as const,
          instanceError: null,
          runningSessionsCount: cloudStatus.onlineSessions,
          providers: [{ id: 'cloud-session', label: '云端会话', available: true, runningSessions: cloudStatus.onlineSessions }],
          cloudSession: cloudStatus,
        };
      });
    }
    return registerCloudSession(context.server, () => instance);
  },
};
