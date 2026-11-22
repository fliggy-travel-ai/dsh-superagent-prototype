import type { ProviderRegistration } from '@getpaseo/plugin/server/provider';
import { createAntigravityAcpProvider } from './acp/provider.ts';

/** 与 Paseo 0.17 内置 antigravity-provider 一致的默认命令。 */
export const DEFAULT_ANTIGRAVITY_COMMAND: readonly [string, ...string[]] = ['agy', 'acp', '--disable-telemetry'];

export interface AntigravityProviderAccount {
  readonly providerId: string;
  readonly label: string;
  readonly command?: readonly string[];
  readonly description?: string;
}

/** 命令是否已经是 ACP 形式（带 acp 子命令）。 */
export const isAcpCommand = (command: readonly string[]): boolean => command.includes('acp');

/**
 * 旧 stream-json 形式的命令（0.15 及以前：只写可执行文件，`--input-format stream-json` 由复制代码在运行时追加，
 * 例如各机器的 agy-paseo 包装脚本）转换成 ACP 形式：补上 acp 子命令。包装脚本对未知参数原样透传给 agy，
 * 所以补上 `acp --disable-telemetry` 后仍经过包装脚本（代理、钥匙串绕过等环境保持不变）。
 */
export function ensureAcpCommand(command: readonly string[]): readonly [string, ...string[]] {
  if (isAcpCommand(command)) return [command[0]!, ...command.slice(1)];
  return [command[0]!, ...command.slice(1), 'acp', '--disable-telemetry'];
}

/**
 * 按配置创建 Antigravity Provider 注册对象（套用 Paseo 0.17 内置的 ACP 实现，见 ./acp/）。
 * 不写死邮箱、账号名或机器路径；Provider ID 从配置原样读取以保持已有会话可恢复。
 * env（HOME、代理等）由守护进程按 Paseo 配置的 `agents.providers[id].env` 注入 launch，这里不需要传。
 */
export function createAntigravityProvider(account: AntigravityProviderAccount): ProviderRegistration {
  const command = account.command && account.command.length > 0
    ? ensureAcpCommand(account.command)
    : DEFAULT_ANTIGRAVITY_COMMAND;
  return createAntigravityAcpProvider({
    id: account.providerId,
    label: account.label,
    description: account.description ?? `Google AI Pro (${account.label})`,
    command,
  });
}
