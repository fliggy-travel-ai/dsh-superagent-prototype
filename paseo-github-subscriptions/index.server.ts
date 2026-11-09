import type { PluginServerContext } from '@getpaseo/plugin/server';
import { INSTANCE_ROLE } from './shared/instance.ts';
import { resolveInstance } from './shared/instances.ts';
import { startPlugin } from './server/core/plugin.ts';

/**
 * 开发自动化插件服务端入口。实例角色见 shared/instance.ts，模块见 server/modules/index.ts，组装见 server/core/plugin.ts。
 */
export default function contribute(server: PluginServerContext) {
  return startPlugin(server, resolveInstance(INSTANCE_ROLE));
}
