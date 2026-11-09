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

import React, { isValidElement, type ReactElement, type ReactNode } from 'react';

interface RenderedNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RenderedNode | string>;
}

function findNodes(
  node: RenderedNode | string,
  predicate: (n: RenderedNode) => boolean,
  out: RenderedNode[] = [],
): RenderedNode[] {
  if (typeof node === 'string') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children) findNodes(child, predicate, out);
  return out;
}

function collectText(node: RenderedNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(collectText).join('');
}

function createTestRenderer() {
  let hookStatesByComp = new Map< unknown, unknown[] >();
  let hookCursorsByComp = new Map< unknown, number >();
  let activeComp: unknown = 'root';
  const contextValues = new Map<unknown, unknown>();
  const dispatcher = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: Record<string, unknown> };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  function walk(element: ReactNode): RenderedNode | string {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) {
      return { type: 'Fragment', props: {}, children: element.map(walk).filter(c => c !== '') };
    }
    if (!isValidElement(element)) return '';
    const el = element as ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function') {
      const proto = (el.type as { prototype?: { isReactComponent?: boolean } }).prototype;
      if (proto && proto.isReactComponent) {
        const Ctor = el.type as unknown as new (props: Record<string, unknown>) => {
          state?: unknown;
          render(): ReactNode;
        };
        const instance = new Ctor(el.props);
        try {
          return walk(instance.render());
        } catch (err) {
          const getDerived = (el.type as unknown as { getDerivedStateFromError?: (e: unknown) => unknown })
            .getDerivedStateFromError;
          if (getDerived) {
            instance.state = { ...(instance.state as object), ...(getDerived(err) as object) };
            return walk(instance.render());
          }
          throw err;
        }
      }
      const prevComp = activeComp;
      const count = (hookCursorsByComp.get(el.type) ?? 0) + 1;
      hookCursorsByComp.set(el.type, count);
      const compKey = `${(el.type as { name?: string }).name || 'fn'}:${count}`;
      activeComp = compKey;
      hookCursorsByComp.set(compKey, 0);
      try {
        const fn = el.type as (props: Record<string, unknown>) => ReactNode;
        return walk(fn(el.props));
      } finally {
        activeComp = prevComp;
      }
    }
    if (typeof el.type === 'object' && el.type !== null && 'value' in el.props) {
      contextValues.set((el.type as { _context?: unknown })._context ?? el.type, el.props.value);
      return walk(el.props.children as ReactNode);
    }
    const rawChildren = el.props.children;
    const childList = Array.isArray(rawChildren) ? rawChildren : rawChildren !== undefined ? [rawChildren] : [];
    return {
      type: String(el.type),
      props: el.props,
      children: childList.map(walk).filter(c => c !== ''),
    };
  }

  return {
    reset() {
      hookStatesByComp = new Map();
    },
    render(factory: () => ReactNode): RenderedNode {
      hookCursorsByComp = new Map();
      activeComp = 'root';
      const prevH = dispatcher?.H;
      const customDispatcher = {
        useState(init: unknown) {
          const compKey = activeComp;
          let states = hookStatesByComp.get(compKey);
          if (!states) {
            states = [];
            hookStatesByComp.set(compKey, states);
          }
          const idx = hookCursorsByComp.get(compKey) ?? 0;
          hookCursorsByComp.set(compKey, idx + 1);
          if (idx >= states.length) {
            states[idx] = typeof init === 'function' ? (init as () => unknown)() : init;
          }
          const setState = (next: unknown) => {
            const arr = hookStatesByComp.get(compKey)!;
            arr[idx] =
              typeof next === 'function' ? (next as (prev: unknown) => unknown)(arr[idx]) : next;
          };
          return [states[idx], setState];
        },
        useEffect() {},
        useMemo(fn: () => unknown) {
          return fn();
        },
        useContext(ctx: { _currentValue?: unknown }) {
          return contextValues.has(ctx) ? contextValues.get(ctx) : ctx._currentValue;
        },
        useSyncExternalStore(_sub: unknown, getSnap: () => unknown) {
          return getSnap();
        },
      };
      if (dispatcher) dispatcher.H = customDispatcher;
      try {
        return walk(factory()) as RenderedNode;
      } finally {
        if (dispatcher && prevH) dispatcher.H = prevH;
      }
    },
  };
}

