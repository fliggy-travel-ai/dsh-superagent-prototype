import { z } from 'zod';
import { patchMachineConfig } from '../../core/machine-writer.ts';
import { quotaGateConfigure, quotaGateSnapshot, gateExcluded, type QuotaGateSnapshot } from '../../../shared/quota-gate.ts';
import { isMainInstance, type Module } from '../types.ts';
import { localQuotaReader } from './reports.ts';
import { quotaProblems, quotaWarnings } from './rules.ts';

const quotaGateSchema = z.strictObject({
  minRemainingPct: z.number().min(0).max(100).default(10),
  excludeProviders: z.array(z.string().min(1)).default([]),
});
type QuotaGateConfig = z.infer<typeof quotaGateSchema>;

function within<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('本机额度读取超时'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function formatAlternatives(result: { passing: string[]; unknown: string[] } | null): string {
  if (result === null) return '本机额度可用账号：读取失败';
  const base = `本机额度可用账号：${result.passing.join('、') || '无'}`;
  return result.unknown.length > 0
    ? `${base}；本机额度未知账号（允许创建）：${result.unknown.join('、')}`
    : base;
}

export const quotaGateModule: Module<QuotaGateConfig> = {
  id: 'providers.quotaGate',
  label: '新建会话额度检查',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  config: { section: 'quotaGate', spec: { schema: quotaGateSchema, fallback: quotaGateSchema.parse({}) } },
  register({ server, services, config, machine }) {
    // 页面保存例外后立即更新闭包并写回 machine.json，不需要重载插件。
    let current = config;
    const localProviders = async () => {
      const { client } = await services.daemon.ready();
      const { entries, compactSnapshot } = await client.getProvidersSnapshot();
      const byId = new Map((compactSnapshot?.entries ?? entries).map(entry => [entry.provider, entry]));
      return [...byId.values()]
        .map(entry => ({ id: entry.provider, label: entry.label ?? null, enabled: entry.enabled ?? true }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    const snapshot = async (): Promise<QuotaGateSnapshot> => ({
      minRemainingPct: current.minRemainingPct,
      excludeProviders: [...current.excludeProviders],
      providers: await localProviders().catch(() => null),
    });
    server.handle(quotaGateSnapshot, snapshot);
    server.handle(quotaGateConfigure, async input => {
      const next = { minRemainingPct: current.minRemainingPct, excludeProviders: [...input.excludeProviders] };
      await patchMachineConfig(machine.path, raw => ({ ...raw, quotaGate: next }));
      current = next;
      return snapshot();
    });
    return server.addHook('agent.create.before', async ({ request }) => {
      const { provider } = request.config;
      if (gateExcluded(current.excludeProviders, provider)) return request;
      const deadline = AbortSignal.timeout(15_000);
      const floor = current.minRemainingPct;
      const checked = await within(services.daemon.ready().then(async ({ client }) => {
        if (deadline.aborted) return;
        const reader = localQuotaReader(client, services.home, deadline);
        return { reader, quota: await reader.read(provider, request.env) };
      }), deadline).catch(() => undefined);
      const problems = quotaProblems(checked?.quota);
      if (checked && problems.length > 0) {
        const alts = await within(checked.reader.alternatives(provider, floor), deadline).catch(() => null);
        throw new Error(`新建会话额度检查拒绝 ${provider}：${problems.join('；')}。${formatAlternatives(alts)}`);
      }
      const warnings = quotaWarnings(checked?.quota, floor);
      if (checked && warnings.length > 0) {
        // 低于阈值的账号常在派发后几十分钟内用尽；本机还有达标账号时拒绝，让主会话改派，没有时才放行。
        const alts = await within(checked.reader.alternatives(provider, floor), deadline).catch(() => null);
        if (alts !== null && alts.passing.length > 0) {
          throw new Error(`新建会话额度检查拒绝 ${provider}：额度低于 ${floor}%（${warnings.join('；')}）。${formatAlternatives(alts)}`);
        }
        console.warn(`[开发自动化][providers.quotaGate] ${provider} 额度低于 ${floor}%：${warnings.join('；')}，本机没有达标账号，允许创建会话`);
      } else if (!checked?.quota?.allocationHint || checked.quota.allocationHint === 'unknown') {
        console.warn(`[开发自动化][providers.quotaGate] ${provider} 的本机额度未知，允许创建会话`);
      }
      return request;
    });
  },
};
