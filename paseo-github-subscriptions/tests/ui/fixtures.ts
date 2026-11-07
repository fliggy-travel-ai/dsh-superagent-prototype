// fixture 数据：只用于界面预览，不代表真实 GitHub 或 Paseo 数据。
import { eventTypes, PreferencesSchema, SnapshotSchema, type GithubEvent, type Snapshot, type Subscription } from '../../shared/model.ts';

export type Scene = 'shadow' | 'live' | 'empty' | 'error' | 'offline';
export const scenes: readonly Scene[] = ['shadow', 'live', 'empty', 'error', 'offline'];

export interface FixtureAgent {
  id: string;
  title: string;
  provider: string;
  workspaceId: string;
  parentAgentId: string | null;
  pinnedFor: string;
}

export const agents: readonly FixtureAgent[] = [
  { id: 'agent-daily', title: '【每日】代码清理', provider: 'claude', workspaceId: 'ws-daily', parentAgentId: null, pinnedFor: '4 小时' },
  { id: 'agent-main', title: '【GitHub 订阅】主会话', provider: 'claude', workspaceId: 'ws-main', parentAgentId: null, pinnedFor: '2 分钟' },
  { id: 'agent-trip', title: '【行程卡片】价格修复', provider: 'codex', workspaceId: 'ws-trip', parentAgentId: null, pinnedFor: '1 小时' },
  { id: 'agent-kb', title: '【知识库】检索排序', provider: 'opencode', workspaceId: 'ws-kb', parentAgentId: null, pinnedFor: '3 小时' },
  { id: 'agent-ui', title: '【GitHub 订阅】界面稿', provider: 'claude', workspaceId: 'ws-main', parentAgentId: 'agent-main', pinnedFor: '5 分钟' },
  { id: 'agent-poller', title: '【GitHub 订阅】轮询器开发', provider: 'codex', workspaceId: 'ws-main', parentAgentId: 'agent-main', pinnedFor: '12 分钟' },
];

const ORG = 'fliggy-travel-ai';
const T1673 = '服务端接收 GitHub 通知，经 Paseo 插件推给会话';

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const MIN = 60_000;
void MIN;

function sub(
  id: string,
  agentId: string,
  repo: string,
  number: number | null,
  isPr: boolean | null,
  title: string | null,
  events: Subscription['events'],
  lastMin: number | null,
  delivery: Subscription['lastDelivery'],
): Subscription {
  const agent = agents.find((item) => item.id === agentId);
  return {
    id,
    agentId,
    workspaceId: agent?.workspaceId ?? null,
    agentTitle: agent?.title ?? null,
    parentAgentId: agent?.parentAgentId ?? null,
    key: `${ORG}/${repo}${number ? `#${number}` : ''}`,
    scope: number ? 'thread' : 'repo',
    owner: ORG,
    repo,
    number,
    isPr,
    title,
    events,
    note: null,
    createdAt: minutes(600),
    updatedAt: minutes(5),
    expiresAt: null,
    lastEventAt: lastMin === null ? null : minutes(lastMin),
    lastEventId: null,
    delivered: lastMin === null ? 0 : 3,
    lastDelivery: delivery,
  };
}

const ok = (min: number) => ({ at: minutes(min), ok: true });
const all = [...eventTypes];

function subscriptions(): Subscription[] {
  return [
    sub('s-a', 'agent-main', 'deepseek-harness', 1673, true, T1673, all, 3, ok(3)),
    sub('s-b', 'agent-main', 'gestalt-travel-server', 412, false, '行程卡片价格与下单页不一致', ['comment', 'state'], 60, ok(60)),
    sub('s-c', 'agent-main', 'sub2api', null, null, null, ['opened', 'state', 'ci'], 1560, ok(1560)),
    sub('s-d', 'agent-ui', 'deepseek-harness', 1673, true, T1673, ['comment', 'review'], 5, ok(5)),
    sub('s-e', 'agent-ui', 'deepseek-harness', 1702, false, '界面稿：GitHub 订阅插件的胶囊、侧边栏与设置页', ['comment'], null, null),
    sub('s-f', 'agent-poller', 'deepseek-harness', 1690, true, '轮询器：按仓库读取列表并缓存条件请求标记', ['push', 'ci'], 12, { at: minutes(12), ok: false, error: '请求超时，将重试' }),
    sub('s-g', 'agent-trip', 'gestalt-travel-server', 412, false, '行程卡片价格与下单页不一致', ['comment'], 60, { at: minutes(10), ok: false, error: '会话无响应' }),
    sub('s-h', 'agent-kb', 'WeKnora', null, null, null, ['opened', 'state', 'ci'], 120, ok(120)),
    sub('s-i', 'agent-daily', 'sub2api', null, null, null, ['opened', 'state', 'ci'], 120, ok(120)),
  ];
}