test('审阅项 A：预览宿主支持 route=screen:settings 并展示开发自动化设置页与 8 位指纹说明', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { createPreview } = await import('./ui/host.tsx');

  const { App, handle } = createPreview({
    scene: 'shadow',
    layout: 'wide',
    theme: 'dark',
    route: 'screen:settings',
  });
  const renderer = createTestRenderer();
  try {
    const tree = renderer.render(() => React.createElement(App));
    const text = collectText(tree);
    assert.equal(text.includes('页面 settings 不存在'), false);
    assert.match(text, /开发自动化设置/);
    assert.match(text, /8 位指纹/);
    assert.equal(text.includes('哈希后四位指纹'), false);
  } finally {
    handle.dispose();
  }
});

test('审阅项 1/8/11/12/B/C/D：默认设置空规则不注入高危示例、Claude 重登带 providerId、升级通知文案与默认时段、云端会话文案与真实扩展路径', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { MainScreen } = await import('../client/dashboard.tsx');
  const { bind } = await import('../client/ui.tsx');
  const { FakeDaemon } = await import('./ui/fake-daemon.ts');

  const daemon = new FakeDaemon('shadow');
  // 校验 FakeDaemon 的升级通知默认夹具已对齐真实默认值
  assert.deepEqual(daemon.escalation.immediate, [
    { days: 'daily', from: '01:00', to: '09:30' },
    { days: 'weekdays', from: '12:00', to: '14:00' },
  ]);
  assert.equal(daemon.escalation.delayMinutes, 0);
  assert.ok(daemon.browser.extensionPath?.endsWith('/browser-extension'));

  const mockTheme = {
    colors: {
      surface0: '#151517',
      surface1: '#1c1c1f',
      surface2: '#2b2b2f',
      border: '#303035',
      foreground: '#ececef',
      foregroundMuted: '#8e8e95',
      accent: '#5b8cff',
      accentForeground: '#ffffff',
      statusSuccess: '#4cc274',
      statusWarning: '#e3a33b',
      statusDanger: '#ff6b66',
    },
  };

  const startedLogins: Array<{ providerId?: string }> = [];
  const baseControlState = {
    automation: daemon.automation,
    browser: daemon.browser,
    presence: daemon.presence,
    stalled: null,
    stalledError: null,
    automationError: null,
    browserError: null,
    presenceError: null,
    modules: null,
    machineSettings: daemon.machineSettings,
    todo: daemon.todo,
    todoError: null,
    defaults: { enabled: false, rules: [], error: null },
    providerInstance: {
      instanceState: 'running' as const,
      instanceError: null,
      runningSessionsCount: 2,
      providers: [{ id: 'cloud-session', label: '云端会话', available: true, runningSessions: 1 }],
      cloudSession: { enabled: true, onlineSessions: 1, unackedMessages: 0 },
    },
    cloudSession: { enabled: true, onlineSessions: 1, unackedMessages: 0 },
    claudeAccounts: {
      ...daemon.claudeAccounts,
      activeFlow: {
        providerId: 'claude-2',
        configDir: '~/.claude-2',
        step: 4,
        terminalId: 't1',
        workspaceId: 'w1',
        loginUrl: 'https://claude.ai/oauth',
        detectedEmail: 'relay@example.test', // scan-allow
        requiresRealEmailConfirmation: true,
        error: null,
      },
    },
    claudeAccountsStatus: 'ready' as const,
    claudeAccountsError: null,
    antigravity: { enabled: false, runningSessionsCount: 0, reloadRequired: false, error: null, accounts: [] },
    antigravityStatus: 'disabled' as const,
    antigravityError: null,
    providerQuotas: null,
    providerQuotasStatus: 'disabled' as const,
    escalation: { ...daemon.escalation, enabled: false, status: 'stopped' as const },
    escalationStatus: 'ready' as const,
    escalationError: null,
    quiet: daemon.quiet,
    quietStatus: 'ready' as const,
    quietError: null,
  };

  const BoundMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: daemon.state, error: null, loaded: true }),
      } as never,
      control: {
        subscribe: () => () => {},
        getState: () => baseControlState,
        startClaudeLogin: async (input: { providerId?: string }) => {
          startedLogins.push(input);
          return baseControlState.claudeAccounts;
        },
        bluetoothDevices: async () => ({ target: null, devices: [], error: null }),
      } as never,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );

  const renderer = createTestRenderer();

  // 1. Providers 页（空规则显示 0 条规则、云端会话正确文案且无假开关、无账号且未启用时隐藏 Antigravity 卡片）
  renderer.reset();
  let tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'session-defaults' },
    } as never),
  );
  let text = collectText(tree);
  assert.match(text, /0 条规则/);
  assert.match(text, /没有规则/);
  assert.equal(text.includes('bypassPermissions'), false, '空规则时不应渲染高危示例规则');
  assert.match(text, /把 claude\.ai 网页中运行的云端 Claude Code 会话接入 Paseo/);
  assert.equal(text.includes('飞猪云端开发环境'), false);
  const cloudSwitch = findNodes(tree, n => n.type === 'Switch' && n.props.accessibilityLabel === '云端会话');
  assert.equal(cloudSwitch.length, 0, '云端会话卡片不应有开关');
  const quotaCardSwitch = findNodes(tree, n => n.type === 'Switch' && n.props.accessibilityLabel === 'Claude 名称带额度');
  assert.equal(quotaCardSwitch.length, 0, 'Claude 名称带额度卡片不应有开关');
  assert.match(text, /当前最低 48%/);
  assert.match(text, /1 个在线/);

  // 1b. 新增项 E：Claude 名称带额度抽屉（claude-quota）不显示“在名称后显示剩余额度”开关，只保留自动继续默认开关
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'claude-quota' },
    } as never),
  );
  text = collectText(tree);
  assert.equal(text.includes('在名称后显示剩余额度'), false, '抽屉不应有名称带额度关闭开关');
  assert.match(text, /新建 Claude 会话默认开启自动继续/);

  // 2. Claude 账号抽屉：显示“配置目录”列，不重复显示“剩余额度”列
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'claude-accounts' },
    } as never),
  );
  text = collectText(tree);
  assert.match(text, /配置目录/);
  assert.equal(text.includes('剩余额度'), false, 'Claude 账号抽屉不应重复展示剩余额度列');

  // 3. 点击“重新登录”带入 claude-2 并展示 Apple 真实邮箱确认与重试按钮
  const reloginBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '重新登录')[0]!;
  (reloginBtn.props.onPress as () => void)();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers' },
    } as never),
  );
  text = collectText(tree);
  const realEmailInput = findNodes(tree, n => n.type === 'TextInput' && n.props.accessibilityLabel === '真实邮箱');
  assert.equal(realEmailInput.length, 1, 'requiresRealEmailConfirmation 时应显示真实邮箱输入框');
  const retryBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '重试');
  assert.equal(retryBtn.length, 1, '应提供重试按钮');
  const startBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '生成登录链接')[0]!;
  await (startBtn.props.onPress as () => Promise<void>)();
  assert.deepEqual(startedLogins[0], { providerId: 'claude-2' });

  // 4. 问题答复页与升级通知抽屉：正确文案、status=stopped 显示“未运行”、无蓝牙假开关、可编辑时段与最近投递记录
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'answer', drawer: 'escalation' },
    } as never),
  );
  text = collectText(tree);
  assert.match(text, /主会话有提问未回答时，按时段规则通知 Grok/);
  assert.match(text, /未运行/);
  assert.match(text, /01:00/);
  assert.match(text, /12:00/);
  assert.match(text, /最近投递记录/);
  const btSwitch = findNodes(tree, n => n.type === 'Switch' && n.props.accessibilityLabel === '蓝牙在场判定');
  assert.equal(btSwitch.length, 0, '蓝牙卡片不应放置偷偷改问答模式的假开关');

  // 5. 新增项 F：GitHub 订阅页顶部保留“监听”卡片与编辑面板，下方复用 client/screen/ 的订阅/事件/状态三视图
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'github' },
    } as never),
  );
  text = collectText(tree);
  assert.match(text, /轮询已订阅的仓库与 PR/);
  assert.match(text, /按仓库/);
  assert.match(text, /按会话/);
  assert.equal(text.includes('最近事件（默认收起）'), false, '不应保留 dashboard 简化版折叠事件列表');

  // 切换到“事件”视图和“状态”视图
  const eventsSegBtn = findNodes(tree, n => n.type === 'Pressable' && collectText(n).startsWith('事件'))[0]!;
  (eventsSegBtn.props.onPress as () => void)();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'github' },
    } as never),
  );
  text = collectText(tree);
  assert.match(text, /有过滤/);
  assert.match(text, /送达异常/);

  const statusSegBtn = findNodes(tree, n => n.type === 'Pressable' && collectText(n).includes('状态'))[0]!;
  (statusSegBtn.props.onPress as () => void)();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'github' },
    } as never),
  );
  text = collectText(tree);
  assert.match(text, /请求额度/);
  assert.match(text, /本小时送达/);
  assert.match(text, /监听的仓库/);
});

