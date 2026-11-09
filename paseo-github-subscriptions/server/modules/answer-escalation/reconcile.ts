import { readFile } from 'node:fs/promises';
import { CLOSED_REASON_TEXT, type AgentView, type ClosedReason, type EscalationRecord, type EscalationRecords } from './records.ts';

export interface ReconcileDeps {
  records: EscalationRecords;
  audit(entry: Record<string, unknown>): Promise<void>;
  /** 查询会话现状：null 表示 Paseo 中查不到；抛错表示暂时查不到，保留记录下次再查。 */
  lookup(agentId: string): Promise<AgentView>;
  log?(line: string): void;
}

/** 会话快照（订阅推送或 ref 刷新）中与结束判断有关的字段。 */
export function agentView(agent: { status?: string | null; archivedAt?: string | null; pendingPermissions?: ReadonlyArray<{ id: string }> | null }): NonNullable<AgentView> {
  return { status: agent.status ?? null, archivedAt: agent.archivedAt ?? null, pending: (agent.pendingPermissions ?? []).map(p => p.id) };
}

/**
 * 升级事件的自动结束：来源提问不再等待（已回答、已取消、权限已处理），或会话不存在、已归档、已关闭时，
 * 页面记录自动结束并移出待办，审计日志写 record-closed。真正仍在等待的保留。
 */
export class EscalationReconciler {
  private readonly deps: ReconcileDeps;
  constructor(deps: ReconcileDeps) { this.deps = deps; }

  private async report(closed: EscalationRecord[], extra: Record<string, unknown> = {}) {
    for (const item of closed) {
      await this.deps.audit({ phase: 'record-closed', id: item.id, agentId: item.agentId, reason: item.closedReason, at: item.closedAt, ...extra });
      this.deps.log?.(`升级事件已自动结束（${CLOSED_REASON_TEXT[item.closedReason as ClosedReason] ?? item.closedReason}）：${item.sessionTitle} · ${item.questionText.slice(0, 40)}`);
    }
    return closed;
  }

  /** 权限钩子或引擎确认一个提问不再等待。 */
  async closeRequest(agentId: string, requestId: string) {
    return this.report(this.deps.records.closeRequest(agentId, requestId, 'resolved'), { requestId });
  }

  /** 按订阅推送的会话快照对账，不额外查询。 */
  async settle(agentId: string, view: AgentView) {
    return this.report(this.deps.records.settleAgent(agentId, view));
  }

  /** 逐个查询有未结束记录的会话。启动时和定时调用；单个会话查询失败不影响其他会话。 */
  async sweep() {
    const closed: EscalationRecord[] = [];
    for (const agentId of this.deps.records.agentsWithOpen()) {
      let view: AgentView;
      try { view = await this.deps.lookup(agentId); } catch { continue; }
      closed.push(...await this.settle(agentId, view));
    }
    return closed;
  }

  /** 旧记录没有请求编号：从审计日志回填。读不到日志时跳过，这些记录按“会话没有等待中的请求”判断。 */
  async backfill(auditPath: string) {
    let text: string;
    try { text = await readFile(auditPath, 'utf8'); } catch { return 0; }
    return this.deps.records.backfillRequests(text.split('\n'));
  }
}
