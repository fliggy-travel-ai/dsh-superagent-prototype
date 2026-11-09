import { StalledRuntime } from '../../stalled.ts';
import { stalledPort } from '../../stalled-port.ts';
import { sessionRoles } from '../../core/session-roles.ts';
import { isModuleEnabled } from '../../core/machine-settings-rpc.ts';
import { TodoRuntime } from '../../todo.ts';
import { TodoActionOutputSchema, TodoLocalSnapshotSchema, todoAct, todoList, todoLocal } from '../../../shared/todo.ts';
import type { StalledSnapshot } from '../../../shared/stalled.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

const STALLED_CACHE_MS = 45_000;

/** 待办汇总：本机与跨主机待办合看、处理记录。 */
export const todoModule: Module = {
  id: 'todo',
  label: '待办汇总',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server, machine } = context;
    const services = mainOf(context);
    let stalled: StalledRuntime | null = null;
    let stalledCache: { at: number; value: Promise<StalledSnapshot> } | null = null;

    const getStalled = async (): Promise<StalledSnapshot | null> => {
      if (!isModuleEnabled(machine, 'todo.stalled', true)) return null;
      const now = Date.now();
      if (stalledCache && now - stalledCache.at < STALLED_CACHE_MS) {
        return stalledCache.value;
      }
      const promise = (async () => {
        const githubEnabled = isModuleEnabled(machine, 'github', true);
        const [hosts, connection] = await Promise.all([
          services.readyHosts(),
          context.services.daemon.ready(),
          ...(githubEnabled ? [services.github().catch(() => null)] : []),
        ]);
        stalled ??= new StalledRuntime(
          stalledPort(
            connection.client,
            hosts,
            () =>
              githubEnabled &&
              services.runtime?.storage.state.preferences.enabled &&
              !services.runtime.storage.state.preferences.shadow
                ? services.runtime.storage.state.subscriptions
                    .filter(subscription => !subscription.expiresAt || Date.parse(subscription.expiresAt) > Date.now())
                    .map(subscription => subscription.agentId)
                : [],
            sessionRoles(context.services.home),
          ),
        );
        return stalled.snapshot();
      })().catch(error => {
        if (stalledCache?.value === promise) stalledCache = null;
        throw error;
      });
      stalledCache = { at: now, value: promise };
      return promise;
    };

    const runtime = new TodoRuntime({
      async selfHost() {
        const hosts = await services.readyHosts();
        return hosts.selfHost(machine.machine || '本机');
      },
      async hosts() {
        const hosts = await services.readyHosts();
        return hosts.hosts();
      },
      async presence() {
        if (!isModuleEnabled(machine, 'answer.presence', true)) return null;
        return (await services.readyPresence()).snapshot();
      },
      async browser() {
        if (!isModuleEnabled(machine, 'answer.browser', true)) return null;
        return (await services.readyBrowser()).snapshot();
      },
      async stalled() {
        return getStalled();
      },
      async escalation() {
        if (!services.escalation) return null;
        return services.escalation.snapshot();
      },
      async quiet() {
        if (!services.quiet) return null;
        return services.quiet.snapshot();
      },
      async remoteLocal(hostId) {
        const hosts = await services.readyHosts();
        const raw = await hosts.invoke(hostId, 'todo.local', {});
        return TodoLocalSnapshotSchema.parse(raw);
      },
      async remoteAct(hostId, input) {
        const hosts = await services.readyHosts();
        const raw = await hosts.invoke(hostId, 'todo.act', input);
        return TodoActionOutputSchema.parse(raw);
      },
      async answerQuestion(input) {
        if (!isModuleEnabled(machine, 'answer.presence', true)) {
          throw new Error('问答模式模块未启用');
        }
        return (await services.readyPresence()).answer(input);
      },
      async markQuestionRead(input) {
        if (!isModuleEnabled(machine, 'answer.presence', true)) {
          throw new Error('问答模式模块未启用');
        }
        return (await services.readyPresence()).markRead(input);
      },
      async ackEscalation({ id }) {
        if (!services.escalation) return { ok: false };
        return { ok: services.escalation.acknowledge(id) };
      },
    });

    server.handle(todoLocal, () => runtime.local());
    server.handle(todoList, () => runtime.list());
    server.handle(todoAct, input => runtime.act(input));
  },
};
