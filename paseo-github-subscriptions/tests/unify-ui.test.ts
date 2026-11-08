import test from 'node:test';
import assert from 'node:assert/strict';

test('第二期客户端入口：注册 1 个主屏幕、2 行侧栏、1 个设置页与命令面板项，去掉旧重复入口', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { createPreview } = await import('./ui/host.tsx');

  const { handle } = createPreview({
    scene: 'shadow',
    layout: 'wide',
    theme: 'dark',
    route: 'screen:main',
  });
  try {
    assert.deepEqual([...handle.registry.screens.keys()], ['main']);
    assert.deepEqual([...handle.registry.sidebar.keys()], ['main', 'todo']);
    assert.deepEqual([...handle.registry.settingsScreens.keys()], ['dev-automation']);
    assert.deepEqual(
      [...handle.registry.commands.keys()],
      ['open-todo', 'qa-mode-online', 'qa-mode-offline', 'qa-mode-auto', 'pause-all'],
    );
  } finally {
    handle.dispose();
  }
});

test('第二期侧栏状态计算：待办只计插件待办，异常存在时标记感叹号', async () => {
  const { computeHasAlert, computeTodoCount } = await import('../client/sidebar-state.ts');
  const baseControl = {
    automation: null,
    browser: null,
    presence: null,
    stalled: null,
    stalledError: null,
    automationError: null,
    browserError: null,
    presenceError: null,
    modules: null,
    machineSettings: null,
    todo: {
      items: [
        {
          id: 'ask:1',
          type: 'ask' as const,
          label: '网页提问' as const,
          hostId: 'local',
          hostName: 'Mac mini',
          sourceLabel: '网页版 claude.ai',
          sessionTitle: '测试会话',
          at: new Date().toISOString(),
          ageText: '1 分钟',
          text: '问题 1',
        },
      ],
      logs: [],
      hosts: [],
      warning: null,
    },
    todoError: null,
    defaults: null,
    providerInstance: null,
    cloudSession: null,
    claudeAccounts: null,
    claudeAccountsStatus: 'disabled' as const,
    claudeAccountsError: null,
    antigravity: null,
    antigravityStatus: 'disabled' as const,
    antigravityError: null,
    providerQuotas: null,
    providerQuotasStatus: 'disabled' as const,
    escalation: null,
    escalationStatus: 'disabled' as const,
    escalationError: null,
    quiet: null,
    quietStatus: 'disabled' as const,
    quietError: null,
  };
  const baseStore = {
    snapshot: null,
    error: null,
    loaded: true,
  };

  assert.equal(computeTodoCount(baseControl), 1);
  assert.equal(computeHasAlert(baseStore, baseControl), false);

  const reloginControl = {
    ...baseControl,
    claudeAccounts: {
      enabled: true,
      accounts: [
        {
          providerId: 'claude-2',
          label: 'Claude 2',
          email: 'work@example.com',
          appleLogin: false,
          configDir: '~/.claude-2',
          needsRelogin: true,
          remainingPct: null,
        },
      ],
      quotaName: { enabled: true, lowestRemainingPct: null, autoResumeDefault: true, hiddenBuiltinSources: [] },
      activeFlow: null,
      error: null,
    },
  };
  assert.equal(computeHasAlert(baseStore, reloginControl), true);
});
