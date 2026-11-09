import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { INSTANCE_ROLE } from './shared/instance.ts';
import { resolveInstance } from './shared/instances.ts';
import { SharedDaemon } from './server/core/daemon.ts';
import { MainServices } from './server/core/services.ts';
import { loadMachineConfig, type SectionSpec } from './server/core/machine-config.ts';
import { startModules } from './server/core/modules.ts';
import { MODULES } from './server/modules/index.ts';
import { registerAntigravityRpcs } from './server/modules/providers-antigravity/index.ts';
import { registerProviderQuotasRpcs } from './server/modules/usage-provider-quotas/index.ts';

/**
 * 开发自动化插件服务端入口。实例角色见 shared/instance.ts，模块见 server/modules/index.ts。
 * 本函数只组装：读机器配置、建共享连接和服务、注册模块。所有注册都是同步的。
 */
export default function contribute(server: PluginServerContext) {
  const instance = resolveInstance(INSTANCE_ROLE);
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
  if (instance.role === 'main') {
    registerAntigravityRpcs({ server, machinePath: machine.path, services });
    registerProviderQuotasRpcs({ server, machinePath: machine.path, services });
  }
  const host = startModules(MODULES, { server, instance, machine, services, stateDirectory, baseDirectory });

  return async () => {
    await host.dispose();
    await main?.stop();
    await daemon.close();
  };
}
