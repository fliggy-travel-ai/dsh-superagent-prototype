import { isQuestionTodo, isUnreadAutomaticAnswer, type PresenceSnapshot, type QuestionAnswer, type QuestionRead } from '../shared/presence.ts';
import type { BrowserSnapshot } from '../shared/browser.ts';
import type { StalledSnapshot } from '../shared/stalled.ts';
import type { EscalationSnapshot } from '../shared/escalation.ts';
import type { QuietSnapshot } from '../shared/quiet.ts';
import {
  TodoLocalSnapshotSchema,
  type TodoActionInput,
  type TodoActionOutput,
  type TodoItem,
  type TodoLocalSnapshot,
  type TodoLogItem,
  type TodoMergedSnapshot,
  type TodoType,
} from '../shared/todo.ts';

export interface TodoPort {
  now?(): number;
  selfHost(): Promise<{ id: string; name: string }>;
  hosts(): Promise<Array<{ id: string; name: string; online: boolean }>>;
  presence(): Promise<PresenceSnapshot | null>;
  browser(): Promise<BrowserSnapshot | null>;
  stalled(): Promise<StalledSnapshot | null>;
  escalation?(): Promise<EscalationSnapshot | null>;
  quiet?(): Promise<QuietSnapshot | null>;
  accountsNeedingAttention?(): Promise<number>;
  remoteLocal(hostId: string): Promise<TodoLocalSnapshot>;
  remoteAct(hostId: string, input: TodoActionInput): Promise<TodoActionOutput>;
  answerQuestion(input: QuestionAnswer): Promise<unknown>;
  markQuestionRead(input: QuestionRead): Promise<unknown>;
  ackEscalation?(input: { id: string; agentId?: string }): Promise<unknown>;
}

const TYPE_ORDER: Record<TodoType, number> = {
  ask: 0,
  esc: 1,
  web: 2,
  stall: 3,
  read: 4,
};

