import type { ModuleContext, ModuleDefinition } from '../core/modules.ts';
import type { SharedDaemon } from '../core/daemon.ts';
import type { MainServices } from '../core/services.ts';

/** 模块共用的服务。`main` 只在主实例（含兼容模式）中存在。 */
export interface Services {
  readonly home: string;
  readonly daemon: SharedDaemon;
  readonly main: MainServices | null;
}

export type Module<Config = undefined> = ModuleDefinition<Config, Services>;
export type Context<Config = undefined> = ModuleContext<Config, Services>;

/** 主实例的模块拿到的服务；在 appliesTo 中保证只在主实例运行。 */
export const mainOf = (context: Context<any>): MainServices => {
  if (!context.services.main) throw new Error('主实例服务不可用');
  return context.services.main;
};
export const isMainInstance = (instance: { role: string }) => instance.role === 'main';
