import { stalledSnapshot } from '../../../shared/stalled.ts';
import { StalledRuntime } from '../../stalled.ts';
import { stalledPort } from '../../stalled-port.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { isModuleEnabled } from '../../core/machine-settings-rpc.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 停滞会话：主会话（置顶工作区中的会话）无活动的检查。 */
export const stalledModule: Module = {
  id: 'todo.stalled',
  label: '停滞会话',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const services = mainOf(context);
    let stalled: StalledRuntime | null = null;
    context.server.handle(stalledSnapshot, async () => {
      const githubEnabled = isModuleEnabled(context.machine, 'github', true);
      const [hosts, connection] = await Promise.all([
        services.readyHosts(),
        context.services.daemon.ready(),
        ...(githubEnabled ? [services.github().catch(() => null)] : []),
      ]);
      stalled ??= new StalledRuntime(stalledPort(connection.client, hosts, () => githubEnabled && services.runtime?.storage.state.preferences.enabled && !services.runtime.storage.state.preferences.shadow
        ? services.runtime.storage.state.subscriptions.filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now()).map(subscription => subscription.agentId) : [], sessionRoles(context.services.home)));
      return stalled.snapshot();
    });
  },
};
