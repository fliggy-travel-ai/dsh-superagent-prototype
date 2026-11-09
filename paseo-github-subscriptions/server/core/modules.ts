import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { ResolvedInstance } from '../../shared/instances.ts';
import { modulesStatus, type ModulesSnapshot, type ModuleStatus } from '../../shared/modules.ts';
import { loadMachineConfig, type LoadedMachineConfig, type SectionSpec } from './machine-config.ts';

/**
 * 模块框架。
 *
 * Paseo 0.15 的约束：contribute 中同步抛错会让整个实例启动失败；未捕获的异步错误会让插件进程退出，
 * Paseo 不会自动重启。所以：
 * - 每个模块的注册单独捕获错误，失败只停这个模块；
 * - 进程级监听 unhandledRejection 和 uncaughtException，按模块记录，不让进程退出；
 * - 模块注册的处理函数、钩子和 Provider 回调都在该模块的异步上下文中运行，错误可以归属到模块。
 */
export type Cleanup = () => void | Promise<void>;

export interface ModuleContext<Config, Services> {
  readonly id: string;
  /** 本模块专用的服务端上下文，回调在模块上下文中运行。 */
  readonly server: PluginServerContext;
  readonly instance: ResolvedInstance;
  /** 本模块登记的机器配置区块（解析后），没有登记时为 undefined。 */
  readonly config: Config;
  readonly machine: LoadedMachineConfig;
  readonly services: Services;
  /** 按实例角色区分的状态目录。 */
  readonly stateDirectory: string;
  /** 插件主状态目录（machine.json 所在目录）。 */
  readonly baseDirectory: string;
  /** 运行中出错时调用，状态改为出错。 */
  fail(error: unknown): void;
}

export interface ModuleDefinition<Config, Services> {
  /** 也是 machine.json 中 modules 的键。 */
  readonly id: string;
  readonly label: string;
  readonly defaultEnabled: boolean;
  /** 始终开启的内置功能（如云端会话），即使旧配置写 false 也按开启处理。 */
  readonly alwaysEnabled?: boolean;
  appliesTo(instance: ResolvedInstance): boolean;
  readonly config?: { readonly section: string; readonly spec: SectionSpec<Config> };
  /** 自定义脱敏；默认用 summarizeError。 */
  redact?(error: unknown): string;
  register(context: ModuleContext<Config, Services>): void | Cleanup;
}

interface ProcessLike {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (error: unknown) => void): unknown;
  off(event: 'unhandledRejection' | 'uncaughtException', listener: (error: unknown) => void): unknown;
}

export interface StartOptions<Services> {
  readonly server: PluginServerContext;
  readonly instance: ResolvedInstance;
  readonly machine: LoadedMachineConfig;
  readonly services: Services;
  readonly stateDirectory: string;
  readonly baseDirectory: string;
  readonly log?: (line: string) => void;
  readonly process?: ProcessLike;
  readonly now?: () => Date;
}

export interface ModuleHost {
  status(): ModulesSnapshot;
  /** 当前异步上下文所属的模块 ID。 */
  currentModule(): string | null;
  runInModule<T>(id: string, operation: () => T): T;
  /** 动态启用或关闭指定模块（注册或停用其 RPC 与清理函数）。 */
  setEnabled?(id: string, enabled: boolean): Promise<void>;
  dispose(): Promise<void>;
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+\S+/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9-_]{16,}/g,
  /\b[a-f0-9]{48,}\b/gi,
];

/** 一行错误摘要：去掉令牌、Bearer、URL 查询和片段，最长 300 字符。 */
export function summarizeError(error: unknown): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误';
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[已隐藏]');
  text = text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[已隐藏]').replace(/[\r\n]+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text || '未知错误';
}

interface Entry { id: string; label: string; state: ModuleStatus['state']; reason?: string; lastUncaught?: { at: string; summary: string }; redact: (error: unknown) => string; cleanup?: Cleanup }

