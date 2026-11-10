import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import { PresenceSettingsSchema, QuestionSchema, type PresenceSettings, type PresenceObservation, type PresenceSnapshot, type Question, type QuestionAnswer, type QuestionPrompt, type BrowserQuestion, type BrowserDecision } from '../shared/presence.ts';
import { atomicWrite } from './storage.ts';
import { CLOUD_SESSION_LABEL, CLOUD_SESSION_PROVIDER_ID } from '../shared/cloud-session.ts';
import { CLOUD_MANUAL_REQUEST_MARKER } from './cloud-session/index.ts';
import { SPEECH_COOLDOWN_MS, SpeechEventSchema, type SpeechResult } from '../shared/speech.ts';
import { browserQuestionMatchesPrompts, nativePrompts, nativeResponse, ownerOnlyReason, questionFingerprint, validateAnswers } from './questions.ts';
import type { WebRequestLedger } from './web-request/ledger.ts';
import { webRequestDetailReason, type CloudRequestOutcome, type WebRequestResult } from '../shared/web-request.ts';

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
  selfId?(): string | null;
  remoteSpeechEnabled?(hostId: string): Promise<boolean>;
  remoteSpeechState?(hostId: string): Promise<{ enabled: boolean; configured: boolean }>;
  enqueueExternal?(question: Question): void;
  closeExternal?(id: string): void;
  ownerOnlyKeywords?(): readonly string[];
}

export function isMissingRpcMethodError(error: unknown): boolean {
  if (error && typeof error === 'object' && error.constructor?.name === 'DeadlineError') return false;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/(?:timeout|timed out|超时|offline|离线|disconnected|transport|socket|connection|not connected|closed)/i.test(msg)) {
    return false;
  }
  return /does not contribute RPC|method not found|unknown (?:plugin )?(?:rpc|method)|no handler|unregistered|未知调用|未知接口|未注册|未实现/i.test(msg);
}
export interface BrowserQuestionResult { id: string; sessionId: string; fingerprint: string; status: 'submitted' | 'unknown' }
const StateSchema = z.object({ settings: PresenceSettingsSchema, localSpeechEnabled: z.boolean().optional(), questions: z.array(QuestionSchema), notified: z.array(z.string()), speech: z.array(SpeechEventSchema).default([]), speechRetryAt: z.number().default(0) });
const unavailable = (): PresenceObservation => ({ mode: 'unknown', observedAt: null, reason: '在场状态不可用，请选择在线或离线', source: 'unavailable' });
const REMOTE_SPEECH_CACHE_TTL_MS = 60_000;
type RemoteSpeechProbeOutcome =
  | { kind: 'state'; enabled: boolean; configured: boolean }
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'missing' }
  | { kind: 'unreachable' };
