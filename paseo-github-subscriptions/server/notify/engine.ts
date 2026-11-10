import { deliveryClass, questionRequest } from './routing.ts';
import { randomUUID } from "node:crypto";
import type { NotifyConfig as Config, Target } from "./config.ts";
import {
  needsUser,
  questionSummary,
  wakePolicy,
  type Actor,
  type AgentInfo,
  type EventName,
} from "./protocol.ts";
export interface Notice {
  id: string;
  key: string;
  event: EventName;
  agentId: string;
  hostId: string;
  machine: string;
  workspaceId: string | null;
  title: string | null;
  provider: string | null;
  permissionId: string | null;
  firstSeenAt: string;
  answeredBy: Actor | null;
  provenance: "recorded" | "unknown" | "not_applicable";
  questionSummary: ReturnType<typeof questionSummary>;
  needsUser: boolean;
  wake: "immediate" | "coalesce" | "none";
  coalesceWindowSeconds: number;
  at: number;
  data: unknown;
  target?: Target;
  requestId?: string;
  events?: Notice[];
  extra?: Record<string, unknown>;
}
export interface Pending {
  agentId: string;
  requestId: string;
  at: number;
  data: unknown;
}
export interface Failure {
  notice: Notice;
  target: Target;
  deliveredAt?: number;
  acknowledgedAt?: number;
}
export interface State {
  pending: Record<string, Pending>;
  outbox: Array<{ notice: Notice; attempts: number; next: number }>;
  seen: Record<string, number>;
  agents?: Record<string, AgentInfo>;
  origins?: Record<string, Actor>;
  failures?: Record<string, Failure>;
  turns?: Record<
    string,
    { id: string; providerTurnId: string | null; startedAt: number }
  >;
}
export const emptyState = (): State => ({
  pending: {},
  outbox: [],
  seen: {},
  agents: {},
  origins: {},
  failures: {},
});
// 持久化 outbox 保质期：过期/超试的旧事件不再补发；重载只投递启动后新发生的事件，
// 仍待答的问题由 pending 状态在下个 tick 自行重建，不会丢。
export const OUTBOX_MAX_AGE_MS = 30 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 12;
export interface OutboxDrop {
  key: string;
  event: string;
  reason: "before-boot" | "stale" | "too-many-attempts";
  attempts: number;
  at: number;
}
export function expireOutbox(
  state: State,
  now: number,
  boot?: number,
): OutboxDrop[] {
  const dropped: OutboxDrop[] = [];
  state.outbox = state.outbox.filter((job) => {
    const reason =
      boot !== undefined && job.notice.at < boot
        ? "before-boot"
        : now - job.notice.at > OUTBOX_MAX_AGE_MS
          ? "stale"
          : job.attempts >= OUTBOX_MAX_ATTEMPTS
            ? "too-many-attempts"
            : null;
    if (!reason) return true;
    dropped.push({
      key: job.notice.key,
      event: job.notice.event,
      reason,
      attempts: job.attempts,
      at: job.notice.at,
    });
    return false;
  });
  return dropped;
}
export class Engine {
  config: Config;
  state: State;
  save: (state: State) => Promise<void>;
  send: (notice: Notice) => Promise<void>;
  isPending: (agent: string, request: string) => Promise<boolean>;
  audit: (entry: Record<string, unknown>) => Promise<void>;
  /** 提问不再等待（已回答、已取消，或检查发现已不在等待）时调用，用于结束页面记录。 */
  onResolved?: (agentId: string, requestId: string) => void | Promise<void>;
  constructor(
    config: Config,
    state: State,
    save: (state: State) => Promise<void>,
    send: (notice: Notice) => Promise<void>,
    isPending: (agent: string, request: string) => Promise<boolean>,
    audit: (entry: Record<string, unknown>) => Promise<void> = async () => {},
  ) {
    this.config = config;
    this.state = state;
    this.save = save;
    this.send = send;
    this.isPending = isPending;
    this.audit = audit;
    state.turns ||= {};
    state.agents ||= {};
    state.origins ||= {};
    state.failures ||= {};
  }
  private chain: Promise<unknown> = Promise.resolve();
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }
  metadata(agent: AgentInfo) {
    this.state.agents![agent.id] = agent;
  }
  async turnStarted(agentId: string, turnId: string | null, now = Date.now()) {
    this.state.turns![agentId] = {
      id: randomUUID(),
      providerTurnId: turnId,
      startedAt: now,
    };
    await this.save(this.state);
  }
  async turnEnded(
    agentId: string,
    turnId: string | null,
    outcome: unknown,
    target?: Target,
    now = Date.now(),
  ) {
    let turn = this.state.turns![agentId];
    if (!turn || turn.providerTurnId !== turnId) {
      await this.turnStarted(agentId, turnId, now);
      turn = this.state.turns![agentId];
    }
    const main=this.config.mains.includes(agentId);
    if(main)target=undefined;
    const child=!main&&!!(target||this.state.agents![agentId]?.parentAgentId);
    const kind = (outcome as { kind?: string })?.kind;
    await this.enqueue(
      child && !target ? "subagent_done" : kind === "failed" ? "error" : child ? "subagent_done" : "turn_end",
      agentId,
      { turnId, outcome, ...(child && !target ? {orphaned:true}: {}) },
      `turn:${agentId}:${turn.id}`,
      target,
      undefined,
      now,
    );
  }
  async origin(agentId: string, referenceId: string, actor: Actor) {
    this.state.origins![JSON.stringify([agentId, referenceId])] = actor;
    await this.save(this.state);
  }
  normalizeMainNotice(notice:Notice){
    if(!this.config.mains.includes(notice.agentId))return;
    delete notice.target;
    if(notice.event==='subagent_done')notice.event=(notice.data as any)?.outcome?.kind==='failed'?'error':'turn_end';
    if((notice.data as any)?.orphaned){const {orphaned,reason,previousTarget,...data}=notice.data as any;notice.data=data;}
    notice.wake=wakePolicy(notice.event);
  }
  async enqueue(
    event: EventName,
    agentId: string,
    data: unknown,
    key: string,
    target?: Target,
    requestId?: string,
    now = Date.now(),
    actor: Actor | null = null,
    firstSeen = now,
  ) {
    if(event==='asked'&&requestId){
      const permissionKey=`permission:${requestId}`;
      if(this.state.seen[permissionKey]!==undefined||this.state.outbox.some(j=>j.notice.event==='asked'&&j.notice.permissionId===requestId))return;
    }
    if (
      this.state.seen[key] !== undefined ||
      this.state.outbox.some((x) => x.notice.key === key)
    )
      return;
    const agent = this.state.agents![agentId];
    const notice: Notice = {
      id: randomUUID(),
      key,
      event,
      agentId,
      hostId: this.config.hostId,
      machine: this.config.machine,
      workspaceId: agent?.workspaceId || null,
      title: agent?.title || null,
      provider: agent?.provider || null,
      permissionId: requestId || null,
      firstSeenAt: new Date(firstSeen).toISOString(),
      answeredBy: actor,
      provenance: actor
        ? "recorded"
        : event === "answered" || event === "user_reply"
          ? "unknown"
          : "not_applicable",
      questionSummary: questionSummary(
        event === "answered" ? (data as { request?: unknown })?.request : data,
      ),
      needsUser: needsUser(data),
      wake: target
        ? "none"
        : event === "answered" && actor === "user"
          ? "coalesce"
          : wakePolicy(event),
      coalesceWindowSeconds: 60,
      at: now,
      data,
      target,
      requestId,
    };
    this.normalizeMainNotice(notice);
    event=notice.event;target=notice.target;data=notice.data;
    const route=deliveryClass(event,this.config.mains.includes(agentId),!!target,!!(data as any)?.orphaned);
    // 子会话 wake=none 且无需用户处理的普通事件（命令错误/后台完成/状态变化/完结）只记录，
    // 不叫醒主会话；真正待答的问题、权限与需要接续（needsUser）的事件保留投递。
    const quiet=!!target&&event!=='asked'&&!notice.needsUser;
    if(route==='record'||quiet||(!target&&event==='error'&&typeof(data as any)?.callId==='string')||(event==='asked'&&!questionRequest(data))){
      await this.audit({phase:'recorded-only',mode:this.config.delivery,notice});
      this.state.seen[key]=now;await this.save(this.state);return;
    }
    await this.audit({ phase: "queued", mode: this.config.delivery, notice });
    const delay =
      !target && notice.wake !== "immediate"
        ? (this.config.coalesceWindowSeconds || 0) * 1000
        : 0;
    this.state.outbox.push({ notice, attempts: 0, next: now + delay });
    await this.save(this.state);
  }
  async asked(
    agentId: string,
    requestId: string,
    data: unknown,
    now = Date.now(),
  ) {
    if (!this.config.mains.includes(agentId) || !questionRequest(data)) {
      await this.enqueue('asked',agentId,data,`record-question:${agentId}:${requestId}`,undefined,requestId,now);return;
    }
    const key = JSON.stringify([agentId, requestId]);
    if (!this.state.pending[key]) {
      await this.audit({
        phase: "pending",
        mode: this.config.delivery,
        event: "asked",
        agentId,
        permissionId: requestId,
        firstSeenAt: new Date(now).toISOString(),
        data,
      });
      this.state.pending[key] = { agentId, requestId, at: now, data };
    }
    await this.save(this.state);
  }
  async resolved(
    agentId: string,
    requestId: string,
    resolution?: unknown,
    notify = false,
    now = Date.now(),
  ) {
    const key = JSON.stringify([agentId, requestId]);
    const pending = this.state.pending[key];
    delete this.state.pending[key];
    await this.onResolved?.(agentId, requestId);
    this.state.outbox = this.state.outbox.filter(
      (x) =>
        !(
          x.notice.agentId === agentId &&
          x.notice.requestId === requestId &&
          x.notice.event === "asked"
        ),
    );
    await this.save(this.state);
    if (notify) {
      const actor = this.state.origins![key] || null;
      await this.enqueue(
        "answered",
        agentId,
        { request: pending?.data, resolution },
        `answered:${key}`,
        undefined,
        requestId,
        now,
        actor,
        pending?.at ?? now,
      );
    }
  }
  async message(
    agentId: string,
    messageId: string,
    text: string,
    now = Date.now(),
  ) {
    const actor = this.state.origins![JSON.stringify([agentId, messageId])];
    // 标准时间线缺少可靠来源，未知消息绝不能猜为用户消息。
    if (actor !== "user" || !this.config.mains.includes(agentId)) return;
    await this.enqueue(
      "user_reply",
      agentId,
      { text },
      `user_reply:${agentId}:${messageId}`,
      undefined,
      undefined,
      now,
      "user",
    );
  }
  async commandFailed(
    agentId: string,
    data: unknown,
    key: string,
    target: Target,
    now = Date.now(),
    event: "bg_cmd_done" | "error" = "bg_cmd_done",
  ) {
    if (!this.state.failures![key]) {
      await this.enqueue(event, agentId, data, key, target, undefined, now);
      const notice = this.state.outbox.find(
        (x) => x.notice.key === key,
      )?.notice;
      if (notice) this.state.failures![key] = { notice, target };
      await this.save(this.state);
    }
  }
  async acknowledge(agentId: string, serverId?: string, now = Date.now()) {
    for (const f of Object.values(this.state.failures!))
      if (
        f.target.agentId === agentId &&
        f.target.serverId === serverId &&
        f.deliveredAt !== undefined &&
        now >= f.deliveredAt
      )
        f.acknowledgedAt = now;
    this.state.outbox = this.state.outbox.filter((job) => {
      if (!job.notice.key.startsWith("failure-escalation:")) return true;
      const failure =
        this.state.failures![
          job.notice.key.slice("failure-escalation:".length)
        ];
      return failure?.acknowledgedAt === undefined;
    });
    await this.save(this.state);
  }
  /**
   * tick 只检查未送达的提问；已送达的提问靠权限钩子结束。钩子漏掉时（重载、连接中断）由这里补查，
   * 已不再等待的清出待答状态。查询失败的保留，下次再查。
   */
  async reconcilePending(now = Date.now()) {
    for (const p of Object.values(this.state.pending)) {
      if (this.state.seen[`asked:${JSON.stringify([p.agentId, p.requestId])}`] === undefined) continue;
      try {
        if (await this.isPending(p.agentId, p.requestId)) continue;
      } catch { continue; }
      await this.audit({ phase: "pending-expired", mode: this.config.delivery, agentId: p.agentId, permissionId: p.requestId, at: now });
      await this.resolved(p.agentId, p.requestId, undefined, false, now);
    }
  }
  async tick(now = Date.now()) {
    const expired = expireOutbox(this.state, now);
    for (const drop of expired)
      await this.audit({ phase: "outbox-expired", mode: this.config.delivery, ...drop });
    if (expired.length) await this.save(this.state);
    for (const p of Object.values(this.state.pending)) {
      const key = `asked:${JSON.stringify([p.agentId, p.requestId])}`;
      if (this.state.seen[key] !== undefined)
        continue;
      // 时段规则：时段外先等一段时间，到点或进入立即时段后才升级（见 notify/schedule.ts）。
      if (this.config.hold?.(p.at, now)) continue;
      try {
        if (!(await this.isPending(p.agentId, p.requestId))) {
          await this.resolved(p.agentId, p.requestId);
          continue;
        }
        await this.enqueue(
          "asked",
          p.agentId,
          p.data,
          key,
          undefined,
          p.requestId,
          now,
          null,
          p.at,
        );
      } catch {
        /* 单个请求连接失败不能阻断其他通知；下次继续。 */
      }
    }
    for(const job of this.state.outbox){
      this.normalizeMainNotice(job.notice);
      for(const member of job.notice.events||[])this.normalizeMainNotice(member);
      const n=job.notice;if(n.target?.agentId===n.agentId&&!this.config.children[n.agentId]&&!this.state.agents![n.agentId]?.parentAgentId)delete n.target;
    }
    const windowMs = (this.config.coalesceWindowSeconds || 0) * 1000;
    if (windowMs)
      for (const first of [...this.state.outbox]) {
        if (
          !this.state.outbox.includes(first) ||
          first.notice.target ||
          first.notice.wake === "immediate" ||
          first.notice.events ||
          first.next > now
        )
          continue;
        const group = this.state.outbox.filter(
          (j) =>
            !j.notice.target &&
            j.notice.wake !== "immediate" &&
            !j.notice.events &&
            j.notice.at <= first.notice.at + windowMs,
        );
        if (group.length > 1) {
          first.notice = {
            ...first.notice,
            events: group.map((j) => j.notice),
          };
          this.state.outbox = this.state.outbox.filter(
            (j) => j === first || !group.includes(j),
          );
          await this.save(this.state);
        }
      }
    for (const job of [...this.state.outbox]) {
      if (job.next > now) continue;
      // 重载后同样过滤旧版本积压，不能把旧批次中的静默事件继续发出。
      if(job.notice.events){job.notice.events=job.notice.events.filter(n=>deliveryClass(n.event,this.config.mains.includes(n.agentId),!!n.target,!!(n.data as any)?.orphaned)!=='record'&&!(n.event==='error'&&!n.target&&typeof(n.data as any)?.callId==='string')&&(!n.target||n.event==='asked'||n.needsUser));
        if(job.notice.events.length){const members=job.notice.events;job.notice={...members[0],id:job.notice.id,events:members};}}
      if((job.notice.event==='error'&&!job.notice.target&&typeof(job.notice.data as any)?.callId==='string')||(job.notice.events&&job.notice.events.length===0)||deliveryClass(job.notice.event,this.config.mains.includes(job.notice.agentId),!!job.notice.target,!!(job.notice.data as any)?.orphaned)==='record'||(job.notice.target&&job.notice.event!=='asked'&&!job.notice.needsUser)){
        await this.audit({phase:'recorded-only',mode:this.config.delivery,notice:job.notice});this.state.outbox=this.state.outbox.filter(x=>x!==job);await this.save(this.state);continue;
      }
      try {
        if (
          job.notice.event === "asked" &&
          job.notice.requestId &&
          !(await this.isPending(job.notice.agentId, job.notice.requestId))
        ) {
          await this.resolved(job.notice.agentId, job.notice.requestId);
          continue;
        }
        await this.send(job.notice);
        this.state.seen[job.notice.key] = now;
        if(job.notice.event==='asked'&&job.notice.permissionId)this.state.seen[`permission:${job.notice.permissionId}`]=now;
        for (const event of job.notice.events || [])
          this.state.seen[event.key] = now;
        this.state.outbox = this.state.outbox.filter((x) => x !== job);
        const failure = this.state.failures![job.notice.key];
        if (failure) failure.deliveredAt = now;
      } catch (error) {
        if((error as any)?.suppressed){await this.audit({phase:'recorded-only',mode:this.config.delivery,notice:job.notice});this.state.seen[job.notice.key]=now;this.state.outbox=this.state.outbox.filter(x=>x!==job);await this.save(this.state);continue;}
        if((error as any)?.deferred){job.next=now+10_000;await this.audit({phase:'deferred',reason:(error as any).reason,mode:this.config.delivery,eventId:job.notice.id});await this.save(this.state);continue;}
        await this.audit({
          phase: "delivery-failed",
          mode: this.config.delivery,
          eventId: job.notice.id,
          key: job.notice.key,
          httpStatus: (error as { httpStatus?: number })?.httpStatus,
        });
        job.attempts++;
        job.next =
          now + Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 8));
      }
      await this.save(this.state);
    }
  }
}
