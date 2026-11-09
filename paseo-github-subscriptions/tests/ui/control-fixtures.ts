import type { BrowserSnapshot } from '../../shared/browser.ts';
import type { PresenceSnapshot } from '../../shared/presence.ts';

export const makeBrowser = (): BrowserSnapshot => ({
  settings: { enabled: false, port: 17373 }, connected: false, error: null, bindings: [],
  sessions: [
    { instanceId: 'browser-development', instanceName: '开发账号', sessionId: 'same-session', title: '订单服务开发', url: 'https://claude.ai/code/session_same-session', tabCount: 2, lastSeenAt: new Date().toISOString(), agentId: null, groupTitle: '订单服务开发' },
    { instanceId: 'browser-review', instanceName: '审阅账号', sessionId: 'same-session', title: '订单服务开发', url: 'https://claude.ai/code/session_same-session', tabCount: 1, lastSeenAt: new Date().toISOString(), agentId: null, groupTitle: '订单服务开发' },
  ],
});

export const makePresence = (): PresenceSnapshot => ({
  settings: { mode: 'online', paused: false, speechEnabled: true, sourceHostId: null },
  localSpeechEnabled: true,
  observation: { mode: 'online', observedAt: new Date(0).toISOString(), reason: '已连接随身手机', source: 'bluetooth' },
  hostName: 'Mac Mini（演示）',
  hosts: [],
  error: null,
  questions: [
    {
      id: 'q-cloud-1',
      sessionId: 'cse_demo',
      fingerprint: 'fp-cloud-1',
      source: 'native',
      title: '云端会话提问',
      at: new Date(0).toISOString(),
      state: 'pending',
      reason: '在线，等待人工回答',
      prompts: [
        {
          question: '发布到哪个环境？',
          header: '环境',
          multiSelect: false,
          allowOther: true,
          options: [
            { label: '预发（推荐）', description: '先验证', recommended: true },
            { label: '生产', description: '正式环境', recommended: false },
          ],
        },
        {
          question: '需要执行哪些检查？',
          header: '检查',
          multiSelect: true,
          allowOther: true,
          options: [
            { label: '类型检查', description: 'tsc', recommended: true },
            { label: '集成测试', description: 'e2e', recommended: false },
          ],
        },
      ],
    },
  ],
});
