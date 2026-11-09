import { TodoRuntime } from '../../todo.ts';
import { TodoActionOutputSchema, TodoLocalSnapshotSchema, todoAct, todoList, todoLocal } from '../../../shared/todo.ts';
import type { StalledSnapshot } from '../../../shared/stalled.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 待办汇总：本机与跨主机待办合看、处理记录。 */
export const todoModule: Module = {
  id: 'todo',
  label: '待办汇总',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server, machine } = context;
    const services = mainOf(context);
    const isRunning = (id: string, defaultEnabled: boolean) =>
      services.isModuleRunning(id, machine, defaultEnabled);

    const getStalled = async (): Promise<StalledSnapshot | null> => {
      if (!isRunning('todo.stalled', true) || services.stalledPaused) return null;
      return services.stalledSnapshot(machine, context.services.home);
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
        if (!isRunning('answer.presence', true)) return null;
        return (await services.readyPresence()).snapshot();
      },
      async browser() {
        if (!isRunning('answer.browser', true)) return null;
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
        if (!isRunning('answer.presence', true)) {
          throw new Error('问答模式模块未启用');
        }
        return (await services.readyPresence()).answer(input);
      },
      async markQuestionRead(input) {
        if (!isRunning('answer.presence', true)) {
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
