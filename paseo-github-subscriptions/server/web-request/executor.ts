import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BrowserQuestion, Question } from '../../shared/presence.ts';
import {
  WebRequestAuditEntrySchema,
  type AnswerWebRequest,
  type CloudRequestOutcome,
  type WebRequestAnswer,
  type WebRequestAuditEntry,
  type WebRequestAuditSnapshot,
  type WebRequestResult,
} from '../../shared/web-request.ts';
import { browserQuestionMatchesPrompts, validateAnswers } from '../questions.ts';
import { atomicWrite } from '../storage.ts';
import { summarizeWebAnswer, type WebRequestLedger } from './ledger.ts';
import { parseExpectedPrompts } from './normalize.ts';

const WEB_SESSION_RE = /^session_([A-Za-z0-9_-]+)$/;
const FRESH_MS = 70_000;
const STALE_MS = 150_000;
const CANDIDATE_FRESH_MS = 10_000;
const DEFAULT_FIND_TIMEOUT_MS = 10_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 20_000;
const DEFAULT_RECEIPT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_AUDIT = 300;
const DEDUP_TTL_MS = 10 * 60_000;
const MAX_DEDUP = 500;

export interface WebRequestBridgeSession {
  instanceId: string;
  sessionId?: string;
  lastSeenAt: string | number;
}

export interface WebRequestBridgePort {
  syncStatus?(now?: number): {
    connected: boolean;
    hasFreshInstance: boolean;
    hasStaleInstance: boolean;
    freshSessions: Array<{ instanceId: string; sessionId: string; lastSeenAt: string }>;
    activeSessions?: Array<{ instanceId: string; sessionId: string; lastSeenAt: string }>;
  };
  sessions?(now?: number): WebRequestBridgeSession[];
  freshSessions?(now?: number): Array<{ instanceId: string; sessionId: string; lastSeenAt: string }>;
}

export interface WebRequestCandidate {
  id: string;
  question: BrowserQuestion;
  seen: number;
  state: Question['state'];
  observed?: boolean;
}

export interface WebRequestRuntimePort {
  browserCandidates(instanceId: string, sessionId: string): WebRequestCandidate[];
  isSessionObserved?(instanceId: string, sessionId: string): boolean;
  delegateBrowserAnswer(
    id: string,
    answers: Record<string, string[]>,
    otherAnswers?: Record<string, string>,
    source?: 'automatic' | 'manual',
  ): boolean;
  cancelBrowserDecision?(id: string): void;
  browserState(id: string): {
    state: Question['state'];
    queued: boolean;
    claimedAt?: string;
    browserSubmittedAt?: string;
    reason?: string;
  } | null;
}

export interface WebRequestExecutorOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  findTimeoutMs?: number;
  claimTimeoutMs?: number;
  receiptTimeoutMs?: number;
  pollIntervalMs?: number;
}

const StoredAuditSchema = z.object({
  entries: z.array(WebRequestAuditEntrySchema),
});

function toTimestamp(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value);
}

function sameInternalSession(left: string | undefined, internalId: string): boolean {
  if (!left) return false;
  const normalized = left.startsWith('session_') ? left.slice('session_'.length) : left;
  return normalized === internalId;
}

export class WebRequestExecutor {
  private directory: string;
  private path: string;
  private bridge: WebRequestBridgePort;
  private runtime: WebRequestRuntimePort;
  private ledger?: WebRequestLedger;
  private clock: () => number;
  private sleep: (ms: number) => Promise<void>;
  private findTimeoutMs: number;
  private claimTimeoutMs: number;
  private receiptTimeoutMs: number;
  private pollIntervalMs: number;
  private loaded: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private auditEntries: WebRequestAuditEntry[] = [];
  private dedup = new Map<string, {
    expected: WebRequestAnswer['expected'];
    digest: string;
    promise: Promise<WebRequestResult>;
    at: number;
  }>();
  private lateWatchers = new Map<string, {
    candidateId: string;
    instanceId: string;
    entry: WebRequestAuditEntry;
  }>();