export function startModules<Services>(definitions: readonly ModuleDefinition<any, Services>[], options: StartOptions<Services>): ModuleHost {
  const storage = new AsyncLocalStorage<{ moduleId: string }>();
  const log = options.log ?? (line => console.error(line));
  const now = options.now ?? (() => new Date());
  const proc: ProcessLike = options.process ?? process;
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  const defById = new Map<string, ModuleDefinition<any, Services>>();
  const currentModule = () => storage.getStore()?.moduleId ?? null;
  const runInModule = <T>(id: string, operation: () => T): T => storage.run({ moduleId: id }, operation);

  const rawHandle = typeof options.server.handle === 'function' ? options.server.handle.bind(options.server) : null;
  const boundContracts = new Set<string>();
  const activeHandlers = new Map<string, { moduleId: string; fn: (input: any, ctx: any) => any }>();
  const coreHandlers = new Map<string, (input: any, ctx: any) => any>();
  const lastModuleByContract = new Map<string, string>();

  const ensureBound = (contract: { name: string }) => {
    if (!rawHandle || boundContracts.has(contract.name)) return;
    boundContracts.add(contract.name);
    rawHandle(contract as never, (async (input: any, ctx: any) => {
      const active = activeHandlers.get(contract.name);
      if (active) return active.fn(input, ctx);
      const core = coreHandlers.get(contract.name);
      if (core) return core(input, ctx);
      const modId = lastModuleByContract.get(contract.name);
      throw new Error(modId ? `未知调用 ${contract.name}（模块 ${modId} 未启用）` : `未知调用 ${contract.name}`);
    }) as never);
  };

  if (rawHandle) {
    (options.server as { handle: PluginServerContext['handle'] }).handle = ((contract: { name: string }, handler: (input: any, ctx: any) => any) => {
      coreHandlers.set(contract.name, handler);
      ensureBound(contract);
    }) as PluginServerContext['handle'];
  }

  const onUncaught = (kind: string) => (error: unknown) => {
    const entry = byId.get(currentModule() ?? '');
    const summary = (entry?.redact ?? summarizeError)(error);
    if (entry) entry.lastUncaught = { at: now().toISOString(), summary };
    log(`[开发自动化] ${entry?.label ?? '未知模块'} ${kind}：${summary}`);
  };
  const onRejection = onUncaught('未捕获的异步错误');
  const onException = onUncaught('未捕获的异常');
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);

  const snapshot = (): ModulesSnapshot => ({
    instance: { role: options.instance.role, legacy: options.instance.legacy },
    config: { path: options.machine.path, source: options.machine.source, errors: [...options.machine.errors] },
    modules: entries.map(({ id, label, state, reason, lastUncaught }) => ({ id, label, state, ...(reason ? { reason } : {}), ...(lastUncaught ? { lastUncaught } : {}) })),
  });
  options.server.handle(modulesStatus, async () => snapshot());

  const startOne = (definition: ModuleDefinition<any, Services>, entry: Entry, reloadSection: boolean) => {
    delete entry.reason;
    entry.state = 'off';
    let config: unknown;
    if (definition.config) {
      const section = reloadSection && existsSync(options.machine.path)
        ? loadMachineConfig(options.machine.path, { [definition.config.section]: definition.config.spec }).section(definition.config.section)
        : options.machine.section(definition.config.section);
      if (!section.ok) { entry.state = 'error'; entry.reason = section.error; return; }
      config = section.value;
    }
    const gen = { active: true };
    const clearModuleHandlers = () => {
      gen.active = false;
      for (const [name, active] of activeHandlers.entries()) {
        if (active.moduleId === definition.id) activeHandlers.delete(name);
      }
    };
    try {
      const cleanup = runInModule(definition.id, () => definition.register({
        id: definition.id,
        server: scopedServer(
          options.server,
          operation => runInModule(definition.id, operation),
          gen,
          (contract, handler) => {
            activeHandlers.set(contract.name, { moduleId: definition.id, fn: handler });
            lastModuleByContract.set(contract.name, definition.id);
            ensureBound(contract);
          },
        ),
        instance: options.instance, config, machine: options.machine, services: options.services,
        stateDirectory: options.stateDirectory, baseDirectory: options.baseDirectory,
        fail: error => { entry.state = 'error'; entry.reason = entry.redact(error); },
      }));
      entry.cleanup = async () => {
        clearModuleHandlers();
        if (typeof cleanup === 'function') await cleanup();
      };
      if (entry.state === 'off') entry.state = 'running';
    } catch (error) {
      clearModuleHandlers();
      entry.state = 'error';
      entry.reason = entry.redact(error);
      log(`${definition.label}注册失败：${entry.reason}`);
    }
  };

  let disposed: Promise<void> | null = null;
  const host: ModuleHost = {
    status: snapshot,
    currentModule,
    runInModule,
    async setEnabled(id: string, enabled: boolean) {
      (options.machine.modules as Record<string, boolean | undefined>)[id] = enabled;
      const definition = defById.get(id);
      const entry = byId.get(id);
      if (!definition || !entry || definition.alwaysEnabled) return;
      if (enabled) {
        if (entry.state === 'running') return;
        startOne(definition, entry, true);
      } else {
        const cleanup = entry.cleanup;
        entry.cleanup = undefined;
        if (cleanup) {
          try { await runInModule(entry.id, cleanup); }
          catch (error) { log(`${entry.label}清理失败：${entry.redact(error)}`); }
        } else {
          for (const [name, active] of activeHandlers.entries()) {
            if (active.moduleId === entry.id) activeHandlers.delete(name);
          }
        }
        entry.state = 'off';
        entry.reason = 'machine.json 中已关闭';
      }
    },
    dispose() {
      disposed ??= (async () => {
        for (const entry of [...entries].reverse()) {
          if (!entry.cleanup) continue;
          const cleanup = entry.cleanup;
          entry.cleanup = undefined;
          try { await runInModule(entry.id, cleanup); }
          catch (error) { log(`${entry.label}清理失败：${entry.redact(error)}`); }
        }
        proc.off('unhandledRejection', onRejection);
        proc.off('uncaughtException', onException);
      })();
      return disposed;
    },
  };
  const mainSvc = (options.services as { main?: { host?: ModuleHost | null } } | undefined)?.main;
  if (mainSvc) mainSvc.host = host;

  for (const definition of definitions) {
    if (!definition.appliesTo(options.instance)) continue;
    const entry: Entry = { id: definition.id, label: definition.label, state: 'off', redact: error => definition.redact ? definition.redact(error) : summarizeError(error) };
    entries.push(entry);
    byId.set(entry.id, entry);
    defById.set(entry.id, definition);
    const switched = options.machine.modules[definition.id];
    if (!definition.alwaysEnabled) {
      if (switched === false) { entry.reason = 'machine.json 中已关闭'; continue; }
      if (switched === undefined && !definition.defaultEnabled) { entry.reason = '默认关闭，在 machine.json 的 modules 中打开'; continue; }
    }
    startOne(definition, entry, false);
  }

  return host;
}