test('审阅项 5/7/14：待办“打开会话”传递 serverId，网页提问未选择时禁用提交，操作返回 ok: false 显示错误，ErrorBoundary 捕获渲染异常', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { MainScreen } = await import('../client/dashboard.tsx');
  const { bind } = await import('../client/ui.tsx');
  const { FakeDaemon } = await import('./ui/fake-daemon.ts');

  const daemon = new FakeDaemon('shadow');
  const openedAgents: Array<{ agentId: string; serverId?: string }> = [];
  const mockTheme = {
    colors: {
      surface0: '#151517',
      surface1: '#1c1c1f',
      surface2: '#2b2b2f',
      border: '#303035',
      foreground: '#ececef',
      foregroundMuted: '#8e8e95',
      accent: '#5b8cff',
      accentForeground: '#ffffff',
      statusSuccess: '#4cc274',
      statusWarning: '#e3a33b',
      statusDanger: '#ff6b66',
    },
  };

  const BoundMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: daemon.state, error: null, loaded: true }),
      } as never,
      control: {
        subscribe: () => () => {},
        getState: () => ({
          automation: daemon.automation,
          browser: daemon.browser,
          presence: daemon.presence,
          stalled: null,
          stalledError: null,
          automationError: null,
          browserError: null,
          presenceError: null,
          modules: null,
          machineSettings: daemon.machineSettings,
          todo: {
            ...daemon.todo,
            items: daemon.todo.items.map(it => ({ ...it, hostId: 'srv-remote-mini' })),
          },
          todoError: null,
          defaults: daemon.defaults,
          providerInstance: null,
          cloudSession: null,
          claudeAccounts: daemon.claudeAccounts,
          claudeAccountsStatus: 'ready' as const,
          claudeAccountsError: null,
          antigravity: daemon.antigravity,
          antigravityStatus: 'ready' as const,
          antigravityError: null,
          providerQuotas: null,
          providerQuotasStatus: 'disabled' as const,
          escalation: daemon.escalation,
          escalationStatus: 'ready' as const,
          escalationError: null,
          quiet: daemon.quiet,
          quietStatus: 'ready' as const,
          quietError: null,
        }),
        actTodo: async () => ({ ok: false, message: '远端主机拒绝了该操作' }),
      } as never,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );

  const renderer = createTestRenderer();
  renderer.reset();
  let tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'todo' },
      navigation: {
        openAgent: (target: { agentId: string; serverId?: string }) => openedAgents.push(target),
        openWorkspace: () => {},
      },
    } as never),
  );

  // 点击“打开会话”应传入 serverId: 'srv-remote-mini'
  const openAgentBtns = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '打开会话');
  assert.ok(openAgentBtns.length >= 1);
  (openAgentBtns[0]!.props.onPress as () => void)();
  assert.deepEqual(openedAgents[0], { agentId: 'agent-main', serverId: 'srv-remote-mini' });

  // 展开网页提问卡片：初始未选择时“提交回答”按钮必须 disabled
  const answerExpandBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '回答')[0]!;
  (answerExpandBtn.props.onPress as () => void)();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'todo' },
    } as never),
  );
  const submitBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '提交回答')[0]!;
  assert.equal(submitBtn.props.disabled, true, '未选择任何选项或填写其他内容时应禁用提交按钮');

  // 点击“标为已处理”，当返回 { ok: false, message } 时卡片显示错误提示
  const ackBtn = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '标为已处理')[0]!;
  await (ackBtn.props.onPress as () => Promise<void>)();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'todo' },
    } as never),
  );
  assert.match(collectText(tree), /远端主机拒绝了该操作/);

  // 验证 bind 的 ErrorBoundary 捕获渲染抛错
  const ThrowingScreen = () => {
    throw new Error('模拟子组件渲染崩溃');
  };
  const BoundThrowing = bind(
    {
      store: { subscribe: () => () => {}, getState: () => ({ snapshot: null, error: null, loaded: true }) } as never,
      control: { subscribe: () => () => {}, getState: () => ({}) } as never,
      openScreen: () => {},
    },
    ThrowingScreen,
  );
  renderer.reset();
  const errTree = renderer.render(() =>
    React.createElement(BoundThrowing, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
    } as never),
  );
  assert.match(collectText(errTree), /模拟子组件渲染崩溃/);
});