function immediateObservation(
  settings: PresenceSettings,
  previousSettings?: PresenceSettings,
  currentObservation?: PresenceObservation,
): PresenceObservation {
  if (settings.mode === 'online') {
    return { mode: 'online', observedAt: new Date().toISOString(), source: 'manual', reason: '手动在线：语音提醒，等待回答' };
  }
  if (settings.mode === 'offline') {
    return { mode: 'offline', observedAt: new Date().toISOString(), source: 'manual', reason: '手动离线：不播语音，通知总控' };
  }
  if (currentObservation && previousSettings?.mode === 'auto' && previousSettings.sourceHostId === settings.sourceHostId) {
    return currentObservation;
  }
  return { mode: 'unknown', observedAt: null, source: 'bluetooth', reason: '正在读取来源主机在场状态' };
}
const browserKey = (instanceId: string, question: Pick<BrowserQuestion, 'id' | 'sessionId' | 'fingerprint'>) => `browser:${questionFingerprint([instanceId, question.sessionId, question.id, question.fingerprint])}`;
const WEB_RETRY_MAX_MS = 2 * 60 * 60_000;
// 网页重试未经云端确认就结束：清掉网页提问指向它的关联标记，页面上仍在等待的提问重新回到待办。
function endWebRetry(next: { questions: Question[] }, question: Question) {
  delete question.webRetry;
  for (const item of next.questions) if (item.source === 'browser' && item.delegatedTo === question.id) delete item.delegatedTo;
}
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
  private blockingNotifications = new Set<object>();
  private hasSpeechTarget = true;
  private browserSyncs = new Map<string, Promise<BrowserDecision[]>>();
  private writes: Promise<unknown> = Promise.resolve();
  private cycle: Promise<void> | null = null;
  private rescanNeeded = false;
  private hostSignature = '';
  private remoteSpeechCacheGen = 0;
  private remoteSpeechCache = new Map<string, { outcome: RemoteSpeechProbeOutcome; expiresAt: number }>();
  private remoteSpeechInflight = new Map<string, Promise<RemoteSpeechProbeOutcome>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private native = new Map<string, { request: AgentPermissionRequest; agent: QuestionAgent; prompts: QuestionPrompt[] }>();
  private cloudSessionIds = new Set<string>();
  private observedSessions = new Map<string, Set<string>>();
  private browser = new Map<string, { question: BrowserQuestion; seen: number }>();
  private decisions = new Map<string, { decision: BrowserDecision; generation: number; delegated?: boolean }>();
  private directory: string;
  private port: PresencePort;
  private clock: () => number;
  private ledger?: WebRequestLedger;
  private speaking = new Set<{
    id: string;
    mode: PresenceSettings['mode'];
    sourceHostId: string | null;
    targets: Map<string | null, { cancelling: boolean; done: boolean }>;
  }>();
  constructor(directory: string, port: PresencePort, clock = Date.now, ledger?: WebRequestLedger) {
    this.directory = directory; this.port = port; this.clock = clock; this.ledger = ledger;
  }
  private selfHostId(): string | null {
    return this.port.selfId?.() ?? this.hostList[0]?.id ?? null;
  }
  private isSelfHost(hostId: string | null | undefined): boolean {
    if (!hostId) return true;
    const self = this.selfHostId();
    return Boolean(self && hostId === self);
  }
  localSpeechConfigured(): boolean {
    return this.state.localSpeechEnabled !== undefined;
  }
  localSpeechEnabled(): boolean {
    return this.state.localSpeechEnabled ?? this.isSelfHost(this.state.settings.sourceHostId);
  }
  private findMatchingCloudNativeId(question: Pick<Question, 'sessionId' | 'prompts' | 'pages' | 'toolUseId'>, questions: Question[] = this.state.questions): string | undefined {
    for (const [nativeId, entry] of this.native) {
      if (!isCloudRequest(entry.request, entry.agent)) continue;
      const webSessionId = cloudRequestWebSessionId(entry.request, entry.agent);
      if (!webSessionId || !sameSessionId(webSessionId, question.sessionId)) continue;
      const toolUseId = cloudRequestToolUseId(entry.request);
      if (browserQuestionMatchesPrompts(entry.prompts, question, toolUseId)) return nativeId;
    }
    // Paseo 已不再列出、但网页提交未确认的云端提问（例如页面未打开时作答，之后才打开页面）
    if (question.toolUseId) {
      const retry = questions.find(item => item.source === 'native' && item.webRetry && item.toolUseId === question.toolUseId && !!item.webSessionId && sameSessionId(item.webSessionId, question.sessionId));
      if (retry) return retry.id;
    }
    return undefined;
  }
  private isCloudBrowserQuestion(sessionId: string): boolean {
    const internal = toInternalSessionId(sessionId);
    return Boolean(internal && this.cloudSessionIds.has(internal));
  }
  private reviewSpeech() {
    if (this.speaking.size === 0) return;
    const settings = this.state.settings;
    for (const current of this.speaking) {
      const question = this.state.questions.find(item => item.id === current.id);
      const globallyWanted = !this.stopped && !settings.paused
        && settings.mode === current.mode && settings.sourceHostId === current.sourceHostId
        && question?.state === 'pending' && !question.delegatedTo;
      for (const [hostId, state] of current.targets) {
        if (state.done || state.cancelling) continue;
        const hostWanted = globallyWanted && (!this.isSelfHost(hostId) || this.localSpeechEnabled());
        if (hostWanted) continue;
        state.cancelling = true;
        void this.port.cancelSpeech(hostId, current.id).catch(() => {});
      }
    }
  }
  private persist(change: (next: typeof this.state) => void, options?: { skipIfUnchanged?: boolean }) {
    const operation = this.writes.then(async () => {
      const before = options?.skipIfUnchanged ? JSON.stringify(this.state) : null;
      const next = structuredClone(this.state); change(next);
      const retained = (question: Question) => question.state !== 'resolved';
      const finished = next.questions.filter(question => !retained(question)).slice(-100);
      next.questions = [...finished, ...next.questions.filter(retained)];
      next.notified = next.notified.filter(id => next.questions.some(question => question.id === id));
      const serialized = JSON.stringify(next);
      if (before !== null && serialized === before) return;
      await atomicWrite(join(this.directory, 'presence.json'), serialized); this.state = next;
      this.reviewSpeech();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  private invalidateRemoteSpeechCache() {
    this.remoteSpeechCacheGen += 1;
    this.remoteSpeechCache.clear();
    this.remoteSpeechInflight.clear();
  }
  private updateHostList(nextHosts: PresenceSnapshot['hosts']) {
    const signature = nextHosts.map(host => `${host.id}:${host.online ? '1' : '0'}`).join('|');
    if (signature !== this.hostSignature) {
      this.hostSignature = signature;
      this.invalidateRemoteSpeechCache();
    }
    this.hostList = nextHosts;
  }
  private async probeRemoteSpeech(hostId: string, useCache: boolean): Promise<RemoteSpeechProbeOutcome> {
    if (useCache) {
      const now = this.clock();
      const cached = this.remoteSpeechCache.get(hostId);
      if (cached && now < cached.expiresAt) return cached.outcome;
      const existing = this.remoteSpeechInflight.get(hostId);
      if (existing) return existing;
    }
    const cacheGen = this.remoteSpeechCacheGen;
    const probe = (async (): Promise<RemoteSpeechProbeOutcome> => {
      try {
        if (this.port.remoteSpeechState) {
          const state = await this.port.remoteSpeechState(hostId);
          return { kind: 'state', enabled: state.enabled, configured: state.configured };
        }
        if (this.port.remoteSpeechEnabled) {
          const enabled = await this.port.remoteSpeechEnabled(hostId);
          return { kind: 'enabled', enabled };
        }
        return { kind: 'missing' };
      } catch (error) {
        return isMissingRpcMethodError(error) ? { kind: 'missing' } : { kind: 'unreachable' };
      }
    })().finally(() => {
      if (this.remoteSpeechInflight.get(hostId) === probe) {
        this.remoteSpeechInflight.delete(hostId);
      }
    });
    if (useCache) {
      this.remoteSpeechInflight.set(hostId, probe);
    }
    const outcome = await probe;
    if (cacheGen === this.remoteSpeechCacheGen) {
      if (outcome.kind !== 'unreachable') {
        this.remoteSpeechCache.set(hostId, { outcome, expiresAt: this.clock() + REMOTE_SPEECH_CACHE_TTL_MS });
      } else {
        this.remoteSpeechCache.delete(hostId);
      }
    }
    return outcome;
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = StateSchema.parse(JSON.parse(await readFile(join(this.directory, 'presence.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('在线离线配置读取失败'); }
    const lastSpeech = this.state.speech.at(-1);
    const lastBatchPlayed = lastSpeech
      ? this.state.notified.includes(lastSpeech.id) || this.state.speech.some(item => item.id === lastSpeech.id && item.played)
      : false;
    this.speechError = lastSpeech && !lastBatchPlayed && !lastSpeech.played && !lastSpeech.cancelled ? lastSpeech.detail ?? '上次语音未确认播放' : null;
    await this.persist(next => { for (const question of next.questions) if (question.state === 'submitted') { question.state = 'unknown'; question.reason = '插件重启，提交结果未确认；请在原会话检查'; } });
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => void this.refresh(), 5000);
  }
  snapshot(): PresenceSnapshot { return structuredClone({ settings: this.state.settings, localSpeechEnabled: this.localSpeechEnabled(), hasSpeechTarget: this.hasSpeechTarget, observation: this.observation, questions: this.state.questions, speech: this.state.speech, hostName: this.hostList[0]?.name || hostname(), hosts: this.hostList, error: [this.error, this.speechError].filter(Boolean).join('；') || null }); }
  async configureLocalSpeech(enabled: boolean): Promise<PresenceSnapshot> {
    if (this.stopped) throw new Error('问答服务已停止，请稍后再试');
    const clean = z.boolean().parse(enabled);
    this.invalidateRemoteSpeechCache();
    await this.persist(next => { next.localSpeechEnabled = clean; });
    if (clean) {
      this.hasSpeechTarget = true;
      void this.refresh(true);
    } else {
      await this.updateSpeechTargetState({ refreshHosts: true, useCache: false });
    }
    return this.snapshot();
  }
  async configure(value: PresenceSettings) {
    if (this.configuring) throw new Error('设置正在保存，请稍后重试');
    const settings = PresenceSettingsSchema.parse(value);
    const previousSettings = this.state.settings;
    this.generation++; this.configuring++;
    this.invalidateRemoteSpeechCache();
    const cancelled = new Set(this.decisions.keys()); this.decisions.clear();
    try {
      await this.persist(next => { next.settings = settings; for (const question of next.questions) if (cancelled.has(question.id) && question.state === 'pending') question.reason = '模式已变化，排队回答已取消'; });
      this.generation++;
      this.observation = immediateObservation(settings, previousSettings, this.observation);
      if (this.localSpeechEnabled()) this.hasSpeechTarget = true;
    } finally {
      this.generation++;
      this.configuring--;
    }
    void this.refresh(true);
    return this.snapshot();
  }
  async changeBluetoothTarget<Result>(hostId: string | null, sameHost: (left: string | null, right: string | null) => boolean, save: () => Promise<Result>): Promise<Result> {
    if (!sameHost(hostId, this.state.settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
    if (this.configuring) throw new Error('设置正在保存，请稍后重试');
    const switchingObservation = (): PresenceObservation =>
      this.state.settings.mode === 'auto'
        ? { mode: 'unknown', observedAt: null, reason: '设备正在切换，等待来源主机采样', source: 'bluetooth' }
        : immediateObservation(this.state.settings);
    this.generation++; this.configuring++;
    this.invalidateRemoteSpeechCache();
    this.decisions.clear();
    this.observation = switchingObservation();
    try { return await save(); }
    finally {
      this.generation++;
      this.observation = switchingObservation();
      this.configuring--;
      void this.refresh(true);
    }
  }
  private async observe(generation = this.generation) {
    const settings = this.state.settings;
    if (settings.mode !== 'auto') {
      if (generation === this.generation) this.observation = immediateObservation(settings);
    } else {
      const observation = await this.observeAllHosts(settings.sourceHostId);
      if (generation === this.generation) this.observation = observation;
    }
  }
  /**
   * 自动模式（Yang 2026-11-10 口径）：任一主机识别到设备即在线；其余情况一律离线。
   * 拿不到蓝牙状态的主机（未装采样器、连不上、状态过期）视为“没识别到”，不能算在线。
   */
  private async observeAllHosts(sourceHostId: string | null): Promise<PresenceObservation> {
    const fresh = (result: PresenceObservation) => !!result.observedAt && Date.now() - Date.parse(result.observedAt) < 120_000 && Date.parse(result.observedAt) <= Date.now() + 5000;
    const targets: Array<{ id: string | null; name: string; online: boolean }> = this.hostList.length
      ? this.hostList.map(host => ({ id: host.id, name: host.name || host.id, online: host.online }))
      : [{ id: sourceHostId, name: sourceHostId ? '来源主机' : '本机', online: true }];
    if (sourceHostId && !targets.some(target => target.id === sourceHostId)) targets.push({ id: sourceHostId, name: '来源主机', online: true });
    const results = await Promise.all(targets.map(async target => {
      if (!target.online) return { target, result: { ...unavailable(), reason: '主机离线' } };
      try {
        const result = await this.port.observe(target.id);
        return { target, result: fresh(result) ? result : { ...unavailable(), reason: result.observedAt ? '状态已过期或时间异常' : result.reason } };
      } catch { return { target, result: { ...unavailable(), reason: '无法连接' } }; }
    }));
    const hosts = results.map(item => ({ name: item.target.name.slice(0, 200), mode: item.result.mode, reason: (item.result.mode === 'offline' ? '设备已离开' : item.result.reason).slice(0, 300) }));
    const present = results.filter(item => item.result.mode === 'online');
    if (present.length) {
      const first = present[0]!.result;
      return { ...first, hosts, reason: targets.length === 1 ? first.reason : `${present.map(item => item.target.name).join('、')}识别到锚定设备` };
    }
    const detail = hosts.map(host => `${host.name}：${host.reason}`).join('；');
    return {
      mode: 'offline', observedAt: new Date().toISOString(), hosts,
      source: results.some(item => item.result.source === 'bluetooth') ? 'bluetooth' : 'unavailable',
      reason: `所有主机都没识别到设备，按离线处理，通知总控（${detail}）`.slice(0, 500),
    };
  }
  private applyUpsert(next: typeof this.state, question: Question) {
    const current = next.questions.find(item => item.id === question.id);
    if (current?.fingerprint === question.fingerprint) {
      current.title = question.title;
      if (question.url !== undefined) current.url = question.url;
      else delete current.url;
      if (question.delegatedTo) current.delegatedTo = question.delegatedTo;
      if (question.webSessionId) { current.webSessionId ??= question.webSessionId; current.toolUseId ??= question.toolUseId; }
    } else {
      next.questions = next.questions.filter(item => item.id !== question.id);
      next.questions.push(question);
    }
  }
  private async upsert(question: Question) {
    const previous = this.state.questions.find(item => item.id === question.id);
    if (previous?.fingerprint === question.fingerprint && previous.title === question.title && previous.url === question.url && previous.delegatedTo === question.delegatedTo) return;
    await this.persist(next => { this.applyUpsert(next, question); });
  }
  private pendingReason(question: Question): string | null {
    if (this.decisions.has(question.id) || this.activeAnswers.has(question.id)) return null;
    if (question.delegatedTo) return null;
    if (question.source === 'browser' && Date.now() - (this.browser.get(question.id)?.seen ?? 0) > 60_000) return null;
    if (question.source === 'browser' && question.pages && question.pages > 1) {
      return '多题提问，请在 Paseo 云端提问或 claude.ai 作答';
    }
    const cloudBrowser = question.source === 'browser' && this.isCloudBrowserQuestion(question.sessionId);
    const nativeEntry = this.native.get(question.id);
    return (cloudBrowser ? '云端会话提问，等待同步到 Paseo；只接受人工回答' : ownerOnlyReason(question.prompts, {
      workspaceTitle: question.title,
      agentLabels: nativeEntry?.agent.labels,
      localKeywords: this.port.ownerOnlyKeywords?.(),
    }))
      ?? (this.observation.mode === 'offline' ? '离线：已通知总控，等待回答' : this.observation.mode === 'unknown' ? '在场状态未知，等待用户回答' : '在线：等待用户回答');
  }
  refresh(requireFresh = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cycle) {
      if (requireFresh) this.rescanNeeded = true;
      return this.cycle;
    }
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        do {
          this.rescanNeeded = false;
          await this.scan().catch(() => { this.error = '问答同步失败，保留问题等待处理'; });
        } while (this.rescanNeeded && !this.stopped);
      } finally {
        if (this.cycle === run) this.cycle = null;
        if (this.rescanNeeded && !this.stopped) {
          await this.refresh(true);
        }
      }
    })();
    this.cycle = run;
    return run;
  }
  private async scan() {
    const generation = this.generation;
    const [, , agents] = await Promise.all([
      this.observe(generation),
      this.port.hosts().then(nextHosts => { this.updateHostList(nextHosts); }, () => {}),
      this.port.list(),
    ]);
    await this.updateSpeechTargetState({ refreshHosts: false, useCache: true });
    this.error = null;
    const present = new Set<string>(); this.native.clear();
    const nextCloudIds = new Set<string>();
    const discovered: Question[] = [];
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
        const webSessionId = isCloudRequest(request, agent) ? cloudRequestWebSessionId(request, agent) : null;
        discovered.push({
          id, source: 'native', sessionId: agent.id, fingerprint: questionFingerprint(request), prompts, title: agent.title || '未命名 Paseo 会话', at: new Date().toISOString(), state: 'pending', reason: '等待回答',
          ...(webSessionId ? { webSessionId, toolUseId: cloudRequestToolUseId(request), url: `https://claude.ai/code/${webSessionId}` } : {}),
        });
      }
    }
    this.cloudSessionIds = nextCloudIds;
    const activeAgents = new Set(agents.filter(agent => !agent.archivedAt).map(agent => agent.id));
    const newlyDelegatedBrowserIds: string[] = [];
    await this.persist(next => {
      for (const item of discovered) this.applyUpsert(next, item);
      for (const question of next.questions) {
        if (question.source === 'native' && question.webRetry && !activeAgents.has(question.sessionId)) {
          question.state = 'resolved'; question.reason = '原会话已归档'; endWebRetry(next, question);
        }
        if (question.source === 'native' && question.webRetry && this.clock() - Date.parse(question.at) > WEB_RETRY_MAX_MS) {
          question.state = 'resolved'; question.reason = '超过 2 小时未确认，已自动结束；请在 claude.ai 核对结果'; endWebRetry(next, question);
        }
        if (question.source === 'native' && !question.webRetry && !present.has(question.id) && question.state !== 'resolved' && !this.activeAnswers.has(question.id)) {
          question.reason = question.state === 'pending'
            ? '原会话不再等待此问题'
            : question.reason === '已交给浏览器执行，等待云端确认'
              ? '云端已记录结果'
              : '原会话已结束此提问，回答是否生效未确认';
          question.state = 'resolved';
        }
        if (question.source === 'browser' && !question.delegatedTo) {
          const match = this.findMatchingCloudNativeId(question, next.questions);
          if (match) {
            question.delegatedTo = match;
            if (question.state !== 'resolved') newlyDelegatedBrowserIds.push(question.id);
          }
        }
        if (question.source === 'browser' && question.state === 'submitted' && Date.now() - Date.parse(question.at) > 30_000) { question.state = 'unknown'; question.reason = '网页未确认提交结果，请在原网页检查'; }
      }
      if (!this.stopped && !this.configuring && !next.settings.paused && generation === this.generation) {
        for (const question of next.questions) {
          if (question.state !== 'pending') continue;
          const nextReason = this.pendingReason(question);
          if (nextReason !== null && question.reason !== nextReason) question.reason = nextReason;
        }
      }
    }, { skipIfUnchanged: true });
    for (const id of newlyDelegatedBrowserIds) this.port.closeExternal?.(id);
    if (generation !== this.generation || this.stopped) return;
    for (const question of this.state.questions.filter(item => item.state === 'pending')) await this.processSafely(question, generation);
  }
  private async processSafely(question: Question, generation: number) {
    try { await this.process(question, generation); }
    catch { this.error = '部分问题暂时无法处理，请打开原会话核查'; }
  }
  private async updateSpeechTargetState(options: { refreshHosts?: boolean; useCache?: boolean } = {}): Promise<void> {
    if (this.localSpeechEnabled()) {
      this.hasSpeechTarget = true;
      return;
    }
    const targets = await this.resolveSpeechTargets(options);
    this.hasSpeechTarget = targets.length > 0;
  }
  private async resolveSpeechTargets(options: { refreshHosts?: boolean; useCache?: boolean } = {}): Promise<Array<string | null>> {
    const { refreshHosts = true, useCache = false } = options;
    if (refreshHosts && (this.hostList.length > 0 || this.port.selfId)) {
      const nextHosts = await this.port.hosts().catch(() => this.hostList);
      this.updateHostList(nextHosts);
    }
    const selfId = this.selfHostId();
    const targets: Array<string | null> = [];
    const seen = new Set<string>();
    if (this.localSpeechEnabled()) {
      targets.push(selfId);
      if (selfId) seen.add(selfId);
    }
    const remoteCandidates: string[] = [];
    for (const host of this.hostList) {
      if (!host.id || this.isSelfHost(host.id) || seen.has(host.id)) continue;
      seen.add(host.id);
      if (host.online) remoteCandidates.push(host.id);
    }
    if (this.hostList.length === 0 && this.state.settings.sourceHostId && !this.isSelfHost(this.state.settings.sourceHostId)) {
      remoteCandidates.push(this.state.settings.sourceHostId);
    }
    const isMySourceHost = (hostId: string) => Boolean(this.state.settings.sourceHostId && hostId === this.state.settings.sourceHostId);
    if (remoteCandidates.length > 0) {
      const checks = await Promise.all(
        remoteCandidates.map(async hostId => {
          if (!this.port.remoteSpeechState && !this.port.remoteSpeechEnabled) {
            return isMySourceHost(hostId) ? hostId : null;
          }
          const outcome = await this.probeRemoteSpeech(hostId, useCache);
          let enabled: boolean;
          if (outcome.kind === 'state') {
            enabled = outcome.configured ? outcome.enabled : isMySourceHost(hostId);
          } else if (outcome.kind === 'enabled') {
            enabled = outcome.enabled;
          } else if (outcome.kind === 'missing') {
            enabled = isMySourceHost(hostId);
          } else {
            enabled = false;
          }
          return enabled ? hostId : null;
        }),
      );
      for (const hostId of checks) {
        if (hostId) targets.push(hostId);
      }
    }
    this.hasSpeechTarget = targets.length > 0;
    return targets;
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
    const reason = this.pendingReason(question);
    if (reason !== null && question.reason !== reason) await this.persist(next => { const item = next.questions.find(item => item.id === question.id); if (item) item.reason = reason; });
    const alreadySpeaking = [...this.speaking].some(item => item.id === question.id);
    if (this.observation.mode === 'online' && !this.state.notified.includes(question.id) && !alreadySpeaking && !this.blockingNotifications.size && this.clock() >= this.state.speechRetryAt) {
      const mode = this.state.settings.mode;
      const sourceHostId = this.state.settings.sourceHostId;
      const isGlobalCurrent = () =>
        !this.stopped && generation === this.generation && this.state.settings.sourceHostId === sourceHostId
        && !this.state.settings.paused;
      const gateToken = {};
      this.blockingNotifications.add(gateToken);
      let activeSpeaking: {
        id: string;
        mode: PresenceSettings['mode'];
        sourceHostId: string | null;
        targets: Map<string | null, { cancelling: boolean; done: boolean }>;
      } | null = null;
      const notification = Promise.resolve()
        .then(async () => {
          if (this.stopped || this.configuring || generation !== this.generation || this.state.settings.paused) return;
          const qBefore = this.state.questions.find(item => item.id === question.id);
          if (qBefore?.state !== 'pending' || qBefore.delegatedTo) return;
          const rawTargets = await this.resolveSpeechTargets({ refreshHosts: true, useCache: false });
          if (this.stopped || this.configuring || generation !== this.generation || this.state.settings.paused) return;
          const qReady = this.state.questions.find(item => item.id === question.id);
          if (qReady?.state !== 'pending' || qReady.delegatedTo) return;
          const finalTargets = rawTargets.filter(hostId => !this.isSelfHost(hostId) || this.localSpeechEnabled());
          this.hasSpeechTarget = finalTargets.length > 0;
          if (finalTargets.length === 0) return;

          activeSpeaking = {
            id: question.id,
            mode,
            sourceHostId,
            targets: new Map(finalTargets.map(h => [h, { cancelling: false, done: false }])),
          };
          this.speaking.add(activeSpeaking);
          this.reviewSpeech();
          const text = `注意，${question.title.slice(0, 80)}，有一个问题等待你确认。`;

          let anyPlayed = false;
          let cooldownApplied = false;
          const bufferedOutcomes: Array<{ hostId: string | null; receipt: SpeechResult; own: boolean; at: string }> = [];

          const handleOutcome = async (o: { hostId: string | null; receipt: SpeechResult; own: boolean; at: string }) => {
            if (o.receipt.played) {
              const firstPlayed = !anyPlayed;
              anyPlayed = true;
              this.speechError = null;
              const flushed = bufferedOutcomes.splice(0, bufferedOutcomes.length);
              const applyCooldown = o.own && !cooldownApplied;
              if (applyCooldown) cooldownApplied = true;
              await this.persist(next => {
                if (!next.notified.includes(question.id)) next.notified.push(question.id);
                if (applyCooldown) {
                  next.speechRetryAt = o.receipt.retryAt ?? this.clock() + SPEECH_COOLDOWN_MS;
                }
                for (const prev of flushed) {
                  next.speech.push({ ...prev.receipt, id: question.id, hostId: prev.hostId, at: prev.at });
                }
                next.speech.push({ ...o.receipt, id: question.id, hostId: o.hostId, at: o.at });
                next.speech = next.speech.slice(-50);
              }).catch(() => {});
              if (firstPlayed) {
                this.blockingNotifications.delete(gateToken);
              }
            } else if (anyPlayed) {
              await this.persist(next => {
                next.speech.push({ ...o.receipt, id: question.id, hostId: o.hostId, at: o.at });
                next.speech = next.speech.slice(-50);
              }).catch(() => {});
            } else {
              bufferedOutcomes.push(o);
            }
          };

          await Promise.all(
            finalTargets.map(async hostId => {
              const targetState = activeSpeaking!.targets.get(hostId)!;
              if (targetState.cancelling) {
                targetState.done = true;
                await handleOutcome({
                  hostId,
                  receipt: { played: false, cancelled: true, detail: '语音播放已取消' } as SpeechResult,
                  own: false,
                  at: new Date().toISOString(),
                });
                return;
              }
              try {
                const receipt = await this.port.speak(hostId, question.id, text);
                targetState.done = true;
                const own = !receipt.cancelled && !targetState.cancelling && isGlobalCurrent() && (!this.isSelfHost(hostId) || this.localSpeechEnabled());
                await handleOutcome({ hostId, receipt, own, at: new Date().toISOString() });
              } catch {
                targetState.done = true;
                const own = !targetState.cancelling && isGlobalCurrent() && (!this.isSelfHost(hostId) || this.localSpeechEnabled());
                const detail = own ? '未收到语音播放回执，稍后核对；请查看人工待办' : '设置已变化，旧语音请求已取消';
                await handleOutcome({
                  hostId,
                  receipt: { played: false, cancelled: !own || undefined, detail } as SpeechResult,
                  own,
                  at: new Date().toISOString(),
                });
              }
            }),
          );

          if (!anyPlayed && bufferedOutcomes.length > 0) {
            const ownFailures = bufferedOutcomes.filter(o => !o.receipt.played && o.own && !o.receipt.cancelled);
            if (ownFailures.length > 0) {
              this.speechError = ownFailures.map(o => o.receipt.detail || '语音尚未播放，稍后重试')[0]!;
            }
            await this.persist(next => {
              if (ownFailures.length > 0) {
                next.speechRetryAt = Math.min(...ownFailures.map(o => o.receipt.retryAt ?? this.clock() + SPEECH_COOLDOWN_MS));
              }
              for (const o of bufferedOutcomes) {
                next.speech.push({ ...o.receipt, id: question.id, hostId: o.hostId, at: o.at });
              }
              next.speech = next.speech.slice(-50);
            }).catch(() => {
              if (ownFailures.length > 0) this.speechError = '语音播放及记录未确认，请查看人工待办';
            });
          }
        })
        .finally(() => {
          if (activeSpeaking) this.speaking.delete(activeSpeaking);
          this.blockingNotifications.delete(gateToken);
          this.notifications.delete(notification);
        });
      this.notifications.add(notification);
    }
  }
  browserSync(instanceId: string, questions: BrowserQuestion[], results: BrowserQuestionResult[], sessions: { sessionId: string; title: string; url: string }[], observedSessionIds: string[] = [], options: { deadline?: number } = {}): Promise<BrowserDecision[]> {
    const previous = this.browserSyncs.get(instanceId) ?? Promise.resolve([]);
    const operation = previous.catch(() => []).then(() => this.syncBrowser(instanceId, questions, results, sessions, observedSessionIds, options.deadline)).finally(() => { if (this.browserSyncs.get(instanceId) === operation) this.browserSyncs.delete(instanceId); });
    this.browserSyncs.set(instanceId, operation); return operation;
  }
  // deadline：扩展等待同步响应的时间有限（5 秒）。超过截止时间才算出的答案不标记“已下发”，留到下一次同步，
  // 否则响应被扩展放弃后答案就丢失了（#1704 评论 6732374037）。
  private async syncBrowser(instanceId: string, questions: BrowserQuestion[], results: BrowserQuestionResult[], sessions: { sessionId: string; title: string; url: string }[], observedSessionIds: string[], deadline?: number): Promise<BrowserDecision[]> {
    if (this.stopped) return [];
    const generation = this.generation;
    this.observedSessions.set(instanceId, new Set(observedSessionIds));
    for (const question of questions) {
      const session = sessions.find(session => session.sessionId === question.sessionId); if (!session) continue;
      const id = browserKey(instanceId, question); this.browser.set(id, { question, seen: Date.now() });
      const prev = this.state.questions.find(item => item.id === id);
      const prevOpenExternal = Boolean(prev && prev.state !== 'resolved' && !prev.delegatedTo);
      const prevSamePending = Boolean(prev && prev.state === 'pending' && prev.fingerprint === question.fingerprint && !prev.delegatedTo);
      const delegatedTo = this.findMatchingCloudNativeId(question);
      await this.upsert({
        ...question, id, instanceId, source: 'browser', title: session.title, url: session.url,
        at: new Date().toISOString(), state: 'pending', reason: '等待回答',
        ...(delegatedTo ? { delegatedTo } : {}),
      });
      const stored = this.state.questions.find(item => item.id === id);
      if (stored?.delegatedTo) {
        if (prevOpenExternal) this.port.closeExternal?.(id);
      } else if (stored && stored.state === 'pending' && !prevSamePending) {
        this.port.enqueueExternal?.(stored);
      }
    }
    const current = new Set(questions.map(question => browserKey(instanceId, question)));
    for (const question of this.state.questions.filter(item => item.instanceId === instanceId && !current.has(item.id))) { this.browser.delete(question.id); this.decisions.delete(question.id); }
    const closedExternalIds: string[] = [];
    await this.persist(next => { for (const question of next.questions.filter(item => item.instanceId === instanceId)) {
      const result = results.find(result => browserKey(instanceId, { ...question, id: result.id, fingerprint: result.fingerprint }) === question.id && result.sessionId === question.sessionId);
      if (result && (question.state === 'submitted' || question.state === 'unknown')) {
        if (result.status === 'submitted') { question.browserSubmittedAt ??= new Date().toISOString(); question.reason = '扩展已点击提交，等待网页结束提问'; }
        else { question.state = 'unknown'; question.reason = '网页回答结果未知，请在原网页检查'; }
      }
      const observed = observedSessionIds.includes(question.sessionId) && sessions.some(session => session.sessionId === question.sessionId);
      if (observed && !current.has(question.id) && question.state !== 'resolved') {
        const wasExternal = !question.delegatedTo;
        question.reason = question.state === 'unknown' ? '网页已结束此提问，回答是否生效未确认' : '网页已结束此提问';
        question.state = 'resolved';
        if (wasExternal) closedExternalIds.push(question.id);
      }
    }
    for (const question of next.questions) {
      if (question.source !== 'native' || !question.webRetry || !question.webSessionId || !question.toolUseId) continue;
      const webSessionId = question.webSessionId;
      const observed = observedSessionIds.some(id => sameSessionId(id, webSessionId)) && sessions.some(session => sameSessionId(session.sessionId, webSessionId));
      if (observed && !questions.some(item => item.toolUseId === question.toolUseId)) {
        question.state = 'resolved'; question.reason = '网页上已没有这道提问，请在 claude.ai 核对结果'; endWebRetry(next, question);
      }
    } });
    for (const id of closedExternalIds) this.port.closeExternal?.(id);
    // 在场状态用 scan() 每 5 秒刷新的缓存值；远端来源主机可能要十几秒才响应，不能在同步路径里等待。
    if (generation !== this.generation || this.stopped) return [];
    for (const question of this.state.questions.filter(item => item.instanceId === instanceId && current.has(item.id) && item.state === 'pending')) await this.processSafely(question, generation);
    for (const id of current) {
      const inflight = this.activeAnswers.get(id);
      if (inflight) await inflight.catch(() => {});
    }
    const decisions: BrowserDecision[] = [];
    const overdue = () => deadline !== undefined && Date.now() >= deadline;
    const reservedEntries = new Map<string, NonNullable<ReturnType<typeof this.decisions.get>>>();
    for (const [id, entry] of this.decisions) {
      if (!current.has(id)) continue;
      if (overdue()) break;
      const valid = () => entry.generation === this.generation && !this.stopped && !this.configuring;
      if (!valid()) { this.decisions.delete(id); continue; }
      let reserved = false;
      await this.persist(next => {
        const item = next.questions.find(question => question.id === id);
        if (valid() && item?.state === 'pending') {
          item.state = 'submitted'; item.at = new Date().toISOString(); item.reason = '回答已下发，等待浏览器确认';
          item.answer = {
            source: 'user',
            answers: structuredClone(entry.decision.answers),
            ...(entry.decision.otherAnswers ? { otherAnswers: structuredClone(entry.decision.otherAnswers) } : {}),
          };
          reserved = true;
        }
      });
      // 写盘完成（状态已是“已下发”或不再待处理）后才出队，执行器不会看到“待处理且不在队列”而误判未领取。
      if (this.decisions.get(id) === entry) this.decisions.delete(id);
      if (reserved && valid()) { decisions.push({ ...entry.decision, expiresAt: Date.now() + 5000 }); reservedEntries.set(id, entry); }
      else if (reserved) await this.persist(next => { const item = next.questions.find(question => question.id === id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未下发'; } });
    }
    if (generation !== this.generation || this.stopped || this.configuring) {
      await this.persist(next => { for (const decision of decisions) { const item = next.questions.find(question => question.id === browserKey(instanceId, decision)); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未下发'; } } });
      return [];
    }
    if (decisions.length && overdue()) {
      // 写入耗时超过了截止时间：撤回“已下发”，答案放回队列，下一次同步再发。
      await this.persist(next => { for (const id of reservedEntries.keys()) { const item = next.questions.find(question => question.id === id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '回答已排队，等待下一次浏览器同步'; } } });
      for (const [id, entry] of reservedEntries) if (!this.decisions.has(id)) this.decisions.set(id, entry);
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
  ): boolean {
    if (this.stopped || this.configuring) return false;
    const original = this.browser.get(id);
    const question = this.state.questions.find(item => item.id === id);
    if (!original || !question || question.state !== 'pending') return false;
    this.decisions.set(id, {
      generation: this.generation,
      delegated: true,
      decision: {
        id: original.question.id,
        sessionId: original.question.sessionId,
        fingerprint: original.question.fingerprint,
        answers: structuredClone(answers),
        ...(otherAnswers && Object.keys(otherAnswers).length ? { otherAnswers: structuredClone(otherAnswers) } : {}),
        source: 'manual',
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
  answer(input: QuestionAnswer): Promise<PresenceSnapshot> {
    if (this.stopped || this.configuring) return Promise.reject(new Error('问答服务正在切换，请稍后再试'));
    if (this.activeAnswers.has(input.id) || this.decisions.has(input.id)) return Promise.reject(new Error('回答已排队，请等待浏览器同步'));
    const operation = this.performAnswer(input).finally(() => { this.activeAnswers.delete(input.id); });
    this.activeAnswers.set(input.id, operation);
    return operation;
  }
  private async performAnswer(input: QuestionAnswer) {
    const generation = this.generation;
    const question = this.state.questions.find(item => item.id === input.id);
    if (!question || question.state !== 'pending') throw new Error('此问题已处理或结果待核实，请打开原会话');
    if (question.source === 'browser' && question.pages && question.pages > 1) throw new Error('多题提问，请在 Paseo 云端提问或 claude.ai 作答');
    validateAnswers(question.prompts, input.answers, input.otherAnswers);
    let request: AgentPermissionRequest | undefined;
    let agent: QuestionAgent | null = null;
    if (question.source === 'native') {
      agent = await this.port.refresh(question.sessionId);
      request = agent && !agent.archivedAt ? agent.pendingPermissions.find(item => item.id === this.native.get(question.id)?.request.id) : undefined;
      if (!request || questionFingerprint(request) !== question.fingerprint) throw new Error('原会话的问题已经变化');
      const cloud = isCloudRequest(request, agent);
      nativeResponse(cloud ? { ...request, provider: CLOUD_SESSION_PROVIDER_ID } : request, input.answers, input.otherAnswers);
    } else {
      const original = this.browser.get(question.id);
      if (!original || Date.now() - original.seen > 60_000) throw new Error('网页已断开，请打开原网页回答');
      await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item?.state === 'pending') item.reason = '回答已排队，等待浏览器同步'; });
      if (!this.stopped && !this.configuring && generation === this.generation && this.state.questions.find(item => item.id === input.id)?.state === 'pending') {
        this.decisions.set(question.id, {
          generation,
          decision: {
            id: original.question.id,
            sessionId: original.question.sessionId,
            fingerprint: original.question.fingerprint,
            answers: structuredClone(input.answers),
            ...(input.otherAnswers && Object.keys(input.otherAnswers).length ? { otherAnswers: structuredClone(input.otherAnswers) } : {}),
            source: 'manual',
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
        source: 'user',
        answers: structuredClone(input.answers),
        ...(cleanOther && Object.keys(cleanOther).length ? { otherAnswers: cleanOther } : {}),
      };
    });
    if (this.stopped || this.configuring || generation !== this.generation) {
      await this.persist(next => { const item = next.questions.find(item => item.id === input.id); if (item?.state === 'submitted') { item.state = 'pending'; delete item.answer; item.reason = '模式已变化，尚未提交'; } });
      return this.snapshot();
    }
    try {
      if (request) {
        const latest = await this.port.refresh(question.sessionId);
        const current = latest && !latest.archivedAt ? latest.pendingPermissions.find(item => item.id === request!.id) : undefined;
        if (this.stopped || this.configuring || generation !== this.generation || !current || questionFingerprint(current) !== question.fingerprint) {
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
              source: 'user',
            });
          }
        }
        const response = nativeResponse(cloud ? { ...current, provider: CLOUD_SESSION_PROVIDER_ID } : current, input.answers, cleanOther);
        await this.port.respond(question.sessionId, request.id, response);
        await this.persist(next => {
          const item = next.questions.find(item => item.id === input.id);
          if (item) {
            if (cloud) {
              if (!item.webRetry) {
                item.state = 'submitted';
                item.reason = '已交给浏览器执行，等待云端确认';
              }
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
  private findCloudQuestion(next: { questions: Question[] }, webSessionId: string, toolUseId: string): Question | undefined {
    return next.questions.find(item => item.source === 'native' && item.toolUseId === toolUseId && !!item.webSessionId && sameSessionId(item.webSessionId, webSessionId));
  }
  // 网页作答的结果（执行器调用）。没有提交成功时，让云端提问回到人工待办并提示去 claude.ai 重试。
  noteWebResult(input: { webSessionId: string; toolUseId: string; result: WebRequestResult; late?: boolean }): void {
    if (this.stopped) return;
    void this.persist(next => {
      const item = this.findCloudQuestion(next, input.webSessionId, input.toolUseId);
      if (!item || item.cloudConfirmed) return;
      if (input.result.status === 'submitted') {
        if (input.late && item.webRetry) { item.state = 'submitted'; item.reason = '网页已提交（回执迟到），等待云端确认'; }
        return;
      }
      item.state = 'unknown';
      item.webRetry = true;
      item.at = new Date(this.clock()).toISOString();
      item.reason = input.result.status === 'page_not_open'
        ? 'claude.ai 页面没有打开，请在 claude.ai 作答'
        : `网页提交未确认（${webRequestDetailReason(input.result.detail)}），请在 claude.ai 重试`;
    }).catch(() => {});
  }
  // 云端记录到工具结果（执行器调用）：结束对应的云端提问。
  noteCloudConfirmed(input: { webSessionId: string; toolUseId: string; outcome: CloudRequestOutcome }): void {
    if (this.stopped) return;
    void this.persist(next => {
      const item = this.findCloudQuestion(next, input.webSessionId, input.toolUseId);
      if (!item) return;
      item.cloudConfirmed = true;
      if (item.state === 'resolved' && !item.webRetry) return;
      item.state = 'resolved';
      item.reason = input.outcome === 'denied' ? '云端记录为拒绝' : input.outcome === 'canceled' ? '云端已取消此提问' : '云端已记录结果';
      delete item.webRetry;
    }).catch(() => {});
  }
  async stop() { this.stopped = true; this.generation++; this.reviewSpeech(); clearInterval(this.timer); this.decisions.clear(); await this.cycle; await Promise.allSettled([...this.browserSyncs.values(), ...this.activeAnswers.values(), ...this.notifications]); await this.writes; }
}
