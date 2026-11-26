import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** 门控例外：pattern 以 `*` 结尾时按前缀匹配（如 `codex*` 命中 `codex-2`），其余精确匹配 provider ID。 */
/** 例外项在页面上用 Provider 显示名；对不上单个 Provider 时保留原来的模式。 */
export function gateExceptionLabel(
  pattern: string,
  providers: readonly { id: string; label: string | null }[],
): string {
  const exact = providers.find(provider => provider.id === pattern);
  return exact?.label || exact?.id || pattern;
}

export function gateExcluded(patterns: readonly string[], provider: string): boolean {
  return patterns.some(pattern => pattern.endsWith('*') ? provider.startsWith(pattern.slice(0, -1)) : pattern === provider);
}

/**
 * 调整单个 Provider 的拦截状态并返回新的例外列表。
 * 恢复拦截时，命中的 `*` 通配模式按当前机器已知 Provider 展开成精确项（去掉恢复的那一个），
 * 只影响这台机器现有的 Provider；不相关的模式保持原样。
 */
export function toggleGateExclusion(
  patterns: readonly string[],
  provider: string,
  excluded: boolean,
  knownProviders: readonly string[],
): string[] {
  if (excluded) return gateExcluded(patterns, provider) ? [...patterns] : [...patterns, provider];
  const next: string[] = [];
  for (const pattern of patterns) {
    if (!gateExcluded([pattern], provider)) {
      if (!next.includes(pattern)) next.push(pattern);
      continue;
    }
    if (!pattern.endsWith('*')) continue;
    const prefix = pattern.slice(0, -1);
    for (const id of knownProviders) {
      if (id !== provider && id.startsWith(prefix) && !next.includes(id)) next.push(id);
    }
  }
  return next;
}

export const QuotaGateSnapshotSchema = z.strictObject({
  minRemainingPct: z.number(),
  excludeProviders: z.array(z.string()),
  /** 本机 Provider 清单；守护进程读取失败时为 null。 */
  providers: z.array(z.strictObject({ id: z.string(), label: z.string().nullable(), enabled: z.boolean() })).nullable(),
});
export type QuotaGateSnapshot = z.infer<typeof QuotaGateSnapshotSchema>;

export const quotaGateSnapshot = defineRpc({ name: 'providers.quota-gate.snapshot', input: z.object({}), output: QuotaGateSnapshotSchema });

export const quotaGateConfigure = defineRpc({
  name: 'providers.quota-gate.configure',
  input: z.strictObject({ excludeProviders: z.array(z.string().min(1)) }),
  output: QuotaGateSnapshotSchema,
});