test('第二轮审阅 UI 修复（G–K、第 3/5/6/8 项）验证', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const React = (await import('react')).default;
  const { FakeDaemon } = await import('./ui/fake-daemon.ts');
  const { browserSnapshot } = await import('../shared/browser-contracts.ts');
  const { claudeAccountsSnapshot } = await import('../shared/claude-accounts.ts');
  const { escalationSnapshot } = await import('../shared/escalation.ts');
  const { quietSnapshot } = await import('../shared/quiet.ts');
  const { providerQuotasSnapshot } = await import('../shared/provider-quotas.ts');
  const { antigravitySnapshot } = await import('../shared/antigravity.ts');
  const { todoList } = await import('../shared/todo.ts');
  const { modulesStatus } = await import('../shared/modules.ts');
  const { defaultsSnapshot } = await import('../shared/defaults.ts');
  const { providersInstanceStatus, cloudSessionStatus } = await import('../shared/provider-instance.ts');
  const { machineSettingsSnapshot } = await import('../shared/machine-settings.ts');
  const { createControlStore } = await import('../client/control-store.ts');
  const { MainScreen } = await import('../client/dashboard.tsx');
  const { bind } = await import('../client/ui.tsx');
  const { SubscriptionsTab } = await import('../client/screen/subscriptions.tsx');

  const emptyAgentsList = async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } });

  // G: FakeDaemon 所有 RPC 输出过合约校验，且浏览器实例不含 sessionCount
  const fake = new FakeDaemon('shadow');
  fake.latencyMs = 0;
  for (const inst of fake.browser.instances as Array<Record<string, unknown>>) {
    assert.equal('sessionCount' in inst, false, 'FakeDaemon.browser.instances 不应含合约外字段 sessionCount');
  }
  const parsedBrowser = (await fake.rpc(browserSnapshot, {})) as { instances: Array<Record<string, unknown>> };
  for (const inst of parsedBrowser.instances) {
    assert.equal('sessionCount' in inst, false, '浏览器实例不应含合约外字段 sessionCount');
  }
  assert.ok(await fake.rpc(claudeAccountsSnapshot, {}));
  assert.ok(await fake.rpc(escalationSnapshot, {}));
  assert.ok(await fake.rpc(quietSnapshot, {}));
  assert.ok(await fake.rpc(providerQuotasSnapshot, {}));
  assert.ok(await fake.rpc(antigravitySnapshot, {}));
  assert.ok(await fake.rpc(todoList, {}));
  assert.ok(await fake.rpc(modulesStatus, {}));
  assert.ok(await fake.rpc(defaultsSnapshot, {}));
  assert.ok(await fake.rpc(providersInstanceStatus, {}));
  assert.ok(await fake.rpc(cloudSessionStatus, {}));
  assert.ok(await fake.rpc(machineSettingsSnapshot, {}));

  const mockTheme = {
    colors: {
      surface0: '#151517',
      surface1: '#1c1c1f',
      surface2: '#2b2b2f',
      border: '#303035',
      foreground: '#ececef',
      foregroundMuted: '#8e8e95',
      accent: '#5b8cff',
      accentForeground: '#ffffff',
      statusSuccess: '#4cc274',
      statusWarning: '#e3a33b',
      statusDanger: '#ff6b66',
    },
  };

  // H & 第 3 项：RPC 报错时卡片与抽屉显示“读取失败”，不伪装为正常/0个账号/运行中，也不出现 ?? 3 或 ?? 'Mac mini' 占位值
  const failingDaemon = {
    rpc: async (contract: { name: string }) => {
      throw new Error(`RPC 失败: ${contract.name}`);
    },
  };
  const errControl = createControlStore(failingDaemon as never, emptyAgentsList as never);
  await Promise.all([errControl.refresh(), errControl.refreshUnify()]);
  const errControlState = errControl.getState();
  assert.ok(errControlState.browserError);
  assert.ok(errControlState.providerInstanceError);

  const BoundErrMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: null, error: 'GitHub 订阅读取失败', loaded: true }),
      } as never,
      control: errControl,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );
  const renderer = createTestRenderer();
  let tree = renderer.render(() =>
    React.createElement(BoundErrMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'browser' },
    } as never),
  );
  const errProvidersText = collectText(tree);
  assert.match(errProvidersText, /读取失败/);
  assert.doesNotMatch(errProvidersText, /0 个账号/);
  assert.doesNotMatch(errProvidersText, /0 个浏览器环境/);
  assert.doesNotMatch(errProvidersText, /正在读取扩展目录/);

  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundErrMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'answer' },
    } as never),
  );
  const errAnswerText = collectText(tree);
  assert.doesNotMatch(errAnswerText, /3 个对话/);
  assert.doesNotMatch(errAnswerText, /Mac mini/);

  // J: 正常状态下“Claude 名称带额度”和“云端会话”卡片不重复显示“运行中 / 已开启”与“始终开启（默认功能）”
  const okFake = new FakeDaemon('shadow');
  okFake.latencyMs = 0;
  const okControl = createControlStore(okFake as never, emptyAgentsList as never);
  await Promise.all([okControl.refresh(), okControl.refreshUnify()]);
  const BoundOkMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: okFake.state, error: null, loaded: true }),
      } as never,
      control: okControl,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundOkMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers' },
    } as never),
  );
  const okProvidersText = collectText(tree);
  assert.doesNotMatch(okProvidersText, /始终开启（默认功能）/);

  // K: ClaudeQuotaDrawer 在 hideBuiltinApplied=false 时显示“未生效”
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundOkMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'claude-quota' },
    } as never),
  );
  assert.match(collectText(tree), /未生效/);

  // 第 5 项：SessionDefaultsDrawer 添加规则默认 newAutoApprove=false，五类 Provider 可选，调用 saveRules 不强制启用总开关
  let savedDefaultsCall: unknown = null;
  const defaultsDaemon = new FakeDaemon('shadow');
  defaultsDaemon.latencyMs = 0;
  const origRpc = defaultsDaemon.rpc.bind(defaultsDaemon);
  defaultsDaemon.rpc = async <I, O>(contract: { name: string }, input: I): Promise<O> => {
    if (contract.name === 'defaults.save') {
      savedDefaultsCall = input;
    }
    return origRpc(contract as never, input);
  };
  const defaultsControl = createControlStore(defaultsDaemon as never, emptyAgentsList as never);
  await Promise.all([defaultsControl.refresh(), defaultsControl.refreshUnify()]);
  const BoundDefaultsMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: defaultsDaemon.state, error: null, loaded: true }),
      } as never,
      control: defaultsControl,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundDefaultsMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'session-defaults' },
    } as never),
  );
  const defaultsText = collectText(tree);
  for (const p of ['claude*', 'codex', 'opencode', 'glm*', 'qoder']) {
    assert.ok(defaultsText.includes(p), `默认规则抽屉应提供 ${p} 选择`);
  }
  const providerInput = findNodes(tree, (el) => el.props.accessibilityLabel === 'Provider 匹配模式')[0];
  assert.ok(providerInput);
  (providerInput.props.onChangeText as (v: string) => void)('glm*');
  tree = renderer.render(() =>
    React.createElement(BoundDefaultsMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'session-defaults' },
    } as never),
  );
  const addRuleBtn = findNodes(tree, (el) => collectText(el).trim() === '添加规则' && typeof el.props.onPress === 'function')[0];
  assert.ok(addRuleBtn);
  await (addRuleBtn.props.onPress as () => Promise<void>)();
  assert.ok(savedDefaultsCall);
  const rulesSent = (savedDefaultsCall as { rules: Array<{ provider: string | string[]; features?: { autoApprove?: boolean } }> }).rules;
  const addedRule = rulesSent.find((r) => r.provider === 'glm*');
  assert.ok(addedRule);
  assert.equal(Boolean(addedRule.features?.autoApprove), false, '新规则默认不应开启 autoApprove');
  assert.equal('enabled' in (savedDefaultsCall as Record<string, unknown>), false, '添加规则不应偷偷把总开关 enabled 设为 true');

  // 第 6 项：EscalationDrawer 保留自定义星期数组（不改写成 weekdays），且快照加载后同步更新等待分钟输入框
  let savedEscConfig: unknown = null;
  const escDaemon = new FakeDaemon('shadow');
  escDaemon.latencyMs = 0;
  escDaemon.escalation = {
    ...escDaemon.escalation,
    delayMinutes: 15,
    immediate: [{ days: [1, 3, 5] as never, from: '10:00', to: '19:00' }],
  };
  const origEscRpc = escDaemon.rpc.bind(escDaemon);
  escDaemon.rpc = async <I, O>(contract: { name: string }, input: I): Promise<O> => {
    if (contract.name === 'escalation.configure') {
      savedEscConfig = input;
    }
    return origEscRpc(contract as never, input);
  };
  const escControl = createControlStore(escDaemon as never, emptyAgentsList as never);
  await Promise.all([escControl.refresh(), escControl.refreshUnify()]);
  const BoundEscMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: escDaemon.state, error: null, loaded: true }),
      } as never,
      control: escControl,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundEscMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'answer', drawer: 'escalation' },
    } as never),
  );
  const delayInput = findNodes(tree, (el) => el.props.accessibilityLabel === '其余时段等待分钟数')[0];
  assert.equal(delayInput?.props.value, '15');
  const saveScheduleBtn = findNodes(tree, (el) => collectText(el).trim() === '保存分钟' && typeof el.props.onPress === 'function')[0];
  assert.ok(saveScheduleBtn);
  await (saveScheduleBtn.props.onPress as () => Promise<void>)();
  assert.ok(savedEscConfig);
  const immediateSent = (savedEscConfig as { immediate: Array<{ days: unknown }> }).immediate;
  assert.deepEqual(immediateSent[0]?.days, [1, 3, 5], '自定义星期数组不应被改写为 weekdays');

  // 第 8b 项：AntigravityDrawer 含 homeDir 输入框
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundOkMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'antigravity' },
    } as never),
  );
  const homeDirInput = findNodes(tree, (el) => el.props.accessibilityLabel === 'Antigravity 目录')[0];
  assert.ok(homeDirInput, 'Antigravity 抽屉应包含 homeDir 输入框');

  // I: GitHub 订阅页会话列允许显示两行会话标题（numberOfLines=2）
  const BoundSubs = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: okFake.state, error: null, loaded: true }),
      } as never,
      control: okControl,
      openScreen: () => {},
      openSettings: () => {},
    },
    () => React.createElement(SubscriptionsTab),
  );
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundSubs, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
    } as never),
  );
  const sessionTitleNodes = findNodes(tree, (el) => el.type === 'Text' && el.props.numberOfLines === 2);
  assert.ok(sessionTitleNodes.length > 0, 'GitHub 订阅页会话名应允许 2 行显示');
});

