import { isMainInstance, type Module } from '../types.ts';
import { AgentDefaultsSchema, applyAgentDefaults, type AgentDefaultRule } from './rules.ts';
import { defaultsSave, defaultsSnapshot } from '../../../shared/defaults.ts';
import { patchMachineConfig } from '../../core/machine-writer.ts';

/**
 * 新建会话默认设置：规则来自 machine.json 的 `agentDefaults`。默认关闭，
 * 在 `modules` 中写 `"providers.defaults": true` 打开。替代 codex-speed-defaults、
 * opencode-auto-accept-default、qoder-permission-defaults 三个旧插件（停旧开新前不要同时打开）。
 */
export const defaultsModule: Module<AgentDefaultRule[]> = {
  id: 'providers.defaults',
  label: '新建会话默认设置',
  defaultEnabled: false,
  appliesTo: isMainInstance,
  config: { section: 'agentDefaults', spec: { schema: AgentDefaultsSchema, fallback: [] } },
  register({ server, config, machine }) {
    let currentEnabled = true;
    let currentRules = [...config];
    server.handle(defaultsSnapshot, async () => ({
      enabled: currentEnabled,
      rules: currentRules,
      error: null,
    }));
    server.handle(defaultsSave, async input => {
      if (input.enabled !== undefined) currentEnabled = input.enabled;
      if (input.rules !== undefined) currentRules = AgentDefaultsSchema.parse(input.rules);
      await patchMachineConfig(machine.path, raw => ({
        ...raw,
        modules: { ...(raw.modules && typeof raw.modules === 'object' ? (raw.modules as Record<string, unknown>) : {}), 'providers.defaults': currentEnabled },
        agentDefaults: currentRules,
      }));
      return { enabled: currentEnabled, rules: currentRules, error: null };
    });
    const remove = server.addHook('agent.create.before', async ({ request }) => currentEnabled ? applyAgentDefaults(request, currentRules) : request);
    return () => { remove(); };
  },
};