function ev(id: string, repo: string, number: number | null, isPr: boolean | null, title: string | null, type: GithubEvent['type'], actor: string, min: number, text: string, extra: Partial<GithubEvent> = {}): GithubEvent {
  return { id, repo: `${ORG}/${repo}`, number, isPr, title, type, actor, at: minutes(min), url: `https://github.com/${ORG}/${repo}/${isPr ? 'pull' : 'issues'}/${number ?? ''}`, text, markerAgentId: null, ...extra };
}

function events(): GithubEvent[] {
  return [
    ev('e1', 'deepseek-harness', 1673, true, T1673, 'ci', 'GitHub Actions', 3, 'build、test 失败（提交 abc1234）', { ci: { failed: ['build', 'test'], running: false, summary: '2/7 失败' } }),
    ev('e2', 'deepseek-harness', 1673, true, T1673, 'comment', 'bbm9527', 3, '胶囊弹出层的取消订阅按钮已加上，计数会立即变化。', { markerAgentId: 'agent-ui' }),
    ev('e3', 'deepseek-harness', 1673, true, T1673, 'review', 'chen-yang', 5, '额度守护要先读剩余额度，再决定本轮是否降速。'),
    ev('e4', 'deepseek-harness', 1690, true, '轮询器', 'push', 'bbm9527', 12, '2 个新提交，最新 9f3e1c2'),
    ev('e5', 'WeKnora', 210, true, '检索重排', 'state', 'zhao-qi', 40, '检索结果按时间衰减重排', { closed: true }),
    ev('e6', 'gestalt-travel-server', 412, false, '行程卡片价格与下单页不一致', 'comment', 'wang-lei', 60, '下单页用的是含税价，卡片用的是不含税价。'),
    ev('e7', 'sub2api', 388, true, '订阅续费提醒', 'opened', 'liu-min', 120, '订阅续费提醒改为提前 3 天'),
    ev('e8', 'WeKnora', 205, false, '召回率', 'comment', 'zhao-qi', 125, '向量库升级后召回率下降了一点。'),
  ];
}

function deliveries(shadow: boolean): Snapshot['deliveries'] {
  const status = shadow ? 'shadow' : 'delivered';
  return [
    { id: 'd1', agentId: 'agent-main', eventIds: ['e1', 'e3'], at: minutes(3), status, error: null },
    { id: 'd2', agentId: 'agent-ui', eventIds: ['e3'], at: minutes(5), status, error: null },
    { id: 'd3', agentId: 'agent-main', eventIds: ['e2'], at: minutes(3), status, error: null },
    { id: 'd4', agentId: 'agent-poller', eventIds: ['e4'], at: minutes(12), status: 'unknown', error: null },
    { id: 'd5', agentId: 'agent-kb', eventIds: ['e5'], at: minutes(40), status: 'skipped', error: null },
    { id: 'd6', agentId: 'agent-main', eventIds: ['e6'], at: minutes(60), status, error: null },
    { id: 'd7', agentId: 'agent-trip', eventIds: ['e6'], at: minutes(60), status: 'failed', error: '会话无响应' },
  ];
}

export function makeSnapshot(scene: Scene): Snapshot {
  const shadow = scene !== 'live';
  const failing = scene === 'error';
  const repositories = ['deepseek-harness', 'gestalt-travel-server', 'WeKnora', 'sub2api'].map((name, index) => ({
    repo: `${ORG}/${name}`,
    lastPollAt: minutes(0.3 + index * 0.02),
    error: failing && name === 'sub2api' ? '无权读取 Actions 运行（403），已连续 3 轮' : null,
    remaining: 3880,
    resetAt: new Date(Date.now() + 42 * 60_000).toISOString(),
  }));
  const empty = scene === 'empty';
  return SnapshotSchema.parse({
    preferences: PreferencesSchema.parse({ shadow, organization: ORG }),
    subscriptions: empty ? [] : subscriptions(),
    events: empty ? [] : events(),
    deliveries: empty ? [] : deliveries(shadow),
    repositories,
    token: {
      configured: true,
      prefix: 'githu…',
      login: 'bbm9527',
      remaining: 3880,
      resetAt: new Date(Date.now() + 42 * 60_000).toISOString(),
      error: null,
    },
    polling: false,
    lastPollAt: minutes(0.3),
    toolInjection: !failing,
    error: failing ? 'sub2api 轮询出错，这个仓库的新事件暂时收不到。' : null,
    intervalSeconds: 60,
  });
}
