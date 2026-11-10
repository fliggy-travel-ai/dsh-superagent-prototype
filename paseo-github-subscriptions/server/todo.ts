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
  native: 1,
  esc: 2,
  web: 3,
  stall: 4,
  read: 5,
};

const NATIVE_QUESTION_TEXT_MAX_LEN = 120;

function normalizeSessionSuffix(raw?: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('cse_') && raw.length > 4) return raw.slice(4);
  if (raw.startsWith('session_') && raw.length > 8) return raw.slice(8);
  return raw;
}

function formatNativeQuestionText(
  firstPrompt?: { header?: string; question: string },
  fallback?: string,
): string {
  const header = firstPrompt?.header?.trim();
  const question = firstPrompt?.question?.trim();
  const raw =
    header && question && header !== question
      ? `${header}：${question}`
      : question || header || fallback?.trim() || '等待回答';
  return raw.length > NATIVE_QUESTION_TEXT_MAX_LEN
    ? `${raw.slice(0, NATIVE_QUESTION_TEXT_MAX_LEN)}…`
    : raw;
}

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

export const TODO_REMOTE_CACHE_TTL_MS = 10_000;
/** 远端主机离线或暂时超时时，允许沿用最近一次 `todo.local` 快照的过期上限（60 秒）；超过上限仍无响应则提示未响应。 */
export const TODO_REMOTE_OFFLINE_MAX_AGE_MS = 60_000;
export const TODO_REMOTE_MAX_WAIT_MS = 150;

export interface TodoRuntimeOptions {
  remoteCacheTtlMs?: number;
  remoteOfflineMaxAgeMs?: number;
  remoteMaxWaitMs?: number;
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

export class TodoRuntime {
  private readonly port: TodoPort;
  private readonly remoteCacheTtlMs: number;
  private readonly remoteOfflineMaxAgeMs: number;
  private readonly remoteMaxWaitMs: number;
  private readonly remoteCache = new Map<string, { at: number; expired: boolean; snapshot: TodoLocalSnapshot }>();
  private readonly remoteVersion = new Map<string, number>();
  private readonly remoteInflight = new Map<string, { version: number; promise: Promise<TodoLocalSnapshot> }>();

  constructor(port: TodoPort, options: TodoRuntimeOptions = {}) {
    this.port = port;
    this.remoteCacheTtlMs = options.remoteCacheTtlMs ?? TODO_REMOTE_CACHE_TTL_MS;
    this.remoteOfflineMaxAgeMs = options.remoteOfflineMaxAgeMs ?? TODO_REMOTE_OFFLINE_MAX_AGE_MS;
    this.remoteMaxWaitMs = options.remoteMaxWaitMs ?? TODO_REMOTE_MAX_WAIT_MS;
  }

  private now(): number {
    return this.port.now?.() ?? Date.now();
  }

