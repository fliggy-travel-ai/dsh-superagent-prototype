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
