import {
  createHeartbeat,
  deleteHeartbeat,
  listHeartbeatCounts,
  listHeartbeats,
  updateHeartbeat,
} from '../../../shared/heartbeats.ts';
import { isMainInstance, type Module } from '../types.ts';
import { createHeartbeatService } from './heartbeats.ts';

/** 代理心跳管理：读取本机 ~/.paseo/schedules 并通过 Paseo CLI 创建、修改和删除代理心跳。 */
export const heartbeatsModule: Module = {
  id: 'heartbeats',
  label: '代理心跳',
  defaultEnabled: true,
  alwaysEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const service = createHeartbeatService({ home: context.services.home });
    context.server.handle(listHeartbeatCounts, () => service.readHeartbeatCounts());
    context.server.handle(listHeartbeats, input => service.readHeartbeats(input));
    context.server.handle(createHeartbeat, input => service.addHeartbeat(input));
    context.server.handle(updateHeartbeat, input => service.editHeartbeat(input));
    context.server.handle(deleteHeartbeat, input => service.removeHeartbeat(input));
  },
};
