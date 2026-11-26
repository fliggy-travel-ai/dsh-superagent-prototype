import type { Preferences, ProviderPolicy } from './model.ts';

/**
 * 会话忙时的送达策略：先查账号名（如 `claude-3`），再查账号家族（`claude`）。
 * 没有设置时 Claude 默认本轮结束后送达：Claude 在下一次工具调用时读取插话，下一次调用是提问时，插话会被当成提问的回答。
 * @param policies 用户设置的策略。
 * @param provider 会话的账号名。
 * @returns 生效的策略。
 */
export function providerPolicy(policies: Preferences['providerPolicies'], provider: string): ProviderPolicy {
  const family = provider.split('-')[0];
  return policies[provider] ?? policies[family] ?? (family === 'claude' ? 'queue' : 'interrupt');
}
