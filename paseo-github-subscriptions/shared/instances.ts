/** 两个实例的标识和按角色区分的行为。服务端和客户端共用。 */
export type InstanceRole = 'main' | 'provider';

/** 主实例安装 ID。云端程序和跨主机调用写死了这个 ID。 */
export const MAIN_PLUGIN_ID = 'github-subscriptions';
/** Provider 实例安装 ID。 */
export const PROVIDER_PLUGIN_ID = 'dev-automation-providers';

export interface ResolvedInstance {
  readonly role: InstanceRole;
  /** 没有角色文件：按 main 处理并保留云端会话。 */
  readonly legacy: boolean;
  /** 本实例注册 Provider（云端会话等）。 */
  readonly hostsProviders: boolean;
  /** 本实例注册页面、侧栏和其他客户端贡献点。 */
  readonly hostsUi: boolean;
  /** 状态目录相对插件主状态目录的子目录；null 表示主状态目录本身。 */
  readonly stateSubdirectory: string | null;
}

export function resolveInstance(role: InstanceRole | null): ResolvedInstance {
  if (role === 'provider') return { role, legacy: false, hostsProviders: true, hostsUi: false, stateSubdirectory: 'providers' };
  if (role === 'main') return { role, legacy: false, hostsProviders: false, hostsUi: true, stateSubdirectory: null };
  return { role: 'main', legacy: true, hostsProviders: true, hostsUi: true, stateSubdirectory: null };
}
