import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { AutomationStateSchema, SessionPolicySchema, type AutomationSnapshot, type SessionPolicy } from '../shared/automation.ts';
import { atomicWrite } from './storage.ts';

export interface NativeAgent {
  id: string; title: string | null; provider: string; currentModeId: string | null;
  status: string; workspaceId?: string; cwd?: string; archivedAt?: string | null; claudeProvider?: boolean;
  pendingPermissions: AgentPermissionRequest[];
}
export interface AutomationPort {
  list(): Promise<{ agents: NativeAgent[]; truncated: boolean }>;
  refresh(agentId: string): Promise<NativeAgent | null>;
  approve(agentId: string, requestId: string): Promise<boolean | void>;
}

export function permissionReason(agent: NativeAgent, request: AgentPermissionRequest, policy?: SessionPolicy): string | null {
  if (!policy?.enabled || policy.agentId !== agent.id) return '会话自动审批未开启';
  if (policy.expiresAt && Date.parse(policy.expiresAt) <= Date.now()) return '会话授权已到期';
  if (!agent.claudeProvider || request.provider !== 'claude') return '只支持已核实的 Claude 提供方';
  if (agent.archivedAt || agent.status === 'closed') return '会话已关闭或归档';
  if (agent.currentModeId !== 'acceptEdits') return '请在会话中选择接受编辑模式';
  if (request.kind !== 'tool') return '问题、计划和模式选择需要人工处理';
  if (request.actions?.length) return '带自定义选项的请求需要人工处理';
  if (request.name === 'Bash') {
    if (Object.keys(request.input ?? {}).some(key => !['command', 'description', 'timeout'].includes(key))) return '命令含额外执行选项，需要人工处理';
    const command = request.input?.command;
    return typeof command === 'string' && policy.commands.includes(command) ? null : '命令未列入当前会话的完整命令清单';
  }
  if (!policy.tools.some(tool => tool === request.name)) return '工具未列入当前会话的授权清单';
  return fileTarget(agent, request) ? null : '文件路径不在工作区授权范围内';
}

function containsPath(root: string, target: string) {
  const tail = relative(root, target);
  return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

function protectedPath(target: string) {
  return target.split(sep).some(part => ['.paseo', '.claude', '.codex', '.ssh', '.aws', '.gnupg'].includes(part));
}

function fileTarget(agent: NativeAgent, request: AgentPermissionRequest) {
  if (!agent.cwd || !isAbsolute(agent.cwd)) return null;
  const input = request.input ?? {};
  if (request.name === 'Glob') {
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || !pattern || isAbsolute(pattern) || pattern.startsWith('~') || /(^|[/\\{}(),])\.\.([/\\{}(),]|$)/.test(pattern) || pattern.includes('\\') || protectedPath(pattern)) return null;
  }
  const path = request.name === 'NotebookEdit' ? input.notebook_path : ['Glob', 'Grep'].includes(request.name) ? input.path ?? agent.cwd : input.file_path;
  if (typeof path !== 'string' || !path || path.startsWith('~') || path.includes('\0')) return null;
  const target = resolve(agent.cwd, path);
  return containsPath(resolve(agent.cwd), target) && !protectedPath(target) ? target : null;
}