type Wrap = <T>(operation: () => T) => T;

/** 包一层服务端上下文：回调在模块上下文中运行，其余行为不变。 */
function scopedServer(
  server: PluginServerContext,
  wrap: Wrap,
  gen: { active: boolean },
  registerHandle: (contract: { name: string }, handler: (input: any, ctx: any) => any) => void,
): PluginServerContext {
  const callback = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: Parameters<F>) => wrap(() => fn(...args))) as F;
  const scoped: Partial<PluginServerContext> = {
    handle: (contract, handler) => registerHandle(contract, callback(handler)),
    addHook: ((name: never, handler: never) => server.addHook(name, callback(((payload: any, ...rest: any[]) => {
      if (!gen.active) return payload?.request ?? payload;
      return (handler as (...args: any[]) => unknown)(payload, ...rest);
    }) as never) as never)) as PluginServerContext['addHook'],
    on: ((name: never, handler: never) => server.on(name, callback(((...args: any[]) => {
      if (!gen.active) return;
      return (handler as (...args: any[]) => unknown)(...args);
    }) as never) as never)) as PluginServerContext['on'],
    before: ((name: never, handler: never) => server.before(name, callback(((...args: any[]) => {
      if (!gen.active) return { action: 'continue' };
      return (handler as (...args: any[]) => unknown)(...args);
    }) as never) as never)) as PluginServerContext['before'],
    registerProvider: provider => {
      const wrapped = { ...provider } as Record<string, unknown>;
      for (const key of ['connect', 'status', 'getCatalogCacheKey'] as const) {
        const value = wrapped[key];
        if (typeof value === 'function') wrapped[key] = callback(value.bind(provider) as (...args: never[]) => unknown);
      }
      server.registerProvider(wrapped as unknown as typeof provider);
    },
    registerUsageSource: source => {
      const wrapped = { ...source } as Record<string, unknown>;
      for (const key of ['discover', 'fetch'] as const) {
        const value = wrapped[key];
        if (typeof value === 'function') wrapped[key] = callback(value.bind(source) as (...args: never[]) => unknown);
      }
      server.registerUsageSource(wrapped as unknown as typeof source);
    },
    registerSettings: definition => server.registerSettings(definition),
  };
  // 原上下文没有的方法保持缺失，调用方用可选链判断。
  for (const key of Object.keys(scoped) as (keyof PluginServerContext)[]) {
    if (typeof (server as unknown as Record<string, unknown>)[key] !== 'function') delete scoped[key];
  }
  return scoped as PluginServerContext;
}
