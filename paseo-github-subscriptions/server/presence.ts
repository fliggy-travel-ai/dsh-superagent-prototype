import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import { PresenceSettingsSchema, QuestionSchema, type PresenceSettings, type PresenceObservation, type PresenceSnapshot, type Question, type QuestionAnswer, type QuestionPrompt, type QuestionRead, type BrowserQuestion, type BrowserDecision } from '../shared/presence.ts';
import { atomicWrite } from './storage.ts';
import { CLOUD_SESSION_LABEL, CLOUD_SESSION_PROVIDER_ID } from '../shared/cloud-session.ts';
import { CLOUD_MANUAL_REQUEST_MARKER } from './cloud-session/index.ts';
import { SPEECH_COOLDOWN_MS, SpeechEventSchema, type SpeechResult } from '../shared/speech.ts';
import { automaticAnswerBlockReason, browserQuestionMatchesPrompts, nativePrompts, nativeResponse, questionFingerprint, recommendedAnswers, validateAnswers } from './questions.ts';
import type { WebRequestLedger } from './web-request/ledger.ts';

export interface QuestionAgent {
  id: string;
  title: string | null;
  provider?: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  pendingPermissions: AgentPermissionRequest[];
}
export interface PresencePort {
  list(): Promise<QuestionAgent[]>;
  refresh(id: string): Promise<QuestionAgent | null>;
  respond(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<unknown>;
  observe(hostId: string | null): Promise<PresenceObservation>;
  speak(hostId: string | null, id: string, text: string): Promise<SpeechResult>;
  cancelSpeech(hostId: string | null, id: string): Promise<unknown>;
  hosts(): Promise<PresenceSnapshot['hosts']>;
}
export interface BrowserQuestionResult { id: string; sessionId: string; fingerprint: string; status: 'submitted' | 'unknown' }
const StateSchema = z.object({ settings: PresenceSettingsSchema, questions: z.array(QuestionSchema), notified: z.array(z.string()), speech: z.array(SpeechEventSchema).default([]), speechRetryAt: z.number().default(0) });
const unavailable = (): PresenceObservation => ({ mode: 'unknown', observedAt: null, reason: '在场状态不可用，请选择在线或离线', source: 'unavailable' });
const browserKey = (instanceId: string, question: Pick<BrowserQuestion, 'id' | 'sessionId' | 'fingerprint'>) => `browser:${questionFingerprint([instanceId, question.sessionId, question.id, question.fingerprint])}`;
const nativeKey = (agentId: string, requestId: string) => `native:${questionFingerprint([agentId, requestId])}`;

function toInternalSessionId(raw: string): string | null {
  if (raw.startsWith('cse_') && raw.length > 4) return raw.slice(4);
  if (raw.startsWith('session_') && raw.length > 8) return raw.slice(8);
  return raw || null;
}
function toWebSessionId(raw: string): string | null {
  const internal = toInternalSessionId(raw);
  return internal ? `session_${internal}` : null;
}
function sameSessionId(left: string, right: string): boolean {
  const a = toInternalSessionId(left);
  const b = toInternalSessionId(right);
  return Boolean(a && b && a === b);
}
function isCloudRequest(request?: AgentPermissionRequest, agent?: QuestionAgent | null): boolean {
  return Boolean(
    request?.provider === CLOUD_SESSION_PROVIDER_ID ||
    agent?.provider === CLOUD_SESSION_PROVIDER_ID ||
    request?.metadata?.[CLOUD_MANUAL_REQUEST_MARKER] === true ||
    typeof request?.metadata?.webSessionId === 'string',
  );
}
function cloudRequestWebSessionId(request?: AgentPermissionRequest, agent?: QuestionAgent | null): string | null {
  if (typeof request?.metadata?.webSessionId === 'string') return toWebSessionId(request.metadata.webSessionId);
  const label = agent?.labels?.[CLOUD_SESSION_LABEL];
  if (typeof label === 'string') return toWebSessionId(label);
  return null;
}
function cloudRequestToolUseId(request: AgentPermissionRequest): string {
  return typeof request.metadata?.toolUseId === 'string' && request.metadata.toolUseId ? request.metadata.toolUseId : request.id;
}

export class PresenceRuntime {
  private state = StateSchema.parse({ settings: {}, questions: [], notified: [] });
  private observation = unavailable();
  private hostList: PresenceSnapshot['hosts'] = [];
  private error: string | null = null;
  private speechError: string | null = null;
  private stopped = false;
  private generation = 0;
  private configuring = 0;
  private activeAnswers = new Map<string, Promise<PresenceSnapshot>>();
  private notifications = new Set<Promise<void>>();
  private browserSyncs = new Map<string, Promise<BrowserDecision[]>>();
  private writes: Promise<unknown> = Promise.resolve();
  private cycle: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private native = new Map<string, { request: AgentPermissionRequest; agent: QuestionAgent; prompts: QuestionPrompt[] }>();
  private cloudSessionIds = new Set<string>();
  private observedSessions = new Map<string, Set<string>>();
  private browser = new Map<string, { question: BrowserQuestion; seen: number }>();
  private decisions = new Map<string, { decision: BrowserDecision; generation: number; automatic: boolean; delegated?: boolean }>();
  private directory: string;
  private port: PresencePort;
  private clock: () => number;
  private ledger?: WebRequestLedger;
  private speaking: { id: string; hostId: string | null; mode: PresenceSettings['mode']; cancelling: boolean } | null = null;
  constructor(directory: string, port: PresencePort, clock = Date.now, ledger?: WebRequestLedger) {
    this.directory = directory; this.port = port; this.clock = clock; this.ledger = ledger;
  }
  private findMatchingCloudNativeId(question: Pick<Question, 'sessionId' | 'prompts' | 'pages' | 'toolUseId'>): string | undefined {
    for (const [nativeId, entry] of this.native) {
      if (!isCloudRequest(entry.request, entry.agent)) continue;
      const webSessionId = cloudRequestWebSessionId(entry.request, entry.agent);
      if (!webSessionId || !sameSessionId(webSessionId, question.sessionId)) continue;
      const toolUseId = cloudRequestToolUseId(entry.request);
      if (browserQuestionMatchesPrompts(entry.prompts, question, toolUseId)) return nativeId;
    }
    return undefined;
  }
  private isCloudBrowserQuestion(sessionId: string): boolean {
    const internal = toInternalSessionId(sessionId);
    return Boolean(internal && this.cloudSessionIds.has(internal));
  }
  private reviewSpeech() {
    const current = this.speaking;
    if (!current || current.cancelling) return;
    const settings = this.state.settings;
    const question = this.state.questions.find(item => item.id === current.id);
    const wanted = !this.stopped && settings.speechEnabled && !settings.paused && settings.mode === current.mode && settings.sourceHostId === current.hostId
      && question?.state === 'pending' && !question.delegatedTo;
    if (wanted) return;
    current.cancelling = true;
    void this.port.cancelSpeech(current.hostId, current.id).catch(() => {});
  }
  private persist(change: (next: typeof this.state) => void) {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state); change(next);
      const retained = (question: Question) => question.state !== 'resolved' || question.answer?.source === 'automatic' && !question.answer.readAt;
      const finished = next.questions.filter(question => !retained(question)).slice(-100);
      next.questions = [...finished, ...next.questions.filter(retained)];
      next.notified = next.notified.filter(id => next.questions.some(question => question.id === id));
      await atomicWrite(join(this.directory, 'presence.json'), JSON.stringify(next)); this.state = next;
      this.reviewSpeech();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = StateSchema.parse(JSON.parse(await readFile(join(this.directory, 'presence.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('在线离线配置读取失败'); }
    const lastSpeech = this.state.speech.at(-1);
    this.speechError = lastSpeech && !lastSpeech.played && !lastSpeech.cancelled ? lastSpeech.detail ?? '上次语音未确认播放' : null;
    await this.persist(next => { for (const question of next.questions) if (question.state === 'submitted') { question.state = 'unknown'; question.reason = '插件重启，提交结果未确认；请在原会话检查'; } });
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => void this.refresh(), 5000);
  }
  snapshot(): PresenceSnapshot { return structuredClone({ settings: this.state.settings, observation: this.observation, questions: this.state.questions, speech: this.state.speech, hostName: hostname(), hosts: this.hostList, error: [this.error, this.speechError].filter(Boolean).join('；') || null }); }
  async markRead(input: QuestionRead): Promise<PresenceSnapshot> {
    if (this.stopped) throw new Error('问答服务已停止，请稍后再试');
    await this.persist(next => {
      const question = next.questions.find(question => question.id === input.id);
      if (!question || question.fingerprint !== input.fingerprint) throw new Error('问题已变化，请刷新待办');
      if (question.state !== 'resolved' || question.answer?.source !== 'automatic') throw new Error('只能将已完成的代答标为已读');
      question.answer.readAt ??= new Date().toISOString();
    });
    return this.snapshot();
  }
  async configure(value: PresenceSettings) {
    if (this.configuring) throw new Error('设置正在保存，请稍后重试');
    const settings = PresenceSettingsSchema.parse(value); this.generation++; this.configuring++;
    const cancelled = new Set(this.decisions.keys()); this.decisions.clear();
    try { await this.persist(next => { next.settings = settings; for (const question of next.questions) if (cancelled.has(question.id) && question.state === 'pending') question.reason = '模式已变化，排队回答已取消'; }); }
    finally { this.configuring--; }
    await this.refresh(); return this.snapshot();
  }
  async changeBluetoothTarget<Result>(hostId: string | null, sameHost: (left: string | null, right: string | null) => boolean, save: () => Promise<Result>): Promise<Result> {
    if (!sameHost(hostId, this.state.settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
    if (this.configuring) throw new Error('设置正在保存，请稍后重试');
    this.generation++; this.configuring++;
    this.decisions.clear();
    this.observation = { mode: 'unknown', observedAt: null, reason: '设备正在切换，等待来源主机采样', source: 'bluetooth' };
    try { return await save(); }
    finally {
      this.generation++;
      this.observation = { mode: 'unknown', observedAt: null, reason: '设备正在切换，等待来源主机采样', source: 'bluetooth' };
      this.configuring--;
      await this.refresh();
    }
  }
  private async observe() {
    const settings = this.state.settings;
    const generation = this.generation;
    if (settings.mode !== 'auto') this.observation = { mode: settings.mode, observedAt: new Date().toISOString(), source: 'manual', reason: settings.mode === 'online' ? '手动在线：语音提醒，等待回答' : '手动离线：选择明确推荐项' };
    else {
      try {
        const result = await this.port.observe(settings.sourceHostId);
        if (generation === this.generation) this.observation = result.observedAt && Date.now() - Date.parse(result.observedAt) < 120_000 && Date.parse(result.observedAt) <= Date.now() + 5000 ? result : unavailable();
      } catch { if (generation === this.generation) this.observation = unavailable(); }
    }
  }
  private async upsert(question: Question) {
    const previous = this.state.questions.find(item => item.id === question.id);
    if (previous?.fingerprint === question.fingerprint && previous.title === question.title && previous.url === question.url && previous.delegatedTo === question.delegatedTo) return;
    await this.persist(next => {
      const current = next.questions.find(item => item.id === question.id);
      if (current?.fingerprint === question.fingerprint) {
        current.title = question.title;
        current.url = question.url;
        if (question.delegatedTo) current.delegatedTo = question.delegatedTo;
      } else {
        next.questions = next.questions.filter(item => item.id !== question.id);
        next.questions.push(question);
      }
    });
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cycle) return this.cycle;
    this.cycle = this.scan().catch(() => { this.error = '问答同步失败，保留问题等待处理'; }).finally(() => { this.cycle = null; });
    return this.cycle;
  }
  private async scan() {
    const generation = this.generation;
    await this.observe();
    this.hostList = await this.port.hosts().catch(() => this.hostList);
    const agents = await this.port.list(); this.error = null;
    const present = new Set<string>(); this.native.clear();
    const nextCloudIds = new Set<string>();
    for (const agent of agents.filter(agent => !agent.archivedAt)) {
      if (agent.provider === CLOUD_SESSION_PROVIDER_ID || typeof agent.labels?.[CLOUD_SESSION_LABEL] === 'string') {
        const id = agent.labels?.[CLOUD_SESSION_LABEL] ? toInternalSessionId(agent.labels[CLOUD_SESSION_LABEL]) : null;
        if (id) nextCloudIds.add(id);
      }
      for (const request of agent.pendingPermissions) {
        if (typeof request.metadata?.webSessionId === 'string') {
          const id = toInternalSessionId(request.metadata.webSessionId);
          if (id) nextCloudIds.add(id);
        }
        const prompts = nativePrompts(request); if (!prompts) continue;
        const id = nativeKey(agent.id, request.id); present.add(id); this.native.set(id, { request, agent, prompts });
        await this.upsert({ id, source: 'native', sessionId: agent.id, fingerprint: questionFingerprint(request), prompts, title: agent.title || '未命名 Paseo 会话', at: new Date().toISOString(), state: 'pending', reason: '等待回答' });
      }
    }
    this.cloudSessionIds = nextCloudIds;
    await this.persist(next => { for (const question of next.questions) {
      if (question.source === 'native' && !present.has(question.id) && question.state !== 'resolved' && !this.activeAnswers.has(question.id)) {
        question.reason = question.state === 'pending'
          ? '原会话不再等待此问题'
          : question.reason === '已交给浏览器执行，等待云端确认'
            ? '云端已记录结果'
            : '原会话已结束此提问，回答是否生效未确认';
        question.state = 'resolved';
      }
      if (question.source === 'browser' && !question.delegatedTo) {
        const match = this.findMatchingCloudNativeId(question);
        if (match) question.delegatedTo = match;
      }
      if (question.source === 'browser' && question.state === 'submitted' && Date.now() - Date.parse(question.at) > 30_000) { question.state = 'unknown'; question.reason = '网页未确认提交结果，请在原网页检查'; }
    } });
    if (generation !== this.generation || this.stopped) return;
    for (const question of this.state.questions.filter(item => item.state === 'pending')) await this.processSafely(question, generation);
  }
  private async processSafely(question: Question, generation: number) {
    try { await this.process(question, generation); }
    catch { this.error = '部分问题暂时无法处理，请打开原会话核查'; }
  }
  private async process(question: Question, generation: number) {
    if (this.stopped || this.configuring || this.state.settings.paused || generation !== this.generation || this.decisions.has(question.id) || this.activeAnswers.has(question.id)) return;
    if (question.delegatedTo) return;
    if (question.source === 'browser' && Date.now() - (this.browser.get(question.id)?.seen ?? 0) > 60_000) return;
    if (question.source === 'browser' && question.pages && question.pages > 1) {
      const reason = '多题提问，请在 Paseo 云端提问或 claude.ai 作答';
      if (question.reason !== reason) await this.persist(next => { const item = next.questions.find(item => item.id === question.id); if (item) item.reason = reason; });
      return;
    }
    const cloudBrowser = question.source === 'browser' && this.isCloudBrowserQuestion(question.sessionId);
    const answers = recommendedAnswers(question.prompts);
    if (!cloudBrowser && this.observation.mode === 'offline' && answers) { await this.answer({ id: question.id, answers }, true); return; }
    const reason = (cloudBrowser ? '云端会话提问，等待同步到 Paseo；只接受人工回答' : automaticAnswerBlockReason(question.prompts)) ?? (this.observation.mode === 'offline' ? '没有唯一明确的推荐项，请人工选择' : this.observation.mode === 'unknown' ? '在场状态未知，等待用户回答' : '在线：等待用户回答');
    if (question.reason !== reason) await this.persist(next => { const item = next.questions.find(item => item.id === question.id); if (item) item.reason = reason; });
    if (this.observation.mode === 'online' && this.state.settings.speechEnabled && !this.state.notified.includes(question.id) && !this.notifications.size && this.clock() >= this.state.speechRetryAt) {
      const hostId = this.state.settings.sourceHostId;
      const speaking = { id: question.id, hostId, mode: this.state.settings.mode, cancelling: false };
      const current = () => !this.stopped && !speaking.cancelling && generation === this.generation && this.state.settings.sourceHostId === hostId && this.state.settings.speechEnabled && !this.state.settings.paused;
      const record = (receipt: SpeechResult, own: boolean) => this.persist(next => {
        if (receipt.played && !next.notified.includes(question.id)) next.notified.push(question.id);
        if (own) next.speechRetryAt = receipt.retryAt ?? this.clock() + SPEECH_COOLDOWN_MS;
        next.speech.push({ ...receipt, id: question.id, hostId, at: new Date().toISOString() }); next.speech = next.speech.slice(-50);
      });
      const notification = Promise.resolve().then(() => {
        if (this.stopped || this.configuring || generation !== this.generation || this.state.settings.paused || !this.state.settings.speechEnabled || this.state.questions.find(item => item.id === question.id)?.state !== 'pending') return null;
        this.speaking = speaking;
        return this.port.speak(hostId, question.id, `注意，${question.title.slice(0, 80)}，有一个问题等待你确认。`);
      })
        .then(async receipt => {
          if (receipt === null) return;
          const own = !receipt.cancelled && current();
          if (own) this.speechError = receipt.played ? null : receipt.detail || '语音尚未播放，稍后重试';
          await record(receipt, own);
        })
        .catch(async () => {
          const own = current();
          const detail = own ? '未收到语音播放回执，稍后核对；请查看人工待办' : '设置已变化，旧语音请求已取消';
          if (own) this.speechError = detail;
          await record({ played: false, cancelled: !own || undefined, detail }, own).catch(() => { if (own) this.speechError = '语音播放及记录未确认，请查看人工待办'; });
        }).finally(() => { if (this.speaking === speaking) this.speaking = null; this.notifications.delete(notification); });
      this.notifications.add(notification);
    }
  }
  browserSync(instanceId: string, questions: BrowserQuestion[], results: BrowserQuestionResult[], sessions: { sessionId: string; title: string; url: string }[], observedSessionIds: string[] = []): Promise<BrowserDecision[]> {
    const previous = this.browserSyncs.get(instanceId) ?? Promise.resolve([]);
    const operation = previous.catch(() => []).then(() => this.syncBrowser(instanceId, questions, results, sessions, observedSessionIds)).finally(() => { if (this.browserSyncs.get(instanceId) === operation) this.browserSyncs.delete(instanceId); });
    this.browserSyncs.set(instanceId, operation); return operation;
  }
  private async syncBrowser(instanceId: string, questions: BrowserQuestion[], results: BrowserQuestionResult[], sessions: { sessionId: string; title: string; url: string }[], observedSessionIds: string[]): Promise<BrowserDecision[]> {
    if (this.stopped) return [];
    const generation = this.generation;
    this.observedSessions.set(instanceId, new Set(observedSessionIds));
    for (const question of questions) {
      const session = sessions.find(session => session.sessionId === question.sessionId); if (!session) continue;
      const id = browserKey(instanceId, question); this.browser.set(id, { question, seen: Date.now() });
      const delegatedTo = this.findMatchingCloudNativeId(question);
      await this.upsert({
        ...question, id, instanceId, source: 'browser', title: session.title, url: session.url,
        at: new Date().toISOString(), state: 'pending', reason: '等待回答',
        ...(delegatedTo ? { delegatedTo } : {}),
      });
    }
    const current = new Set(questions.map(question => browserKey(instanceId, question)));
    for (const question of this.state.questions.filter(item => item.instanceId === instanceId && !current.has(item.id))) { this.browser.delete(question.id); this.decisions.delete(question.id); }
    await this.persist(next => { for (const question of next.questions.filter(item => item.instanceId === instanceId)) {
      const result = results.find(result => browserKey(instanceId, { ...question, id: result.id, fingerprint: result.fingerprint }) === question.id && result.sessionId === question.sessionId);
      if (result && (question.state === 'submitted' || question.state === 'unknown')) {
        if (result.status === 'submitted') { question.browserSubmittedAt ??= new Date().toISOString(); question.reason = '扩展已点击提交，等待网页结束提问'; }
        else { question.state = 'unknown'; question.reason = '网页回答结果未知，请在原网页检查'; }
      }
      const observed = observedSessionIds.includes(question.sessionId) && sessions.some(session => session.sessionId === question.sessionId);
      if (observed && !current.has(question.id) && question.state !== 'resolved') { question.reason = question.state === 'unknown' ? '网页已结束此提问，回答是否生效未确认' : '网页已结束此提问'; question.state = 'resolved'; }
    } });
    await this.observe();
    if (generation !== this.generation || this.stopped) return [];
    for (const question of this.state.questions.filter(item => item.instanceId === instanceId && current.has(item.id) && item.state === 'pending')) await this.processSafely(question, generation);
    const decisions: BrowserDecision[] = [];
    for (const [id, entry] of this.decisions) {
      if (!current.has(id)) continue;
      this.decisions.delete(id);
      const valid = () => entry.generation === this.generation && !this.stopped && !this.configuring && (!entry.automatic || !this.state.settings.paused && (entry.delegated || this.observation.mode === 'offline'));
      if (!valid()) continue;
      let reserved = false;
      await this.persist(next => {
        const item = next.questions.find(question => question.id === id);
        if (valid() && item?.state === 'pending') {
          item.state = 'submitted'; item.at = new Date().toISOString(); item.reason = '回答已下发，等待浏览器确认';
          item.answer = {
            source: entry.automatic ? 'automatic' : 'user',
            answers: structuredClone(entry.decision.answers),
            ...(entry.decision.otherAnswers ? { otherAnswers: structuredClone(entry.decision.otherAnswers) } : {}),
          };
          reserved = true;
        }
      });
      if (reserved && valid()) decisions.push({ ...entry.decision, expiresAt: Date.now() + 5000 });
      else if (reserved) await this.persist(next => { const item = next.questions.find(question => question.id === id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未下发'; } });
    }
    if (generation !== this.generation || this.stopped || this.configuring) {
      await this.persist(next => { for (const decision of decisions) { const item = next.questions.find(question => question.id === browserKey(instanceId, decision)); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未下发'; } } });
      return [];
    }
    return decisions;
  }
  browserCandidates(instanceId: string, sessionId: string) {
    const observed = this.isSessionObserved(instanceId, sessionId);
    const candidates: Array<{ id: string; question: BrowserQuestion; seen: number; state: Question['state']; observed: boolean }> = [];
    for (const item of this.state.questions) {
      if (item.source !== 'browser' || item.instanceId !== instanceId || !sameSessionId(item.sessionId, sessionId)) continue;
      const live = this.browser.get(item.id);
      if (!live) continue;
      candidates.push({ id: item.id, question: structuredClone(live.question), seen: live.seen, state: item.state, observed });
    }
    return candidates;
  }
  isSessionObserved(instanceId: string, sessionId: string): boolean {
    const set = this.observedSessions.get(instanceId);
    if (!set) return false;
    for (const item of set) if (sameSessionId(item, sessionId)) return true;
    return false;
  }
  delegateBrowserAnswer(
    id: string,
    answers: Record<string, string[]>,
    otherAnswers?: Record<string, string>,
    source: 'automatic' | 'manual' = 'manual',
  ): boolean {
    if (this.stopped || this.configuring || (source === 'automatic' && this.state.settings.paused)) return false;
    const original = this.browser.get(id);
    const question = this.state.questions.find(item => item.id === id);
    if (!original || !question || question.state !== 'pending') return false;
    this.decisions.set(id, {
      generation: this.generation,
      automatic: source === 'automatic',
      delegated: true,
      decision: {
        id: original.question.id,
        sessionId: original.question.sessionId,
        fingerprint: original.question.fingerprint,
        answers: structuredClone(answers),
        ...(otherAnswers && Object.keys(otherAnswers).length ? { otherAnswers: structuredClone(otherAnswers) } : {}),
        source,
        expiresAt: 0,
      },
    });
    return true;
  }
  cancelBrowserDecision(id: string): void {
    this.decisions.delete(id);
  }
  browserState(id: string): {
    state: Question['state'];
    queued: boolean;
    claimedAt?: string;
    browserSubmittedAt?: string;
    reason: string;
  } | null {
    const question = this.state.questions.find(item => item.id === id);
    if (!question || question.source !== 'browser') return null;
    return {
      state: question.state,
      queued: this.decisions.has(id),
      ...(question.state !== 'pending' ? { claimedAt: question.at } : {}),
      ...(question.browserSubmittedAt ? { browserSubmittedAt: question.browserSubmittedAt } : {}),
      reason: question.reason,
    };
  }
  answer(input: QuestionAnswer, automatic = false): Promise<PresenceSnapshot> {
    if (this.stopped || this.configuring) return Promise.reject(new Error('问答服务正在切换，请稍后再试'));
    if (this.activeAnswers.has(input.id) || this.decisions.has(input.id)) return Promise.reject(new Error('回答已排队，请等待浏览器同步'));
    const operation = this.performAnswer(input, automatic).finally(() => { this.activeAnswers.delete(input.id); });
    this.activeAnswers.set(input.id, operation);
    return operation;
  }
  private async performAnswer(input: QuestionAnswer, automatic: boolean) {
    const generation = this.generation;
    const question = this.state.questions.find(item => item.id === input.id);
    if (!question || question.state !== 'pending') throw new Error('此问题已处理或结果待核实，请打开原会话');
    if (question.source === 'browser' && question.pages && question.pages > 1) throw new Error('多题提问，请在 Paseo 云端提问或 claude.ai 作答');
    validateAnswers(question.prompts, input.answers, input.otherAnswers);
    if (automatic && (input.otherAnswers && Object.keys(input.otherAnswers).length || automaticAnswerBlockReason(question.prompts))) return this.snapshot();
    if (automatic && (this.stopped || this.state.settings.paused || this.observation.mode !== 'offline')) return this.snapshot();
    let request: AgentPermissionRequest | undefined;
    let agent: QuestionAgent | null = null;
    if (question.source === 'native') {
      agent = await this.port.refresh(question.sessionId);
      request = agent && !agent.archivedAt ? agent.pendingPermissions.find(item => item.id === this.native.get(question.id)?.request.id) : undefined;
      if (!request || questionFingerprint(request) !== question.fingerprint) throw new Error('原会话的问题已经变化');
      const cloud = isCloudRequest(request, agent);
      nativeResponse(cloud ? { ...request, provider: CLOUD_SESSION_PROVIDER_ID } : request, input.answers, input.otherAnswers);
    } else {
      if (automatic && this.isCloudBrowserQuestion(question.sessionId)) return this.snapshot();
      const original = this.browser.get(question.id);
      if (!original || Date.now() - original.seen > 60_000) throw new Error('网页已断开，请打开原网页回答');
      await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item?.state === 'pending') item.reason = '回答已排队，等待浏览器同步'; });
      if (!this.stopped && !this.configuring && generation === this.generation && this.state.questions.find(item => item.id === input.id)?.state === 'pending') {
        this.decisions.set(question.id, {
          generation,
          automatic,
          decision: {
            id: original.question.id,
            sessionId: original.question.sessionId,
            fingerprint: original.question.fingerprint,
            answers: structuredClone(input.answers),
            ...(input.otherAnswers && Object.keys(input.otherAnswers).length ? { otherAnswers: structuredClone(input.otherAnswers) } : {}),
            source: automatic ? 'automatic' : 'manual',
            expiresAt: 0,
          },
        });
      }
      return this.snapshot();
    }
    const cleanOther = input.otherAnswers
      ? Object.fromEntries(Object.entries(input.otherAnswers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
      : undefined;
    await this.persist(next => {
      const item = next.questions.find(item => item.id === input.id);
      if (!item || item.state !== 'pending') throw new Error('此问题正在处理');
      item.state = 'submitted'; item.at = new Date().toISOString(); item.reason = '回答已准备，等待提交确认';
      item.answer = {
        source: automatic ? 'automatic' : 'user',
        answers: structuredClone(input.answers),
        ...(cleanOther && Object.keys(cleanOther).length ? { otherAnswers: cleanOther } : {}),
      };
    });
    if (this.stopped || this.configuring || generation !== this.generation || automatic && (this.state.settings.paused || this.observation.mode !== 'offline')) {
      await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未提交'; } });
      return this.snapshot();
    }
    try {
      if (request) {
        const latest = await this.port.refresh(question.sessionId);
        const current = latest && !latest.archivedAt ? latest.pendingPermissions.find(item => item.id === request!.id) : undefined;
        if (this.stopped || this.configuring || generation !== this.generation || !current || questionFingerprint(current) !== question.fingerprint || automatic && (this.state.settings.paused || this.observation.mode !== 'offline')) {
          await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '问题或模式已变化，尚未提交'; } });
          return this.snapshot();
        }
        const cloud = isCloudRequest(current, latest);
        if (cloud && this.ledger) {
          const webSessionId = cloudRequestWebSessionId(current, latest);
          const toolUseId = cloudRequestToolUseId(current);
          if (webSessionId) {
            this.ledger.record({
              webSessionId,
              toolUseId,
              answers: input.answers,
              ...(cleanOther && Object.keys(cleanOther).length ? { otherAnswers: cleanOther } : {}),
              source: automatic ? 'automatic' : 'user',
            });
          }
        }
        const response = nativeResponse(cloud ? { ...current, provider: CLOUD_SESSION_PROVIDER_ID } : current, input.answers, cleanOther);
        await this.port.respond(question.sessionId, request.id, response);
        await this.persist(next => {
          const item = next.questions.find(item => item.id === input.id);
          if (item) {
            if (cloud) {
              item.state = 'submitted';
              item.reason = '已交给浏览器执行，等待云端确认';
            } else {
              item.state = 'resolved';
              item.reason = '宿主已确认接收回答';
            }
          }
        });
      }
    } catch {
      await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item) { item.state = 'unknown'; item.reason = '未收到回答回执，请在原会话检查；不会自动重试'; } });
    }
    return this.snapshot();
  }
  async stop() { this.stopped = true; this.generation++; this.reviewSpeech(); clearInterval(this.timer); this.decisions.clear(); await this.cycle; await Promise.allSettled([...this.browserSyncs.values(), ...this.activeAnswers.values(), ...this.notifications]); await this.writes; }
}
