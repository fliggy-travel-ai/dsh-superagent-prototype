import type { AutomationSnapshot } from '../../shared/automation.ts';
import type { BrowserSnapshot } from '../../shared/browser.ts';

export const makeAutomation = (): AutomationSnapshot => ({
  hostName: 'Mac Mini（演示）', paused: true, policies: [], audit: [], error: null, truncated: false,
  sessions: [
    { id: 'native-backend', title: '订单服务开发', provider: 'claude', supportsAutomation: true, mode: 'acceptEdits', status: 'running', workspaceId: 'backend', workspacePath: '/演示工作区/后端',
      pending: [{ id: 'request-test', kind: 'tool', name: 'Bash', title: '运行 npm test', reason: '原生审批已暂停', state: 'manual' }] },
    { id: 'native-frontend', title: '订单服务开发', provider: 'claude-2', supportsAutomation: true, mode: 'acceptEdits', status: 'running', workspaceId: 'frontend', workspacePath: '/演示工作区/前端',
      pending: [{ id: 'request-question', kind: 'question', name: 'AskUserQuestion', title: '请选择发布范围', reason: '问题、计划和模式选择需要人工处理', state: 'manual' }] },
  ],
});

export const makeBrowser = (): BrowserSnapshot => ({
  settings: { enabled: false, port: 17373 }, connected: false, error: null, bindings: [],
  sessions: [
    { instanceId: 'browser-development', instanceName: '开发账号', sessionId: 'same-session', title: '订单服务开发', url: 'https://claude.ai/code/session_same-session', tabCount: 2, lastSeenAt: new Date().toISOString(), agentId: null, groupTitle: '订单服务开发' },
    { instanceId: 'browser-review', instanceName: '审阅账号', sessionId: 'same-session', title: '订单服务开发', url: 'https://claude.ai/code/session_same-session', tabCount: 1, lastSeenAt: new Date().toISOString(), agentId: null, groupTitle: '订单服务开发' },
  ],
});
