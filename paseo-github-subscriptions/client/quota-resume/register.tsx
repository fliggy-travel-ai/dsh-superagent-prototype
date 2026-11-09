import type { PluginClientContext } from '@getpaseo/plugin/client';
import { modulesStatus } from '../../shared/modules.ts';
import { quotaRow } from '../../shared/claude-accounts.ts';
import { QuotaMessage } from './quota-message.tsx';

const QUOTA_LIMIT = /you(?:'|’)ve hit your (?:(?:session|usage|5.hour) )?limit/i;

/**
 * 额度不足卡片：在聊天里显示自动继续状态和倒计时，带“额度恢复后自动继续”开关。
 * 只在服务端 usage.claudeAccounts 模块运行时注册；旧插件 claude-quota-resume 仍启用、模块拒绝启动时不注册，
 * 避免同一条消息出现两张卡片。
 */
export function registerQuotaResume(client: PluginClientContext): () => void {
  const removers: Array<() => void> = [];
  let disposed = false;
  void client.rpc(modulesStatus, {}).then(snapshot => {
    if (disposed || !snapshot.modules.some(module => module.id === 'usage.claudeAccounts' && module.state === 'running')) return;
    removers.push(client.addTimelineTransformer({
      id: 'quota-resume',
      query: { itemType: 'assistant_message' },
      transform({ item, phase }) {
        if (!QUOTA_LIMIT.test(item.text)) return undefined;
        return { items: [{ type: 'plugin', kind: 'quota-resume', version: 1, data: { text: item.text, ...(item.messageId ? { messageId: item.messageId } : {}), phase } }] };
      },
    }));
    removers.push(client.addTimelineRenderer({ kind: 'quota-resume', version: 1, schema: quotaRow, Component: QuotaMessage }));
  }).catch(() => {});
  return () => { disposed = true; for (const remove of removers.splice(0)) remove(); };
}
