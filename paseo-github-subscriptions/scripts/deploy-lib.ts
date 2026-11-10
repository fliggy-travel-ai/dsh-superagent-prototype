/** 部署脚本的纯函数部分，便于测试。见 scripts/deploy.ts。 */
import { join } from 'node:path';
import { MAIN_PLUGIN_ID, PROVIDER_PLUGIN_ID, type InstanceRole } from '../shared/instances.ts';

export type DeployRole = InstanceRole | 'compat';
export interface DeployOptions {
  role: DeployRole;
  changeRole: boolean;
  ref: string;
  target: string;
  reload: boolean;
  install: boolean;
  dryRun: boolean;
  host: string | null;
  paseo: string;
}

export const pluginIdFor = (role: DeployRole) => role === 'provider' ? PROVIDER_PLUGIN_ID : MAIN_PLUGIN_ID;

export function parseDeployArgs(argv: readonly string[], home: string): DeployOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (['--reload', '--install', '--dry-run', '--change-role'].includes(arg)) flags.add(arg);
    else if (['--role', '--ref', '--target', '--host', '--paseo'].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 缺少取值`);
      values.set(arg, value);
    } else throw new Error(`未知参数：${arg}`);
  }
  const role = values.get('--role');
  if (role !== 'main' && role !== 'provider' && role !== 'compat') throw new Error('--role 必须是 main、provider 或 compat');
  const ref = values.get('--ref');
  if (!ref) throw new Error('--ref 必填：要部署的标签或提交');
  return {
    role, ref, changeRole: flags.has('--change-role'),
    target: values.get('--target') ?? join(home, '.paseo', 'local-plugins', pluginIdFor(role)),
    reload: flags.has('--reload'), install: flags.has('--install'), dryRun: flags.has('--dry-run'),
    host: values.get('--host') ?? null, paseo: values.get('--paseo') ?? 'paseo',
  };
}

/** 部署目录中的 shared/instance.ts。格式与仓库中的默认文件相同，只有取值不同。 */
export function roleFileContent(role: DeployRole): string {
  return `/**
 * 实例角色文件，由 scripts/deploy.ts 写入。不要手动修改；重新部署会覆盖。
 * 仓库中的同名文件取值为 null（兼容模式），见仓库版本中的说明。
 */
export const INSTANCE_ROLE: 'main' | 'provider' | null = ${role === 'compat' ? 'null' : `'${role}'`};
`;
}

export function readRoleFile(content: string | null): InstanceRole | null {
  if (content === null) return null;
  const match = content.match(/INSTANCE_ROLE\s*:[^=]*=\s*(?:'(main|provider)'|"(main|provider)"|(null))\s*;/);
  if (!match) throw new Error('无法识别部署目录的角色文件，请先检查');
  return (match[1] ?? match[2] ?? null) as InstanceRole | null;
}

/** 某个角色（null 为兼容模式）的实例注册了哪些 Provider。结尾 * 为前缀匹配。 */
export function providersHostedBy(role: DeployRole | null): string[] {
  if (role === 'main') return [];
  if (role === 'provider') return ['cloud-session', 'antigravity-*'];
  // 兼容模式：主实例同时托管云端会话和（打开模块时）Antigravity，重载前都要检查运行中的轮次。
  return ['cloud-session', 'antigravity-*'];
}

export function assertRoleChange(existing: InstanceRole | null, target: DeployRole, changeRole: boolean) {
  const current = existing ?? 'compat';
  if (current !== target && !changeRole) throw new Error(`部署目录现有角色为 ${current}，目标角色为 ${target}。请先确认；确认后使用 --change-role。`);
}

// 服务端（Antigravity 模块）也要用，放在 server/；插件包不能引入 scripts/ 下的文件。
export { runningTurns, type AgentRow } from '../server/running-turns.ts';
