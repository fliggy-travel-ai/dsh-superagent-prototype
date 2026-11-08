import { stalledSnapshot } from '../../../shared/stalled.ts';
import { StalledRuntime } from '../../stalled.ts';
import { stalledPort } from '../../stalled-port.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 停滞会话：主会话无活动的检查。 */
export const stalledModule: Module = {
  id: 'todo.stalled',
  label: '停滞会话',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const services = mainOf(context);
    let stalled: StalledRuntime | null = null;
    context.server.handle(stalledSnapshot, async () => {
      await Promise.all([services.readyPresence(), services.github()]);
      const connection = await context.services.daemon.ready();
      stalled ??= new StalledRuntime(stalledPort(connection.client, services.presenceHosts!, () => services.runtime!.storage.state.preferences.enabled && !services.runtime!.storage.state.preferences.shadow
        ? services.runtime!.storage.state.subscriptions.filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now()).map(subscription => subscription.agentId) : []));
      return stalled.snapshot();
    });
  },
};
