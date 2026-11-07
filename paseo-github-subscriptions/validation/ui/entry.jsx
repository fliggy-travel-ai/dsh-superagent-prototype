import { createRoot } from 'react-dom/client';
import { AppRegistry } from 'react-native';
import { createPreview } from '../../tests/ui/host.tsx';

const params = new URLSearchParams(location.search);
const options = {
  scene: params.get('scene') ?? 'shadow',
  layout: params.get('layout') === 'compact' ? 'compact' : 'wide',
  theme: params.get('theme') === 'dark' ? 'dark' : 'light',
  route: params.get('route') ?? 'agent:agent-main',
};

document.getElementById('banner').innerHTML =
  `<b>FIXTURE 预览（react-native-web + 假守护进程）· 不是 Paseo 生产原生验收</b> · 场景 ${options.scene} · ${options.layout === 'wide' ? '宽屏' : '窄屏'} · ${options.theme === 'dark' ? '深色' : '浅色'} · 主题色为近似值`;
document.getElementById('root').className = options.layout;
document.body.className = options.layout;

// 记录控制台输出，用来核对令牌没有被写进日志。
const consoleLog = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    consoleLog.push(`${level}: ${args.map((item) => (item instanceof Error ? item.message : typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}`);
    original(...args);
  };
}

const { App, handle } = createPreview(options);
handle.consoleLog = consoleLog;
window.__ghsub = {
  options,
  daemon: handle.daemon,
  registry: handle.registry,
  consoleLog,
  dispose: () => handle.dispose(),
  /** 供验收脚本读取：当前注册的胶囊、事件序列、令牌调用记录（不含令牌内容）。 */
  report: () => ({
    pills: [...handle.registry.pills.values()].map((pill) => `${pill.agentId}:${pill.id}`),
    pillLabels: [...handle.registry.pills.values()].map((pill) => pill.button.label),
    events: handle.registry.events.slice(),
    screens: [...handle.registry.screens.keys()],
    sidebar: [...handle.registry.sidebar.keys()],
    rpc: handle.daemon.log.map((entry) => `${entry.name} ${entry.summary}`),
  }),
};
AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('root') });
