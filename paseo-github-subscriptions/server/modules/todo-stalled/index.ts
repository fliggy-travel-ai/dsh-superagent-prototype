import { stalledSnapshot } from '../../../shared/stalled.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 停滞会话：主会话（置顶工作区中的会话）无活动的检查，与待办模块共用同一实例与缓存。 */
export const stalledModule: Module = {
  id: 'todo.stalled',
  label: '停滞会话',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const services = mainOf(context);
    context.server.handle(stalledSnapshot, () =>
      services.stalledSnapshot(context.machine, context.services.home),
    );
    return () => {
      services.invalidateStalledCache?.();
    };
  },
};