  constructor(
    directory: string,
    bridge: WebRequestBridgePort,
    runtime: WebRequestRuntimePort,
    ledger?: WebRequestLedger,
    options: WebRequestExecutorOptions = {},
  ) {
    this.directory = directory;
    this.path = join(directory, 'web-requests.json');
    this.bridge = bridge;
    this.runtime = runtime;
    this.ledger = ledger;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.findTimeoutMs = options.findTimeoutMs ?? DEFAULT_FIND_TIMEOUT_MS;
    this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8'));
        const parsed = StoredAuditSchema.safeParse(raw);
        if (parsed.success) this.auditEntries = parsed.data.entries.slice(-MAX_AUDIT);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.auditEntries = [];
      }
    })();
    return this.loaded;
  }

  private persistAudit(): Promise<unknown> {
    const operation = this.writes.then(async () => {
      await this.ensureLoaded();
      this.auditEntries = this.auditEntries.slice(-MAX_AUDIT);
      await atomicWrite(this.path, JSON.stringify({ entries: this.auditEntries }));
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  private recordAuditEntry(entry: WebRequestAuditEntry): WebRequestAuditEntry {
    this.auditEntries.push(entry);
    if (this.auditEntries.length > MAX_AUDIT) {
      this.auditEntries.splice(0, this.auditEntries.length - MAX_AUDIT);
    }
    void this.persistAudit();
    return entry;
  }

  private pruneDedup(now: number): void {
    for (const [key, entry] of this.dedup) {
      if (now - entry.at >= DEDUP_TTL_MS) this.dedup.delete(key);
    }
    while (this.dedup.size > MAX_DEDUP) {
      const oldestKey = this.dedup.keys().next().value;
      if (oldestKey === undefined) break;
      this.dedup.delete(oldestKey);
    }
  }

  private checkLateReceipts() {
    let changed = false;
    for (const [key, watcher] of this.lateWatchers) {
      const state = this.runtime.browserState(watcher.candidateId);
      if (!state) continue;
      if (state.browserSubmittedAt) {
        watcher.entry.webSubmitted = {
          at: state.browserSubmittedAt,
          instanceId: watcher.instanceId,
          status: 'submitted',
          lateReceipt: true,
        };
        this.lateWatchers.delete(key);
        changed = true;
      } else if (state.state === 'unknown' || (state.state === 'resolved' && !state.browserSubmittedAt)) {
        watcher.entry.webSubmitted = {
          at: new Date(this.clock()).toISOString(),
          instanceId: watcher.instanceId,
          status: 'unknown',
          detail: 'page_unknown',
          lateReceipt: true,
        };
        this.lateWatchers.delete(key);
        changed = true;
      }
    }
    if (changed) void this.persistAudit();
  }

  confirmCloud(input: { webSessionId: string; toolUseId: string; outcome: CloudRequestOutcome }): void {
    void this.ensureLoaded().then(() => {
      this.checkLateReceipts();
      for (let i = this.auditEntries.length - 1; i >= 0; i--) {
        const entry = this.auditEntries[i]!;
        if (entry.webSessionId === input.webSessionId && entry.toolUseId === input.toolUseId) {
          entry.cloudConfirmed = { at: new Date(this.clock()).toISOString(), outcome: input.outcome };
          void this.persistAudit();
          break;
        }
      }
    });
  }

  async audit(): Promise<WebRequestAuditSnapshot> {
    await this.ensureLoaded();
    this.checkLateReceipts();
    await this.writes;
    return { entries: structuredClone(this.auditEntries.slice(-MAX_AUDIT)) };
  }

  private selectInstance(internalSessionId: string): { ok: true; instanceId: string } | { ok: false; result: WebRequestResult } {
    const now = this.clock();
    if (this.bridge.syncStatus) {
      const status = this.bridge.syncStatus(now);
      if (!status.connected && !status.hasFreshInstance && !status.hasStaleInstance) {
        return { ok: false, result: { status: 'unknown', detail: 'bridge_not_connected' } };
      }
      const activeMatching = new Set(
        (status.activeSessions ?? status.freshSessions)
          .filter(s => sameInternalSession(s.sessionId, internalSessionId))
          .map(s => s.instanceId),
      );
      if (activeMatching.size > 1) return { ok: false, result: { status: 'unknown', detail: 'multiple_instances' } };
      const freshMatching = [
        ...new Set(
          status.freshSessions
            .filter(s => sameInternalSession(s.sessionId, internalSessionId))
            .map(s => s.instanceId),
        ),
      ];
      if (freshMatching.length > 1) return { ok: false, result: { status: 'unknown', detail: 'multiple_instances' } };
      if (freshMatching.length === 1) return { ok: true, instanceId: freshMatching[0]! };
      if (status.hasStaleInstance) return { ok: false, result: { status: 'unknown', detail: 'scan_stale' } };
      return { ok: false, result: { status: 'page_not_open' } };
    }

    const records: WebRequestBridgeSession[] = this.bridge.sessions
      ? this.bridge.sessions(now)
      : (this.bridge.freshSessions?.(now) ?? []);
    const active = records.filter(item => {
      const age = now - toTimestamp(item.lastSeenAt);
      return age < STALE_MS;
    });
    if (!active.length) return { ok: false, result: { status: 'unknown', detail: 'bridge_not_connected' } };

    const activeMatchingInstances = new Set(
      active.filter(item => sameInternalSession(item.sessionId, internalSessionId)).map(item => item.instanceId),
    );
    if (activeMatchingInstances.size > 1) return { ok: false, result: { status: 'unknown', detail: 'multiple_instances' } };

    const fresh = active.filter(item => now - toTimestamp(item.lastSeenAt) < FRESH_MS);
    const freshMatching = [
      ...new Set(
        fresh.filter(item => sameInternalSession(item.sessionId, internalSessionId)).map(item => item.instanceId),
      ),
    ];
    if (freshMatching.length > 1) return { ok: false, result: { status: 'unknown', detail: 'multiple_instances' } };
    if (freshMatching.length === 1) return { ok: true, instanceId: freshMatching[0]! };

    const hasStale = active.some(item => {
      const age = now - toTimestamp(item.lastSeenAt);
      return age >= FRESH_MS && age < STALE_MS;
    });
    if (hasStale) return { ok: false, result: { status: 'unknown', detail: 'scan_stale' } };
    return { ok: false, result: { status: 'page_not_open' } };
  }

  readonly answerWebRequest: AnswerWebRequest = async (request: WebRequestAnswer): Promise<WebRequestResult> => {
    await this.ensureLoaded();
    this.checkLateReceipts();
    this.pruneDedup(this.clock());

    const sessionMatch = typeof request.webSessionId === 'string' ? WEB_SESSION_RE.exec(request.webSessionId) : null;
    if (!sessionMatch || typeof request.toolUseId !== 'string' || !request.toolUseId.trim()) {
      return { status: 'unknown', detail: 'invalid_answer' };
    }
    const internalSessionId = sessionMatch[1]!;
    const dedupKey = `${internalSessionId}:${request.toolUseId}`;

    if (request.kind === 'tool') {
      const summary = summarizeWebAnswer({ kind: 'tool', decision: request.decision });
      const existing = this.dedup.get(dedupKey);
      if (existing) {
        if (!isDeepStrictEqual(existing.expected, request.expected)) return { status: 'unknown', detail: 'request_changed' };
        if (existing.digest !== summary.digest) return { status: 'unknown', detail: 'answer_changed' };
        return existing.promise;
      }
      const now = this.clock();
      const nowIso = new Date(now).toISOString();
      this.recordAuditEntry({
        webSessionId: request.webSessionId,
        toolUseId: request.toolUseId,
        kind: 'tool',
        answerSummary: summary,
        answerReceived: { at: nowIso, source: 'paseo' },
        webSubmitted: { at: nowIso, status: 'unknown', detail: 'tool_in_browser' },
      });
      const result: WebRequestResult = { status: 'unknown', detail: 'tool_in_browser' };
      const promise = Promise.resolve(result);
      this.dedup.set(dedupKey, { expected: structuredClone(request.expected), digest: summary.digest, promise, at: now });
      this.pruneDedup(now);
      await this.writes;
      return result;
    }

    const normalizedAnswers: Record<string, string[]> = {};
    let answersFormatValid = Boolean(request.answers && typeof request.answers === 'object' && !Array.isArray(request.answers));
    if (answersFormatValid) {
      for (const [key, value] of Object.entries(request.answers)) {
        if (typeof value === 'string') normalizedAnswers[key] = value ? [value] : [];
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) normalizedAnswers[key] = [...value];
        else { answersFormatValid = false; break; }
      }
    }
    const normalizedOther: Record<string, string> = {};
    let otherFormatValid = request.otherAnswers === undefined || (Boolean(request.otherAnswers && typeof request.otherAnswers === 'object' && !Array.isArray(request.otherAnswers)));
    if (otherFormatValid && request.otherAnswers) {
      for (const [key, value] of Object.entries(request.otherAnswers)) {
        if (typeof value !== 'string') { otherFormatValid = false; break; }
        normalizedOther[key] = value.trim();
      }
    }

    const summary = summarizeWebAnswer({
      kind: 'question',
      answers: normalizedAnswers,
      ...(Object.keys(normalizedOther).length ? { otherAnswers: normalizedOther } : {}),
    });

    const existing = this.dedup.get(dedupKey);
    if (existing) {
      if (!isDeepStrictEqual(existing.expected, request.expected)) return { status: 'unknown', detail: 'request_changed' };
      if (existing.digest !== summary.digest) return { status: 'unknown', detail: 'answer_changed' };
      return existing.promise;
    }

    const execute = async (): Promise<WebRequestResult> => {
      const source = this.ledger?.lookup({
        webSessionId: request.webSessionId,
        toolUseId: request.toolUseId,
        digest: summary.digest,
      }) ?? 'paseo';
      const receivedAt = new Date(this.clock()).toISOString();
      const auditEntry = this.recordAuditEntry({
        webSessionId: request.webSessionId,
        toolUseId: request.toolUseId,
        kind: 'question',
        answerSummary: summary,
        answerReceived: { at: receivedAt, source },
      });
      const finish = async (result: WebRequestResult, instanceId?: string): Promise<WebRequestResult> => {
        const at = new Date(this.clock()).toISOString();
        if (result.status === 'submitted') {
          auditEntry.webSubmitted = { at, ...(instanceId ? { instanceId } : {}), status: 'submitted' };
        } else if (result.status === 'page_not_open') {
          auditEntry.webSubmitted = { at, ...(instanceId ? { instanceId } : {}), status: 'unknown', detail: 'page_not_open' };
        } else {
          auditEntry.webSubmitted = { at, ...(instanceId ? { instanceId } : {}), status: 'unknown', detail: result.detail };
        }
        await this.persistAudit();
        return result;
      };

      if (request.expected.toolName !== 'AskUserQuestion') {
        return finish({ status: 'unknown', detail: 'unsupported_tool' });
      }
      const expectedPrompts = parseExpectedPrompts(request.expected);
      if (!expectedPrompts || !answersFormatValid || !otherFormatValid) {
        return finish({ status: 'unknown', detail: 'invalid_answer' });
      }
      try {
        validateAnswers(
          expectedPrompts,
          normalizedAnswers,
          Object.keys(normalizedOther).length ? normalizedOther : undefined,
        );
      } catch {
        return finish({ status: 'unknown', detail: 'invalid_answer' });
      }

      const instanceSelection = this.selectInstance(internalSessionId);
      if (!instanceSelection.ok) {
        return finish(instanceSelection.result);
      }
      const { instanceId } = instanceSelection;

      const findStart = this.clock();
      let matchedCandidate: WebRequestCandidate | null = null;
      while (true) {
        const now = this.clock();
        const rawCandidates = this.runtime.browserCandidates(instanceId, internalSessionId);
        const freshCandidates = rawCandidates.filter(
          candidate =>
            candidate.state === 'pending' &&
            now - candidate.seen <= CANDIDATE_FRESH_MS &&
            browserQuestionMatchesPrompts(expectedPrompts, candidate.question, request.toolUseId),
        );
        if (freshCandidates.length > 1) {
          return finish({ status: 'unknown', detail: 'multiple_candidates' }, instanceId);
        }
        if (freshCandidates.length === 1) {
          matchedCandidate = freshCandidates[0]!;
          break;
        }
        if (now - findStart >= this.findTimeoutMs) {
          const observed =
            rawCandidates.some(candidate => candidate.observed === true) ||
            (this.runtime.isSessionObserved ? this.runtime.isSessionObserved(instanceId, internalSessionId) : false);
          return finish({ status: 'unknown', detail: observed ? 'not_found' : 'scan_incomplete' }, instanceId);
        }
        await this.sleep(this.pollIntervalMs);
      }

      for (let i = 0; i < matchedCandidate.question.prompts.length; i++) {
        const pagePrompt = matchedCandidate.question.prompts[i]!;
        const expectedPrompt = expectedPrompts[i];
        const questionKey = expectedPrompt?.question ?? pagePrompt.question;
        if (normalizedOther[questionKey] && !pagePrompt.allowOther) {
          return finish({ status: 'unknown', detail: 'other_not_on_page' }, instanceId);
        }
      }

      const decisionSource = source === 'automatic' ? 'automatic' : 'manual';
      const delegated = this.runtime.delegateBrowserAnswer(
        matchedCandidate.id,
        normalizedAnswers,
        Object.keys(normalizedOther).length ? normalizedOther : undefined,
        decisionSource,
      );
      if (!delegated) {
        return finish({ status: 'unknown', detail: 'not_claimed' }, instanceId);
      }

      const delegatedAt = this.clock();
      let claimedAt: number | null = null;
      while (true) {
        const state = this.runtime.browserState(matchedCandidate.id);
        const now = this.clock();
        if (state?.browserSubmittedAt) {
          return finish({ status: 'submitted' }, instanceId);
        }
        if (!state || state.state === 'unknown' || (state.state === 'resolved' && !state.browserSubmittedAt)) {
          this.runtime.cancelBrowserDecision?.(matchedCandidate.id);
          return finish({ status: 'unknown', detail: 'page_unknown' }, instanceId);
        }
        if (claimedAt === null) {
          if (state.state === 'submitted') {
            claimedAt = now;
          } else if (!state.queued) {
            this.runtime.cancelBrowserDecision?.(matchedCandidate.id);
            return finish({ status: 'unknown', detail: 'not_claimed' }, instanceId);
          } else if (now - delegatedAt >= this.claimTimeoutMs) {
            this.runtime.cancelBrowserDecision?.(matchedCandidate.id);
            return finish({ status: 'unknown', detail: 'not_claimed' }, instanceId);
          }
        } else if (now - claimedAt >= this.receiptTimeoutMs) {
          this.lateWatchers.set(dedupKey, {
            candidateId: matchedCandidate.id,
            instanceId,
            entry: auditEntry,
          });
          return finish({ status: 'unknown', detail: 'no_receipt' }, instanceId);
        }
        await this.sleep(this.pollIntervalMs);
      }
    };

    const createdAt = this.clock();
    const promise = execute();
    this.dedup.set(dedupKey, { expected: structuredClone(request.expected), digest: summary.digest, promise, at: createdAt });
    this.pruneDedup(createdAt);
    return promise;
  };
}
