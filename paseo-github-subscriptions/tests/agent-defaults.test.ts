import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDefaultsSchema, applyAgentDefaults } from '../server/modules/providers-defaults/rules.ts';

const rules = AgentDefaultsSchema.parse([
  // 沿用 codex-speed-defaults：无条件设为完全访问和 Fast，去掉旧的 fast_mode。
  { provider: ['codex', 'codex-2', 'codex-3', 'codex-4', 'codex-5'], apply: 'always', modeId: 'full-access', features: { service_tier: 'priority' }, removeFeatures: ['fast_mode'] },
  // 沿用 codex-speed-defaults 中独立用户 Claude 的规则：没有模式或为 auto 时改为 Bypass。
  { provider: 'claude-user-pilot', modeId: 'bypassPermissions', replaceModeIds: ['auto'] },
  { provider: ['opencode', 'glm-acp-agent'], features: { auto_accept: true } },
  { provider: 'qoder', modeId: 'yolo', features: { auto_accept: true } },
]);
type Config = { provider: string; modeId?: string; featureValues?: Record<string, unknown>; [key: string]: unknown };
const create = (config: Config) => ({ config: { cwd: '/w', ...config } as Config });

test('Codex：与旧插件一致，无条件覆盖模式和服务层级', () => {
  const result = applyAgentDefaults(create({ provider: 'codex-3', modeId: 'read-only', model: 'gpt', featureValues: { fast_mode: true, keep: 1 } }), rules);
  assert.deepEqual(result.config, { cwd: '/w', provider: 'codex-3', modeId: 'full-access', model: 'gpt', featureValues: { keep: 1, service_tier: 'priority' } });
});

test('独立用户 Claude：没有模式或为 auto 时用 Bypass，保留显式的其他模式', () => {
  assert.equal(applyAgentDefaults(create({ provider: 'claude-user-pilot' }), rules).config.modeId, 'bypassPermissions');
  assert.equal(applyAgentDefaults(create({ provider: 'claude-user-pilot', modeId: 'auto' }), rules).config.modeId, 'bypassPermissions');
  assert.equal(applyAgentDefaults(create({ provider: 'claude-user-pilot', modeId: 'plan' }), rules).config.modeId, 'plan');
});

test('OpenCode 和 GLM：没有显式值时开启自动授权，显式值优先', () => {
  assert.deepEqual(applyAgentDefaults(create({ provider: 'opencode' }), rules).config.featureValues, { auto_accept: true });
  assert.deepEqual(applyAgentDefaults(create({ provider: 'glm-acp-agent', featureValues: { auto_accept: false } }), rules).config.featureValues, { auto_accept: false });
});

test('Qoder：没有显式值时用 yolo 和自动授权；显式模式优先', () => {
  assert.deepEqual(applyAgentDefaults(create({ provider: 'qoder' }), rules).config, { cwd: '/w', provider: 'qoder', modeId: 'yolo', featureValues: { auto_accept: true } });
  assert.equal(applyAgentDefaults(create({ provider: 'qoder', modeId: 'default' }), rules).config.modeId, 'default');
});

test('没有匹配规则时原样返回同一个对象', () => {
  const request = create({ provider: 'claude' });
  assert.equal(applyAgentDefaults(request, rules), request);
});

test('停用的规则不生效；前缀匹配用结尾星号', () => {
  const parsed = AgentDefaultsSchema.parse([{ provider: 'codex*', modeId: 'full-access', enabled: false }, { provider: 'grok*', modeId: 'auto' }]);
  assert.equal(applyAgentDefaults(create({ provider: 'codex' }), parsed).config.modeId, undefined);
  assert.equal(applyAgentDefaults(create({ provider: 'grok-multi' }), parsed).config.modeId, 'auto');
  assert.equal(applyAgentDefaults(create({ provider: 'grok' }), parsed).config.modeId, 'auto');
});

test('多条规则按顺序叠加', () => {
  const parsed = AgentDefaultsSchema.parse([{ provider: 'x', features: { a: 1 } }, { provider: 'x', features: { b: 2 }, modeId: 'm' }]);
  assert.deepEqual(applyAgentDefaults(create({ provider: 'x' }), parsed).config, { cwd: '/w', provider: 'x', modeId: 'm', featureValues: { a: 1, b: 2 } });
});

test('规则格式校验：未知字段和空 Provider 被拒绝', () => {
  assert.equal(AgentDefaultsSchema.safeParse([{ provider: '' }]).success, false);
  assert.equal(AgentDefaultsSchema.safeParse([{ provider: 'x', unknown: 1 }]).success, false);
  assert.equal(AgentDefaultsSchema.safeParse([{ provider: 'x', apply: 'sometimes' }]).success, false);
});
