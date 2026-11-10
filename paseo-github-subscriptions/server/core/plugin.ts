import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { ResolvedInstance } from '../../shared/instances.ts';
import { SharedDaemon } from './daemon.ts';
import { MainServices } from './services.ts';
import { loadMachineConfig, type SectionSpec } from './machine-config.ts';
import { startModules } from './modules.ts';
import { MODULES } from '../modules/index.ts';
import { registerAntigravityRpcs } from '../modules/providers-antigravity/index.ts';
import { registerProviderQuotasRpcs } from '../modules/usage-provider-quotas/index.ts';
import { registerMachineSettingsRpcs } from './machine-settings-rpc.ts';

/**
 * 按实例角色组装插件服务端：读机器配置、建共享连接和服务、注册模块。所有注册都是同步的。
 * 入口 index.server.ts 按编译时的角色调用；测试可以直接传入任一角色。
 */
export function startPlugin(server: PluginServerContext, instance: ResolvedInstance) {
  const home = process.env.PASEO_HOME ?? join(homedir(), '.paseo');
  const baseDirectory = process.env.PASEO_GHSUB_STATE_DIR ?? join(home, 'github-subscriptions');
  const stateDirectory = instance.stateSubdirectory ? join(baseDirectory, instance.stateSubdirectory) : baseDirectory;
  const sections: Record<string, SectionSpec> = {};
  for (const definition of MODULES) if (definition.config) sections[definition.config.section] = definition.config.spec;
  const machine = loadMachineConfig(process.env.PASEO_GHSUB_MACHINE_CONFIG ?? join(baseDirectory, 'machine.json'), sections);
  for (const error of machine.errors) console.error(`[开发自动化] ${error}`);

  const daemon = new SharedDaemon(home);
  const main = instance.role === 'main' ? new MainServices(stateDirectory, daemon) : null;
  const services = { home, daemon, main };
  const host = startModules(MODULES, { server, instance, machine, services, stateDirectory, baseDirectory });
  if (instance.role === 'main') {
    // 设置页要用这两组 RPC。模块启用时已由模块注册（在模块上下文里），这里只在模块没注册时兜底，不会重复。
    registerAntigravityRpcs({ server, machinePath: machine.path, services });
    registerProviderQuotasRpcs({ server, machinePath: machine.path, services });
    registerMachineSettingsRpcs({ server, machine, host, services, stateDirectory, baseDirectory, sections });
    if (
      !host.status().modules.some(m => m.id === 'answer.browser' && m.state === 'running') &&
      existsSync(join(stateDirectory, 'browser-state.json'))
    ) {
      void main?.readyBrowser().catch(() => {});
    }
  }

  return async () => {
    await host.dispose();
    await main?.stop();
    await daemon.close();
  };
}