export async function filePermissionReason(agent: NativeAgent, request: AgentPermissionRequest, stateDirectory: string): Promise<string | null> {
  if (request.name === 'Bash') return null;
  const target = fileTarget(agent, request);
  if (!target) return '文件路径不在工作区授权范围内';
  try {
    const root = await realpath(agent.cwd!);
    let ancestor = target;
    while (true) {
      try { await lstat(ancestor); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
    }
    const canonical = resolve(await realpath(ancestor), relative(ancestor, target));
    const stateRoot = await realpath(stateDirectory);
    if (!containsPath(root, canonical) || protectedPath(canonical) || containsPath(stateRoot, canonical)) return '文件真实路径越过工作区或进入插件配置目录';
    return null;
  } catch { return '无法核实文件真实路径，请人工处理'; }
}

function fingerprint(request: AgentPermissionRequest) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export class AutomationRuntime {
  private state = AutomationStateSchema.parse({ version: 1, paused: true, policies: [], audit: [] });
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycle: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private mutations = 0;
  private policyRevisions = new Map<string, number>();
  private reasons = new Map<string, string>();
  private agents: NativeAgent[] = [];
  private error: string | null = null;
  private truncated = false;
  private readonly path: string;
  private readonly directory: string;
  private readonly port: AutomationPort;
  private readonly executionEnabled: boolean;

  constructor(directory: string, port: AutomationPort, executionEnabled = true) {
    this.directory = directory;
    this.port = port;
    this.executionEnabled = executionEnabled;
    this.path = join(directory, 'automation.json');
  }

  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = AutomationStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('自动化配置读取失败，请检查 automation.json'); }
    if (this.state.audit.some(entry => entry.status === 'submitted')) await this.mutate(next => {
      for (const entry of next.audit) if (entry.status === 'submitted') entry.status = 'unknown';
    });
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => void this.refresh(), 5000);
  }

  snapshot(): AutomationSnapshot {
    return {
      hostName: hostname(), paused: this.state.paused, policies: structuredClone(this.state.policies), audit: structuredClone(this.state.audit).reverse(),
      error: this.error, truncated: this.truncated,
      sessions: this.agents.map(agent => ({
        id: agent.id, title: agent.title || '未命名 Paseo 会话', provider: agent.provider, supportsAutomation: Boolean(agent.claudeProvider),
        mode: agent.currentModeId, status: agent.status, workspaceId: agent.workspaceId ?? null, workspacePath: agent.cwd ?? null,
        pending: agent.pendingPermissions.map(request => {
          const audit = this.state.audit.find(entry => entry.agentId === agent.id && entry.requestId === request.id);
          const reason = audit?.status === 'unknown' ? '审批结果未知，请人工确认；不会重复发送' : audit ? null : this.state.paused ? '原生审批已暂停' :
            permissionReason(agent, request, this.state.policies.find(policy => policy.agentId === agent.id)) ?? this.reasons.get(`${agent.id}:${request.id}`);
          return { id: request.id, name: request.name, kind: request.kind, title: request.title || request.name,
            state: reason ? 'manual' as const : audit ? 'submitted' as const : 'automatic' as const,
            reason: reason ?? (audit ? '已发送响应，等待处理结果；不会重复发送' : '等待按当前授权处理') };
        }),
      })),
    };
  }

  private mutate(change: (next: typeof this.state) => void) {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state);
      change(next);
      await atomicWrite(this.path, JSON.stringify(next));
      this.state = next;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  async pause(paused: boolean) {
    this.generation += 1;
    this.mutations += 1;
    try { await this.mutate(next => { next.paused = paused; }); }
    finally { this.mutations -= 1; }
    return this.snapshot();
  }

  async policy(value: SessionPolicy) {
    const policy = SessionPolicySchema.parse(value);
    this.policyRevisions.set(policy.agentId, (this.policyRevisions.get(policy.agentId) ?? 0) + 1);
    this.generation += 1;
    this.mutations += 1;
    try {
      if (policy.enabled) {
        const agent = await this.port.refresh(policy.agentId);
        if (!agent || agent.archivedAt || agent.status === 'closed' || !agent.claudeProvider) throw new Error('请选择本机有效的 Claude 会话');
        if (agent.currentModeId !== 'acceptEdits') throw new Error('请先在会话中选择接受编辑，再启用自动审批');
        if (policy.expiresAt && Date.parse(policy.expiresAt) <= Date.now()) throw new Error('授权有效期必须晚于当前时间');
        if (!policy.tools.length && !policy.commands.length) throw new Error('请选择工具或填写完整命令');
      }
      await this.mutate(next => { next.policies = [...next.policies.filter(item => item.agentId !== policy.agentId), policy]; });
    }
    finally { this.mutations -= 1; }
    return this.snapshot();
  }

  async archive(agentId: string) {
    this.policyRevisions.set(agentId, (this.policyRevisions.get(agentId) ?? 0) + 1);
    this.generation += 1;
    this.mutations += 1;
    try { await this.mutate(next => { next.policies = next.policies.filter(item => item.agentId !== agentId); }); }
    finally { this.mutations -= 1; }
    this.agents = this.agents.filter(agent => agent.id !== agentId);
  }

  async resolved(agentId: string, requestId: string, resolution: 'allow' | 'deny' | 'disappeared' = 'disappeared') {
    if (!this.state.audit.some(entry => entry.agentId === agentId && entry.requestId === requestId && (entry.status !== 'resolved' || resolution !== 'disappeared' && entry.resolution !== resolution))) return;
    await this.mutate(next => {
      for (const entry of next.audit) if (entry.agentId === agentId && entry.requestId === requestId) {
        entry.status = 'resolved';
        if (!entry.resolution || resolution !== 'disappeared') entry.resolution = resolution;
      }
    });
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cycle) return this.cycle;
    this.cycle = this.scan().catch(() => { this.error = '无法同步本机会话或保存审批记录，自动审批暂未继续'; }).finally(() => { this.cycle = null; });
    return this.cycle;
  }

  private async scan() {
    const listed = await this.port.list();
    if (this.stopped) return;
    this.agents = listed.agents;
    this.truncated = listed.truncated;
    this.error = null;
    this.reasons.clear();
    for (const entry of this.state.audit.filter(item => item.status !== 'resolved')) {
      const agent = listed.agents.find(item => item.id === entry.agentId);
      if (agent && !agent.pendingPermissions.some(item => item.id === entry.requestId)) await this.resolved(entry.agentId, entry.requestId);
    }
    for (const policy of this.state.policies.filter(item => item.enabled)) {
      if (this.stopped || !this.executionEnabled || this.state.paused || this.mutations) break;
      const generation = this.generation;
      const agent = await this.port.refresh(policy.agentId);
      if (agent?.archivedAt) { await this.archive(policy.agentId); continue; }
      if (!agent || this.stopped || this.state.paused || generation !== this.generation) continue;
      for (const request of agent.pendingPermissions) {
        if (this.state.audit.some(entry => entry.agentId === agent.id && entry.requestId === request.id)) continue;
        if (permissionReason(agent, request, policy)) continue;
        const latest = await this.port.refresh(agent.id);
        const current = latest?.pendingPermissions.find(item => item.id === request.id);
        if (!latest || !current || fingerprint(current) !== fingerprint(request)) continue;
        const currentPolicy = this.state.policies.find(item => item.agentId === agent.id);
        const fileReason = await filePermissionReason(latest, current, this.directory);
        if (fileReason) { this.reasons.set(`${agent.id}:${request.id}`, fileReason); continue; }
        if (this.stopped || this.state.paused || generation !== this.generation || permissionReason(latest, current, currentPolicy)) continue;
        const auditId = randomUUID();
        const policyRevision = this.policyRevisions.get(agent.id);
        await this.mutate(next => {
          if (this.stopped || this.state.paused || this.mutations || generation !== this.generation) return;
          if (currentPolicy?.oneShot) {
            const consumed = next.policies.find(item => item.agentId === agent.id);
            if (consumed) consumed.enabled = false;
          }
          next.audit.push({ id: auditId, agentId: agent.id, requestId: request.id, fingerprint: fingerprint(request),
            title: agent.title || '未命名 Paseo 会话', tool: request.name, at: new Date().toISOString(), status: 'submitted' });
          const unresolved = next.audit.filter(entry => entry.status !== 'resolved');
          next.audit = [...next.audit.filter(entry => entry.status === 'resolved').slice(-200), ...unresolved];
        });
        const beforeSend = await this.port.refresh(agent.id);
        const finalRequest = beforeSend?.pendingPermissions.find(item => item.id === request.id);
        if (this.stopped || this.state.paused || this.mutations || generation !== this.generation || !beforeSend || !finalRequest || fingerprint(finalRequest) !== fingerprint(request) || permissionReason(beforeSend, finalRequest, currentPolicy)) {
          await this.mutate(next => {
            next.audit = next.audit.filter(entry => entry.id !== auditId);
            const reserved = next.policies.find(item => item.agentId === agent.id);
            if (currentPolicy?.oneShot && reserved && this.policyRevisions.get(agent.id) === policyRevision) reserved.enabled = true;
          });
          continue;
        }
        try {
          const confirmed = await this.port.approve(agent.id, request.id);
          const after = confirmed === true ? null : await this.port.refresh(agent.id);
          if (confirmed === true) await this.resolved(agent.id, request.id, 'allow');
          else if (after && !after.pendingPermissions.some(item => item.id === request.id)) await this.resolved(agent.id, request.id);
          else await this.mutate(next => {
            const entry = next.audit.find(item => item.id === auditId);
            if (entry && entry.status !== 'resolved') entry.status = 'unknown';
          });
        } catch {
          await this.mutate(next => {
            const entry = next.audit.find(item => item.id === auditId);
            if (entry && entry.status !== 'resolved') entry.status = 'unknown';
          });
        }
      }
    }
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.cycle;
    await this.writes;
  }
}
