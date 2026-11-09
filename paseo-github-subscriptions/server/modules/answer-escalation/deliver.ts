import type { Notice } from '../../notify/engine.ts';
import { webhookPayload, type WebhookCredentials } from './webhook.ts';
import { errorSessionsOf, requestsOf, type EscalationRecord } from './records.ts';

export interface DeliverDeps {
  audit(entry: Record<string, unknown>): Promise<void>;
  isMain(agentId: string): boolean;
  prefilter(payload: unknown): Promise<boolean>;
  credentials(): Promise<WebhookCredentials>;
  post(notice: Notice, credentials: WebhookCredentials): Promise<{ httpStatus: number }>;
  records: { upsert(record: EscalationRecord): void };
  now?(): number;
  log?(line: string): void;
}

const EVENT_NAMES: Record<string, string> = { asked: '提问', error: '错误', new_project: '新项目', new_workspace: '新工作区', test: '测试' };

export function noticeRecord(notice: Notice, delivery: 'shadow' | 'live', status: EscalationRecord['status'], now: () => number = Date.now): EscalationRecord {
  const name = EVENT_NAMES[notice.event] ?? notice.event;
  const text = notice.questionSummary?.text || '';
  const requests = requestsOf(notice);
  const sessions = notice.event === 'error' ? errorSessionsOf(notice) : undefined;
  return {
    id: notice.id, event: notice.event, agentId: notice.agentId, sessionTitle: notice.title || '未命名会话', workspaceId: notice.workspaceId,
    questionText: text, summary: `${name}：${text || notice.title || '无标题'}`,
    at: new Date(now()).toISOString(), delivery, status, acknowledged: false,
    ...(requests ? { requests } : {}),
    ...(sessions ? { sessions } : {}),
  };
}

/**
 * 升级通知的投递：先预筛，再 POST 到 webhook。影子模式已删除。
 * 抛出带 `suppressed` 的错误表示“只记录，不重试”；其他错误由引擎退避重试。
 */
export function createSender(deps: DeliverDeps): (notice: Notice) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async notice => {
    const mode = 'live';
    await deps.audit({ phase: 'delivery-attempt', mode, notice });
    // 完结通知由 Paseo MCP 提供，这里只记录。
    if (notice.event === 'subagent_done') throw Object.assign(Error('完结通知由 Paseo MCP 提供，仅记录'), { suppressed: true });
    // 排队期间置顶被取消的会话不再是主会话。
    if (notice.agentId && !deps.isMain(notice.agentId)) throw Object.assign(Error('不是主会话，记录事件'), { suppressed: true });
    if (await deps.prefilter(webhookPayload(notice))) {
      await deps.audit({ phase: 'prefilter-suppressed', mode, notice });
      return;
    }
    let httpStatus: number | undefined;
    try {
      httpStatus = (await deps.post(notice, await deps.credentials())).httpStatus;
    } catch (error) {
      deps.records.upsert(noticeRecord(notice, 'live', 'failed', now));
      throw error;
    }
    await deps.audit({ httpStatus, phase: 'delivered', mode: 'live', channel: 'grok-webhook', notice });
    deps.records.upsert(noticeRecord(notice, 'live', 'delivered', now));
  };
}
