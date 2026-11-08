import * as automationRpc from '../../../shared/automation.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 精确授权与最近动作：授权策略、授权请求刷新、归档清理。 */
export const automationModule: Module = {
  id: 'answer.automation',
  label: '精确授权',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server } = context;
    const services = mainOf(context);
    const ready = () => services.readyAutomation();
    void ready().catch(() => {});
    server.handle(automationRpc.automationSnapshot, async () => (await ready()).snapshot());
    server.handle(automationRpc.automationPause, async ({ paused }) => (await ready()).pause(paused));
    server.handle(automationRpc.automationPolicy, async input => (await ready()).policy(input));
    const removeArchive = server.addHook('agent.archive.after', async ({ agent }) => {
      await Promise.allSettled([ready().then(current => current.archive(agent.id))]);
    });
    const removeRequested = server.addHook('agent.permission.before', async () => { void ready().then(current => current.refresh()).catch(() => {}); });
    const removeResolved = server.addHook('agent.permission.after', async ({ agent, requestId, resolution }) => { void ready().then(current => current.resolved(agent.id, requestId, resolution.behavior)).catch(() => {}); });
    return () => { removeArchive(); removeRequested(); removeResolved(); };
  },
};