function formatAge(prefix: string, iso: string, nowMs: number, suffix = ''): string {
  const diffMs = Math.max(0, nowMs - Date.parse(iso));
  if (!Number.isFinite(diffMs)) return `${prefix}${suffix}`;
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${prefix} ${minutes} 分钟${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${prefix} ${hours} 小时${suffix}`;
  const days = Math.round(hours / 24);
  return `${prefix} ${days} 天${suffix}`;
}

export class TodoRuntime {
  private readonly port: TodoPort;

  constructor(port: TodoPort) {
    this.port = port;
  }

  private now(): number {
    return this.port.now?.() ?? Date.now();
  }

  async local(): Promise<TodoLocalSnapshot> {
    const nowMs = this.now();
    const self = await this.port.selfHost();
    const [presence, browser, stalled, escalation, quiet, accountsNeedingAttention] = await Promise.all([
      this.port.presence().catch(() => null),
      this.port.browser().catch(() => null),
      this.port.stalled().catch(() => null),
      (this.port.escalation?.() ?? Promise.resolve(null)).catch(() => null),
      (this.port.quiet?.() ?? Promise.resolve(null)).catch(() => null),
      (this.port.accountsNeedingAttention?.() ?? Promise.resolve(0)).catch(() => 0),
    ]);

    const items: TodoItem[] = [];
    const logs: TodoLogItem[] = [];
    const openAskSessionIds = new Set<string>();

    // 1. 网页提问（只收 source === 'browser' 的待回答问题）& 5. 代答未读
    for (const q of presence?.questions ?? []) {
      if (q.answer?.source === 'automatic') {
        const pickedSummary = Object.values(q.answer.answers).flat().join('、') || '推荐项';
        logs.push({
          id: `auto:${q.id}:${q.fingerprint}`,
          at: q.at,
          kind: 'auto-answer',
          label: '离线代答',
          hostId: self.id,
          hostName: self.name,
          detail: `${q.title || '会话'} · 选择推荐项“${pickedSummary}”`,
        });
      }

      if (!isQuestionTodo(q)) continue;

      if (isUnreadAutomaticAnswer(q)) {
        const pickedSummary = Object.values(q.answer?.answers ?? {}).flat().join('、') || '推荐项';
        items.push({
          id: `read:${self.id}:${q.id}:${q.fingerprint}`,
          type: 'read',
          label: '代答未读',
          hostId: self.id,
          hostName: self.name,
          sourceLabel: `${q.source === 'browser' ? 'claude.ai 网页' : 'Paseo'} · ${self.name}`,
          sessionTitle: q.title || '未命名会话',
          at: q.at,
          ageText: formatAge('', q.at, nowMs, '前').trim(),
          text: `离线代答：选择了推荐项“${pickedSummary}”，是否生效未确认。`,
          ...(q.url ? { url: q.url } : {}),
          ...(q.source === 'native' ? { agentId: q.sessionId } : {}),
          readReceipt: {
            questionId: q.id,
            fingerprint: q.fingerprint,
          },
        });
        continue;
      }

      // 云端提问在 Paseo 作答后网页提交未确认：Paseo 侧栏已不再列出它，在这里提示去原网页重试（不提供作答表单）。
      // 沿用“网页等待”标签，不新增枚举值：旧版插件严格校验远端待办，未知标签会让整包解析失败。
      if (q.source === 'native' && q.webRetry) {
        const internalSessionId = q.webSessionId?.replace(/^session_/, '');
        if (internalSessionId) openAskSessionIds.add(internalSessionId);
        const firstQuestion = q.prompts[0]?.question;
        items.push({
          id: `web-retry:${self.id}:${q.id}:${q.fingerprint}`,
          type: 'web',
          label: '网页等待',
          hostId: self.id,
          hostName: self.name,
          sourceLabel: `claude.ai 网页 · ${self.name}`,
          sessionTitle: q.title || '云端会话提问',
          at: q.at,
          ageText: formatAge('已等', q.at, nowMs),
          text: `【网页重试】${firstQuestion ? `${q.reason}：${firstQuestion}` : q.reason}`,
          ...(q.url ? { url: q.url } : {}),
          agentId: q.sessionId,
        });
        continue;
      }

      // 原生待答提问不收（在 Paseo 侧栏“需要输入”中处理）
      if (q.source !== 'browser') continue;

      openAskSessionIds.add(q.sessionId);
      const firstPrompt = q.prompts[0];
      items.push({
        id: `ask:${self.id}:${q.id}:${q.fingerprint}`,
        type: 'ask',
        label: '网页提问',
        hostId: self.id,
        hostName: self.name,
        sourceLabel: `claude.ai 网页 · ${self.name}`,
        sessionTitle: q.title || '网页会话提问',
        at: q.at,
        ageText: formatAge('等待', q.at, nowMs),
        text: firstPrompt?.question ?? q.reason ?? '等待回答',
        ...(q.url ? { url: q.url } : {}),
        question: {
          questionId: q.id,
          fingerprint: q.fingerprint,
          prompts: q.prompts,
        },
      });
    }

    // 2. 升级事件（来自 answer.escalation）
    for (const ev of escalation?.pendingEvents ?? []) {
      items.push({
        id: `esc:${self.id}:${ev.id}`,
        type: 'esc',
        label: '升级事件',
        hostId: self.id,
        hostName: self.name,
        sourceLabel: `Paseo · ${self.name}`,
        sessionTitle: ev.sessionTitle || '主会话',
        at: ev.notifiedAt,
        ageText: formatAge('', ev.notifiedAt, nowMs, '前已通知 Grok').trim(),
        text: ev.questionText,
        agentId: ev.agentId,
        escalationId: ev.id,
      });
    }
    for (const deliv of escalation?.recentDeliveries ?? []) {
      logs.push({
        id: `esc-log:${deliv.id}`,
        at: deliv.at,
        kind: 'escalation',
        label: '升级投递',
        hostId: self.id,
        hostName: self.name,
        detail: `${deliv.sessionTitle} · ${deliv.summary}`,
      });
    }

    // 3. 网页等待（waiting / limited，排除已有待答网页提问的会话）
    for (const session of browser?.sessions ?? []) {
      const state = session.activity?.state;
      if (state !== 'waiting' && state !== 'limited') continue;
      if (openAskSessionIds.has(session.sessionId)) continue;
      const observedAt = session.activity?.observedAt ?? session.lastSeenAt;
      items.push({
        id: `web:${self.id}:${session.instanceId}:${session.sessionId}`,
        type: 'web',
        label: '网页等待',
        hostId: self.id,
        hostName: self.name,
        sourceLabel: `claude.ai 网页 · ${self.name}`,
        sessionTitle: `${session.instanceName} · ${session.groupTitle}`,
        at: observedAt,
        ageText: formatAge('已等', observedAt, nowMs),
        text: state === 'limited' ? '达到用量限制' : (session.activity?.reason || session.activity?.lastMessage || '等待输入'),
        url: session.url,
      });
    }
    for (const approval of browser?.approvals ?? []) {
      const statusLabel = {
        reserved: '等待回执',
        dismissed: '窗口已消失',
        'still-visible': '窗口仍显示',
        skipped: '已跳过',
      }[approval.status];
      logs.push({
        id: `web-approval:${approval.instanceId}:${approval.reservationId}`,
        at: approval.at,
        kind: 'web-approval',
        label: '网页权限点击',
        hostId: self.id,
        hostName: self.name,
        detail: `${approval.instanceName} · ${approval.button} · ${statusLabel}`,
      });
    }

    // 4. 停滞会话
    for (const s of stalled?.sessions ?? []) {
      items.push({
        id: `stall:${self.id}:${s.agentId}`,
        type: 'stall',
        label: '停滞会话',
        hostId: self.id,
        hostName: self.name,
        sourceLabel: `Paseo · ${self.name}`,
        sessionTitle: s.title || '未命名会话',
        at: s.since,
        ageText: formatAge('无活动', s.since, nowMs),
        text: s.lastMessage || s.messageError || '主会话没有运行中的轮次，也没有定时唤醒。',
        agentId: s.agentId,
      });
    }

    // 子会话归并记录（来自 answer.quietChildren）
    for (const q of quiet?.recentHandled ?? []) {
      const targetText = q.forwardStatus === 'forwarded' && q.forwardedTo
        ? `事件转给${q.forwardedTo.includes('主会话') ? '主会话' : ` ${q.forwardedTo}`}`
        : q.forwardStatus === 'no-parent'
          ? '无父会话，未转发'
          : '未转发';
      logs.push({
        id: `quiet:${q.id}`,
        at: q.at,
        kind: 'quiet-merge',
        label: '子会话归并',
        hostId: self.id,
        hostName: self.name,
        detail: `${q.sessionTitle} · ${q.clearedAttention ? '清除提醒，' : ''}${targetText}`,
      });
    }

    items.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || Date.parse(b.at) - Date.parse(a.at));
    logs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    return {
      hostId: self.id,
      hostName: self.name,
      items,
      logs: logs.slice(0, 100),
      accountsNeedingAttention,
    };
  }

  async list(): Promise<TodoMergedSnapshot> {
    const [local, allHosts] = await Promise.all([
      this.local(),
      this.port.hosts().catch(async () => {
        const self = await this.port.selfHost();
        return [{ id: self.id, name: self.name, online: true }];
      }),
    ]);

    const items: TodoItem[] = [...local.items];
    const logs: TodoLogItem[] = [...local.logs];
    const seenItemIds = new Set<string>(local.items.map(i => i.id));
    const seenLogIds = new Set<string>(local.logs.map(l => l.id));
    const seenHostIds = new Set<string>([local.hostId]);
    const hostStatuses: TodoMergedSnapshot['hosts'] = [
      {
        hostId: local.hostId,
        hostName: local.hostName,
        online: true,
        responded: true,
        error: null,
        accountsNeedingAttention: local.accountsNeedingAttention,
      },
    ];
    const failedHostNames: string[] = [];

    const remoteHosts = allHosts.filter(h => h.id !== local.hostId);
    await Promise.all(
      remoteHosts.map(async host => {
        if (seenHostIds.has(host.id)) return;
        seenHostIds.add(host.id);
        if (!host.online) {
          failedHostNames.push(host.name);
          hostStatuses.push({
            hostId: host.id,
            hostName: host.name,
            online: false,
            responded: false,
            error: '主机离线',
            accountsNeedingAttention: 0,
          });
          return;
        }
        try {
          const remote = TodoLocalSnapshotSchema.parse(await this.port.remoteLocal(host.id));
          if (remote.hostId === local.hostId) return;
          for (const item of remote.items) {
            if (seenItemIds.has(item.id)) continue;
            seenItemIds.add(item.id);
            items.push(item);
          }
          for (const log of remote.logs) {
            if (seenLogIds.has(log.id)) continue;
            seenLogIds.add(log.id);
            logs.push(log);
          }
          hostStatuses.push({
            hostId: host.id,
            hostName: remote.hostName || host.name,
            online: true,
            responded: true,
            error: null,
            accountsNeedingAttention: remote.accountsNeedingAttention,
          });
        } catch (error) {
          failedHostNames.push(host.name);
          hostStatuses.push({
            hostId: host.id,
            hostName: host.name,
            online: host.online,
            responded: false,
            error: error instanceof Error ? error.message : '未响应',
            accountsNeedingAttention: 0,
          });
        }
      }),
    );

    items.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || Date.parse(b.at) - Date.parse(a.at));
    logs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const warning = failedHostNames.length > 0
      ? `${failedHostNames.join('、')} 未响应，以下只含 ${local.hostName} 的待办`
      : null;

    return {
      items,
      logs: logs.slice(0, 150),
      hosts: hostStatuses,
      warning,
    };
  }

  async act(input: TodoActionInput): Promise<TodoActionOutput> {
    if (!input.hostId || input.hostId.trim() === '' || input.hostId === 'local') {
      return { ok: false, message: '缺少有效主机标识，已拒绝执行' };
    }
    const self = await this.port.selfHost();
    if (!self.id || self.id === 'local') {
      return { ok: false, message: '本机主机标识未就绪，已拒绝执行' };
    }
    if (input.hostId !== self.id) {
      const knownHosts = await this.port.hosts().catch(() => []);
      if (!knownHosts.some(h => h.id === input.hostId && h.id !== self.id)) {
        return { ok: false, message: `未知的目标主机：${input.hostId}` };
      }
      try {
        return await this.port.remoteAct(input.hostId, input);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '跨主机转发失败' };
      }
    }
    try {
      const { action } = input;
      if (action.type === 'answer') {
        await this.port.answerQuestion({
          id: action.questionId,
          answers: action.answers,
          ...(action.otherAnswers ? { otherAnswers: action.otherAnswers } : {}),
        });
        return { ok: true, message: '已提交，等待网页确认' };
      }
      if (action.type === 'read') {
        await this.port.markQuestionRead({
          id: action.questionId,
          fingerprint: action.fingerprint,
        });
        return { ok: true, message: '已读' };
      }
      if (action.type === 'ack-escalation') {
        if (!this.port.ackEscalation) {
          return { ok: false, message: '升级通知未启用' };
        }
        const res = await this.port.ackEscalation({ id: action.escalationId, agentId: action.agentId });
        if (res && typeof res === 'object' && 'ok' in res && (res as { ok?: boolean }).ok === false) {
          return { ok: false, message: '未找到该升级事件或升级通知未启用' };
        }
        return { ok: true, message: '已标为已处理' };
      }
      return { ok: false, message: '未知操作' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '操作失败' };
    }
  }
}