  private fetchRemote(hostId: string): { version: number; promise: Promise<TodoLocalSnapshot> } {
    const currentVersion = this.remoteVersion.get(hostId) ?? 0;
    const existing = this.remoteInflight.get(hostId);
    if (existing && existing.version === currentVersion) {
      return existing;
    }
    const startedAt = this.now();
    const version = currentVersion;
    const promise = (async () => {
      const remote = TodoLocalSnapshotSchema.parse(await this.port.remoteLocal(hostId));
      if ((this.remoteVersion.get(hostId) ?? 0) === version) {
        this.remoteCache.set(hostId, { at: startedAt, expired: false, snapshot: remote });
      }
      return remote;
    })().finally(() => {
      if (this.remoteInflight.get(hostId)?.promise === promise) {
        this.remoteInflight.delete(hostId);
      }
    });
    const entry = { version, promise };
    this.remoteInflight.set(hostId, entry);
    return entry;
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

    const allQuestions = presence?.questions ?? [];
    const activeBrowserQuestions = allQuestions.filter(
      q => q.source === 'browser' && isQuestionTodo(q) && !isUnreadAutomaticAnswer(q),
    );
    const isDuplicatedByBrowserQuestion = (q: (typeof allQuestions)[number]): boolean =>
      activeBrowserQuestions.some(bq => {
        if (bq.id === q.id || bq.delegatedTo === q.id || q.delegatedTo === bq.id) return true;
        if (bq.fingerprint === q.fingerprint) return true;
        const nativeWebSession = normalizeSessionSuffix(q.webSessionId);
        const browserSession = normalizeSessionSuffix(bq.sessionId);
        if (nativeWebSession && browserSession && nativeWebSession === browserSession) {
          if (!q.toolUseId || !bq.toolUseId || q.toolUseId === bq.toolUseId) return true;
        }
        return false;
      });

    // 1. 网页提问（source === 'browser'）、会话提问（source === 'native' 待答，只显示不作答）& 5. 代答未读
    for (const q of allQuestions) {
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

      if (q.source === 'native') {
        if (q.state !== 'pending' || q.delegatedTo || q.webRetry) continue;
        if (isDuplicatedByBrowserQuestion(q)) continue;
        const firstPrompt = q.prompts[0];
        items.push({
          id: `native:${self.id}:${q.id}:${q.fingerprint}`,
          type: 'native',
          label: '会话提问',
          hostId: self.id,
          hostName: self.name,
          sourceLabel: `Paseo · ${self.name}`,
          sessionTitle: q.title || '未命名会话',
          at: q.at,
          ageText: formatAge('等待', q.at, nowMs),
          text: formatNativeQuestionText(firstPrompt, q.reason),
          agentId: q.sessionId,
        });
        continue;
      }

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
    for (const closure of escalation?.recentClosures ?? []) {
      logs.push({
        id: `esc-closed:${closure.id}`,
        at: closure.at,
        kind: 'escalation',
        // 标签沿用已有取值：跨主机快照按枚举校验，新增取值会让旧版本主机读不了整个待办。
        label: '升级投递',
        hostId: self.id,
        hostName: self.name,
        detail: `已自动结束（${closure.reason}） · ${closure.sessionTitle} · ${closure.summary}`,
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
    const totalStart = performance.now();
    let localMs = 0;
    let hostsMs = 0;
    const remoteMs: Record<string, number> = {};

    const tLocal0 = performance.now();
    const localTask = this.local().then(value => {
      localMs = roundMs(performance.now() - tLocal0);
      return value;
    });
    const tHosts0 = performance.now();
    const hostsTask = this.port
      .hosts()
      .catch(async () => {
        const self = await this.port.selfHost();
        return [{ id: self.id, name: self.name, online: true }];
      })
      .then(value => {
        hostsMs = roundMs(performance.now() - tHosts0);
        return value;
      });
    const [local, allHosts] = await Promise.all([localTask, hostsTask]);

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

    const mergeRemoteSnapshot = (host: { id: string; name: string; online: boolean }, remote: TodoLocalSnapshot) => {
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
        online: host.online,
        responded: true,
        error: null,
        accountsNeedingAttention: remote.accountsNeedingAttention,
      });
    };

    const remoteHosts = allHosts.filter(h => h.id !== local.hostId);
    await Promise.all(
      remoteHosts.map(async host => {
        if (seenHostIds.has(host.id)) return;
        seenHostIds.add(host.id);
        const nowMs = this.now();
        const cached = this.remoteCache.get(host.id);
        const validFallback = cached && nowMs - cached.at < this.remoteOfflineMaxAgeMs ? cached.snapshot : null;

        if (!host.online) {
          remoteMs[host.id] = 0;
          if (validFallback) {
            mergeRemoteSnapshot(host, validFallback);
            return;
          }
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

        if (cached && !cached.expired && nowMs - cached.at < this.remoteCacheTtlMs) {
          remoteMs[host.id] = 0;
          mergeRemoteSnapshot(host, cached.snapshot);
          return;
        }

        const tRemote0 = performance.now();
        const { version: reqVersion, promise: inflight } = this.fetchRemote(host.id);
        inflight.catch(() => {});

        type RaceOutcome = { kind: 'ok'; value: TodoLocalSnapshot } | { kind: 'err'; error: unknown } | { kind: 'timeout' };
        let outcome: RaceOutcome;
        if (!validFallback) {
          outcome = await inflight.then(
            value => ({ kind: 'ok' as const, value }),
            error => ({ kind: 'err' as const, error }),
          );
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          outcome = await Promise.race<RaceOutcome>([
            inflight.then(
              value => ({ kind: 'ok' as const, value }),
              error => ({ kind: 'err' as const, error }),
            ),
            new Promise<RaceOutcome>(resolve => {
              timer = setTimeout(() => resolve({ kind: 'timeout' }), this.remoteMaxWaitMs);
              timer.unref?.();
            }),
          ]).finally(() => clearTimeout(timer));
        }
        remoteMs[host.id] = roundMs(performance.now() - tRemote0);

        if (outcome.kind === 'ok' && (this.remoteVersion.get(host.id) ?? 0) === reqVersion) {
          mergeRemoteSnapshot(host, outcome.value);
          return;
        }
        const latestCached = this.remoteCache.get(host.id);
        const fallback =
          latestCached && this.now() - latestCached.at < this.remoteOfflineMaxAgeMs
            ? latestCached.snapshot
            : validFallback;
        if (fallback) {
          mergeRemoteSnapshot(host, fallback);
          return;
        }
        failedHostNames.push(host.name);
        hostStatuses.push({
          hostId: host.id,
          hostName: host.name,
          online: host.online,
          responded: false,
          error: outcome.kind === 'err' && outcome.error instanceof Error ? outcome.error.message : '未响应',
          accountsNeedingAttention: 0,
        });
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
      timings: {
        localMs,
        hostsMs,
        remoteMs,
        totalMs: roundMs(performance.now() - totalStart),
      },
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
        const res = await this.port.remoteAct(input.hostId, input);
        if (res.ok) {
          const nextVersion = (this.remoteVersion.get(input.hostId) ?? 0) + 1;
          this.remoteVersion.set(input.hostId, nextVersion);
          this.remoteInflight.delete(input.hostId);
          const cached = this.remoteCache.get(input.hostId);
          if (cached) {
            cached.expired = true;
          }
          void this.fetchRemote(input.hostId).promise.catch(() => {});
        }
        return res;
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
