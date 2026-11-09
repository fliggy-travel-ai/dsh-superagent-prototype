import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as rpc from '../../../shared/claude-accounts.ts';
import { continuityInput } from '../../../shared/continuity-input.ts';
import { legacyPluginStatus } from '../../core/legacy-plugins.ts';
import { createSettingsStore } from '../../core/settings-store.ts';
import { isMainInstance, type Module } from '../types.ts';
import { APPLE_SUFFIX, isAppleRelay, listAccounts } from './accounts.ts';
import { CLAUDE_ACCOUNTS_FALLBACK, ClaudeAccountsSectionSchema, QuotaSettingsSchema, quotaDefaults, type ClaudeAccountsSection } from './config.ts';
import { ContinuousUsage } from './continuous-usage.ts';
import { backupConfigFile, verifyProviderEntry, writeProviderEntry } from '../../core/provider-config.ts';
import { baseLabel, withQuota } from './labels.ts';
import { readLabels, setLabel } from './labels-file.ts';
import { ensureConfigDirectory, LoginFlows, readAuthStatus } from './login.ts';
import { migrateLegacyClaudeQuota } from './migrate.ts';
import { bundledClaudeUsageInstalled, discoverAccounts, isClaudeProvider } from './providers.ts';
import { QuotaLabelService } from './quota-labels.ts';
import { cli, ResumeService } from './resume.ts';

const ICON = 'server/vendor/paseo-0.15.0/claude-usage-source/icon.svg';

const emptySnapshot = (error: string): rpc.ClaudeAccountsSnapshot => ({
  enabled: false, accounts: [], quotaName: { enabled: false, lowestRemainingPct: null, autoResumeDefault: false, hiddenBuiltinSources: [] }, activeFlow: null, error,
});

/**
 * Claude 账号额度：额度来源、额度耗尽后自动继续、登录续期、Provider 显示名称加额度、账号显示标签、
 * 跨用户查询，以及页面用的账号列表、设置和添加账号引导。替代旧插件 claude-quota-resume。
 *
 * 旧插件仍启用时整个模块拒绝启动（跳过额度来源并报错）：来源 ID 重复会让整个实例停止，
 * 两处同时改写 Provider 显示名称并重复发送继续消息。
 */
