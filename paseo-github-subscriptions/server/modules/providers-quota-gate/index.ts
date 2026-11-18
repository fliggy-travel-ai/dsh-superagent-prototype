import { z } from 'zod';
import { isMainInstance, type Module } from '../types.ts';
import { localQuotaReader } from './reports.ts';
import { quotaProblems } from './rules.ts';

const quotaGateSchema = z.strictObject({ minRemainingPct: z.number().min(0).max(100).default(10) });
type QuotaGateConfig = z.infer<typeof quotaGateSchema>;

function within<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('本机额度读取超时'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export const quotaGateModule: Module<QuotaGateConfig> = {
  id: 'providers.quotaGate',
  label: '新建会话额度检查',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  config: { section: 'quotaGate', spec: { schema: quotaGateSchema, fallback: quotaGateSchema.parse({}) } },
  register({ server, services, config }) {
    return server.addHook('agent.create.before', async ({ request }) => {
      const { provider } = request.config;
      const deadline = AbortSignal.timeout(15_000);
      const floor = config.minRemainingPct;
      const checked = await within(services.daemon.ready().then(async ({ client }) => {
        if (deadline.aborted) return;
        const reader = localQuotaReader(client, services.home, deadline);
        return { reader, quota: await reader.read(provider, request.env) };
      }), deadline).catch(() => undefined);
      const problems = quotaProblems(checked?.quota, floor);
      if (checked && problems.length > 0) {
        const passing = await within(checked.reader.alternatives(provider, floor), deadline).catch(() => null);
        const alternatives = passing === null ? '读取失败' : passing.join('、') || '无';
        throw new Error(`新建会话额度检查拒绝 ${provider}：${problems.join('；')}。本机额度可用账号：${alternatives}`);
      }
      if (!checked?.quota?.allocationHint || checked.quota.allocationHint === 'unknown') {
        console.warn(`[开发自动化][providers.quotaGate] ${provider} 的本机额度未知，允许创建会话`);
      }
      return request;
    });
  },
};