test('第三轮审阅 UI 修复（第 2–5 项）：Claude 快照自带 error/disabled、默认规则段损坏禁用保存、GitHub 草稿不被轮询覆盖、暂停全部自动化状态与错误展示', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { FakeDaemon } = await import('./ui/fake-daemon.ts');
  const { createControlStore } = await import('../client/control-store.ts');
  const { MainScreen } = await import('../client/dashboard.tsx');
  const { bind } = await import('../client/ui.tsx');

  const emptyAgentsList = async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } });
  const mockTheme = {
    colors: {
      surface0: '#151517',
      surface1: '#1c1c1f',
      surface2: '#2b2b2f',
      border: '#303035',
      foreground: '#ececef',
      foregroundMuted: '#8e8e95',
      accent: '#5b8cff',
      accentForeground: '#ffffff',
      statusSuccess: '#4cc274',
      statusWarning: '#e3a33b',
      statusDanger: '#ff6b66',
    },
  };

  // 第 2 & 3 & 5 项：
  // - claudeAccounts 返回 { enabled: false, accounts: [], error: '旧插件 claude-quota-resume 仍启用', quotaName: { enabled: false, ... } }
  // - defaults 返回 { enabled: false, rules: [], error: 'agentDefaults 格式错误' }
  // - machineSettings 为 null 且 machineSettingsError 有值，automation.paused 为 true（验证不回退到 automation.paused）
  const daemon = new FakeDaemon('shadow');
  daemon.latencyMs = 0;
  daemon.claudeAccounts = {
    enabled: false,
    accounts: [],
    quotaName: { enabled: false, lowestRemainingPct: null, autoResumeDefault: false, hiddenBuiltinSources: [] },
    activeFlow: null,
    error: '旧插件 claude-quota-resume 仍启用',
  };
  daemon.defaults = {
    enabled: false,
    rules: [],
    error: 'agentDefaults 格式错误',
  };
  daemon.automation = { ...daemon.automation, paused: true };
  const origRpc = daemon.rpc.bind(daemon);
  daemon.rpc = async <I, O>(contract: { name: string }, input: I): Promise<O> => {
    if (contract.name === 'machine.settings.snapshot') {
      throw new Error('machine.json 读取失败');
    }
    return origRpc(contract as never, input);
  };

  const control = createControlStore(daemon as never, emptyAgentsList as never);
  await Promise.all([control.refresh(), control.refreshUnify()]);

  let currentSnapshot = structuredClone(daemon.state);
  const BoundMain = bind(
    {
      store: {
        subscribe: () => () => {},
        getState: () => ({ snapshot: currentSnapshot, error: null, loaded: true }),
      } as never,
      control,
      openScreen: () => {},
      openSettings: () => {},
    },
    MainScreen,
  );

  const renderer = createTestRenderer();
  let tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'claude-quota' },
    } as never),
  );
  const text = collectText(tree);
  // 第 2 项：Claude 账号与名称带额度卡片及抽屉均显示读取失败原因，不显示“0 个账号 正常”或“已开启”
  assert.match(text, /旧插件 claude-quota-resume 仍启用/);
  assert.doesNotMatch(text, /0 个账号/);
  assert.doesNotMatch(text, /已开启/);

  // 第 5 项：machineSettings 未读到时显示 machineSettingsError，按钮文字不回退到 automation.paused（仍为“暂停全部自动化”而非“恢复自动化”）且禁用
  assert.match(text, /machine\.json 读取失败/);
  assert.doesNotMatch(text, /恢复自动化/);
  const pauseBtn = findNodes(tree, el => el.type === 'Pressable' && el.props.accessibilityLabel === '暂停全部自动化')[0];
  assert.ok(pauseBtn);
  assert.equal(pauseBtn.props.disabled, true, 'machineSettings 未读到时暂停全部自动化按钮应禁用');

  // 第 3 项：defaults.error 非空时，首页默认设置开关、抽屉总开关与“添加规则”按钮全部禁用
  const cardDefaultSwitch = findNodes(tree, el => el.type === 'Switch' && el.props.accessibilityLabel === '新建会话默认设置')[0];
  assert.equal(cardDefaultSwitch?.props.disabled, true, 'defaults.error 非空时卡片开关应禁用');

  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'providers', drawer: 'session-defaults' },
    } as never),
  );
  const drawerDefaultSwitch = findNodes(tree, el => el.type === 'Switch' && el.props.accessibilityLabel === '启用新建会话默认设置')[0];
  assert.equal(drawerDefaultSwitch?.props.disabled, true, 'defaults.error 非空时抽屉开关应禁用');
  const addRuleBtn = findNodes(tree, el => el.type === 'Pressable' && el.props.accessibilityLabel === '添加规则')[0];
  assert.equal(addRuleBtn?.props.disabled, true, 'defaults.error 非空时添加规则按钮应禁用');

  // 第 4 项：GitHub 配置抽屉在用户输入草稿后，轮询产生新 snapshot.preferences 引用时不覆盖用户正在输入的内容
  renderer.reset();
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'github', drawer: 'github-config' },
    } as never),
  );
  const orgInput = findNodes(tree, el => el.props.accessibilityLabel === 'GitHub 组织')[0];
  assert.ok(orgInput);
  (orgInput.props.onChangeText as (v: string) => void)('my-editing-org');
  // 模拟轮询返回了新的 snapshot 和 preferences 对象引用
  currentSnapshot = structuredClone(daemon.state);
  tree = renderer.render(() =>
    React.createElement(BoundMain, {
      theme: mockTheme,
      host: { id: 'h1', label: 'Host' },
      layout: { compact: false, platform: 'web' },
      params: { page: 'github', drawer: 'github-config' },
    } as never),
  );
  const orgInputAfterPoll = findNodes(tree, el => el.props.accessibilityLabel === 'GitHub 组织')[0];
  assert.equal(orgInputAfterPoll?.props.value, 'my-editing-org', '轮询更新 snapshot 引用不应重置正在编辑的 GitHub 配置草稿');
});