export const claudeAccountsModule: Module<ClaudeAccountsSection> = {
  id: 'usage.claudeAccounts',
  label: 'Claude 账号额度',
  defaultEnabled: false,
  appliesTo: isMainInstance,
  config: { section: 'claudeAccounts', spec: { schema: ClaudeAccountsSectionSchema, fallback: CLAUDE_ACCOUNTS_FALLBACK } },
  register(context) {
    const { server, config, services } = context;
    const home = services.home;
    const directory = join(context.stateDirectory, 'quota');
    const labelsFile = join(context.baseDirectory, 'labels.json');
    const settings = createSettingsStore(join(directory, 'settings.json'), QuotaSettingsSchema, quotaDefaults(config));

    const legacy = legacyPluginStatus(home, config.legacyPluginId);
    if (legacy.enabled) {
      const message = `${legacy.problem ?? `旧插件 ${config.legacyPluginId} 仍启用`}，已跳过额度来源 ${config.sourceId} 和整个模块。先停用旧插件，再重载本插件。`;
      server.handle(rpc.claudeAccountsSnapshot, async () => emptySnapshot(message));
      const refuse = async () => { throw new Error(message); };
      server.handle(rpc.claudeAccountsConfigure, refuse);
      server.handle(rpc.claudeAccountsRename, refuse);
      server.handle(rpc.claudeAccountsLoginStart, refuse);
      server.handle(rpc.claudeAccountsLoginSubmitCode, refuse);
      server.handle(rpc.claudeAccountsLoginRetry, refuse);
      context.fail(new Error(message));
      return;
    }

    const migration = migrateLegacyClaudeQuota(config.legacyDirectory ?? join(home, config.legacyPluginId), directory, labelsFile);
    if (migration.report.copied.length || migration.labels.added) console.error(`[开发自动化·Claude 额度] 已复制旧状态：${migration.report.copied.join('、') || '无文件'}；并入标签 ${migration.labels.added} 条。旧文件未改动。`);

    // 自带的 Claude 额度插件只读默认账号。它在时本来源只补其他账号；它不在时本来源报告全部账号。
    const includeDefault = !bundledClaudeUsageInstalled();
    const usage = new ContinuousUsage({ home, directory, renewal: config.renewal });
    server.registerUsageSource({
      id: config.sourceId,
      label: includeDefault ? 'Claude' : 'Claude 其他账号',
      icon: ICON,
      input: continuityInput,
      discover: scope => discoverAccounts(scope, usage.discover, { includeDefault, labels: () => readLabels(labelsFile) }),
      fetch: usage.fetch,
    });

    const sources: ReadonlySet<string> = new Set(['claude', config.sourceId]);
    const service = new ResumeService({ isClaudeProvider: id => isClaudeProvider(id), directory, sources, autoResumeDefault: () => settings.read().autoResumeDefault });
    server.handle(rpc.quotaRetryStatus, async ({ agentId, text, messageId }, { paseo }) => {
      const enabled = service.isEnabled(agentId);
      const retryAt = service.retryAt(agentId);
      if (retryAt === null) return { retryAt: null, enabled };
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 30 });
      const last = page.entries.at(-1)?.item;
      if (!last || last.type !== 'assistant_message' || last.text !== text || (messageId && last.messageId !== messageId)) return { retryAt: null, enabled };
      return { retryAt: service.retryAt(agentId), enabled: service.isEnabled(agentId) };
    });
    server.handle(rpc.quotaSetAutoResume, async ({ agentId, enabled }) => {
      service.setEnabled(agentId, enabled);
      return { enabled: service.isEnabled(agentId) };
    });
    const removeStart = server.on('agent.turn_started', async ({ agent }) => {
      if (isClaudeProvider(agent.provider)) await service.cancel(agent.id);
    });
    const removeArchive = server.on('agent.archived', async ({ agent }) => { await service.forget(agent.id); });
    const removeEnd = server.on('agent.turn_ended', async (event, { paseo }) => {
      if (!isClaudeProvider(event.agent.provider) || event.outcome.kind === 'canceled') return;
      try {
        const page = await paseo.agents.ref(event.agent.id).timeline.refetch({ direction: 'tail', limit: 100 });
        let messages = '';
        for (const { item } of page.entries) {
          if (item.type === 'user_message') messages = '';
          else if (item.type === 'assistant_message') messages += item.text + '\n';
          else if (item.type === 'error' || item.type === 'notification') messages += item.message + '\n';
        }
        if (event.outcome.kind === 'failed') messages += '\n' + event.outcome.error.message;
        await service.consider(event.agent.id, messages);
      } catch (error) { console.warn('无法检查 Claude 会话：', String(error)); }
    });
    void service.start();
    // 选择 Agent 的列表没有插件扩展位置，所以把剩余额度写进 Provider 显示名称。
    const labels = new QuotaLabelService({ discover: usage.discover, cached: key => usage.history.cached(key), home, sourceId: config.sourceId, enabled: settings.read().labelWithQuota });
    labels.start();
    usage.start();

    // —— 页面用的 RPC ——
    const providersRaw = (): Record<string, any> => {
      try { return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).agents?.providers ?? {}; } catch { return {}; }
    };
    const baseEnv = () => { const env = { ...process.env }; delete env.CLAUDE_CONFIG_DIR; return env; };
    const providerEnv = (id: string): NodeJS.ProcessEnv => ({ ...baseEnv(), ...Object.fromEntries(Object.entries(providersRaw()[id]?.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    // 守护进程的 config.patch 只保存 enabled、additionalModels、paseoTools，不保存 extends、env、models、label：
    // 直接写 config.json（备份、原子写入、写后读回核对），再让 Paseo 重载。
    const writeProvider = (id: string, entry: Record<string, unknown>, backup: string | null) => {
      writeProviderEntry(home, id, entry);
      verifyProviderEntry(home, id, entry, backup);
    };
    const reloadProviders = async () => { await cli(['reload', '--json']); };
    const rewriteLabel = async (id: string, label: string) => {
      const backup = backupConfigFile(home);
      writeProvider(id, { label }, backup);
      await reloadProviders();
    };
    const flows = new LoginFlows({
      homeDirectory: homedir(),
      providers: providersRaw,
      backupConfig: () => backupConfigFile(home),
      writeProvider,
      reloadProviders,
      ensureConfigDirectory: dir => ensureConfigDirectory(dir, join(homedir(), '.claude')),
      findLoginWorkspace: async () => {
        const { paseo } = await services.daemon.ready();
        const found = (await paseo.workspaces.list()).entries.find(workspace => workspace.name === config.loginWorkspaceName);
        return found ? { id: found.id, cwd: found.workspaceDirectory || found.projectRootPath } : null;
      },
      createTerminal: async (workspaceId, name, cwd) => {
        const { paseo, client } = await services.daemon.ready();
        const terminal = await paseo.terminals.create({ workspaceId, name, cwd });
        return {
          id: terminal.id,
          write: data => { terminal.write(data); },
          sendKeys: keys => { terminal.sendKeys(keys); },
          capture: async () => (await client.captureTerminal(terminal.id, { stripAnsi: true })).lines,
          kill: () => terminal.kill(),
        };
      },
      authStatus: readAuthStatus,
      setLabel: (key, value) => setLabel(labelsFile, key, value),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });

    const snapshot = async (): Promise<rpc.ClaudeAccountsSnapshot> => {
      const accounts = await listAccounts({
        home, homeDirectory: homedir(), baseEnv: baseEnv(), labels: () => readLabels(labelsFile), quotas: labels.quotas(),
        needsLogin: env => usage.needsLogin(env), identityEmail: env => usage.identityEmail(env),
      });
      const known = accounts.map(account => account.remainingPct).filter((value): value is number => value !== null);
      const current = settings.read();
      return {
        enabled: true,
        accounts,
        quotaName: { enabled: current.labelWithQuota, lowestRemainingPct: known.length ? Math.min(...known) : null, autoResumeDefault: current.autoResumeDefault, hiddenBuiltinSources: bundledClaudeUsageInstalled() ? [] : ['claude-usage-source'] },
        activeFlow: flows.current(),
        error: settings.error(),
      };
    };
    server.handle(rpc.claudeAccountsSnapshot, snapshot);
    server.handle(rpc.claudeAccountsConfigure, async input => {
      settings.update(input);
      if (input.labelWithQuota !== undefined) await labels.setEnabled(input.labelWithQuota);
      return snapshot();
    });
    server.handle(rpc.claudeAccountsRename, async ({ providerId, label, realEmail }) => {
      const provider = providersRaw()[providerId] ?? (providerId === 'claude' ? {} : undefined);
      if (!provider) throw new Error(`Provider ${providerId} 不存在`);
      const quota = labels.quotas().get(providerId) ?? null;
      const withName = (name: string) => settings.read().labelWithQuota ? withQuota(name, quota) : baseLabel(name);
      if (realEmail !== undefined) {
        const real = realEmail.trim().toLowerCase();
        if (!(await flows.confirmRealEmail(providerId, real))) {
          const hidden = usage.identityEmail(providerEnv(providerId));
          if (!hidden || !isAppleRelay(hidden)) throw new Error('这个账号不是 Apple 登录，不需要确认真实邮箱');
          setLabel(labelsFile, hidden, `${real}${APPLE_SUFFIX}`);
          await rewriteLabel(providerId, withName(`Claude · ${real}${APPLE_SUFFIX}`));
        }
      }
      if (label !== undefined) await rewriteLabel(providerId, withName(label));
      return snapshot();
    });
    // 添加账号引导在真机验证前默认关闭（claudeAccounts.loginGuide）。
    const guide = <T>(run: () => Promise<T>) => async () => {
      if (!config.loginGuide) throw new Error('添加账号引导还没有开放：在真机上验证后，把 machine.json 的 claudeAccounts.loginGuide 设为 true');
      return run();
    };
    server.handle(rpc.claudeAccountsLoginStart, async input => { await guide(() => flows.start(input))(); return snapshot(); });
    server.handle(rpc.claudeAccountsLoginSubmitCode, async input => { await guide(() => flows.submitCode(input))(); return snapshot(); });
    server.handle(rpc.claudeAccountsLoginRetry, async ({ providerId }) => { await guide(() => flows.retry(providerId))(); return snapshot(); });

    return async () => { removeStart(); removeArchive(); removeEnd(); service.stop(); await usage.stop(); await labels.stop(); };
  },
};
