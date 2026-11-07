import { eventTypes, type Delivery, type EventType, type GithubEvent, type Subscription } from '../shared/model.ts';

export const eventTypeLabels: Record<EventType, string> = {
  opened: '新建',
  comment: '评论',
  review: 'Review',
  review_comment: '代码评论',
  push: '新提交',
  ci: 'CI',
  state: '合并/关闭',
};

export const deliveryStatusLabels: Record<Delivery['status'], string> = {
  pending: '发送中',
  delivered: '已送达',
  shadow: '影子模式，未发送',
  skipped: '会话忙，按设置跳过本轮',
  unknown: '可能已送达',
  failed: '送达失败，将重试',
};

export function ago(iso: string | null, now: number): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function until(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const minutes = Math.max(0, Math.round((time - now) / 60000));
  return minutes < 1 ? '不到 1 分钟后重置' : `${minutes} 分钟后重置`;
}

export function eventTypesText(events: readonly EventType[]): string[] {
  return events.length >= eventTypes.length ? ['全部类型'] : events.map((type) => eventTypeLabels[type]);
}

export function targetLabel(sub: Pick<Subscription, 'repo' | 'number'>): string {
  return sub.number ? `${sub.repo}#${sub.number}` : sub.repo;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function sessionTitle(sub: Pick<Subscription, 'agentTitle' | 'agentId'>, live?: string | null): string {
  return live || sub.agentTitle || `会话 ${shortId(sub.agentId)}`;
}

export function eventMatchesSubscription(event: GithubEvent, sub: Subscription): boolean {
  if (`${sub.owner}/${sub.repo}`.toLowerCase() !== event.repo.toLowerCase()) return false;
  return sub.scope === 'repo' || sub.number === event.number;
}

export function eventHeadline(event: GithubEvent): string {
  const base = event.repo.split('/').pop() ?? event.repo;
  return event.number ? `${base}#${event.number}` : base;
}

export function eventTypeText(event: GithubEvent): string {
  if (event.type === 'ci' && event.ci) {
    return event.ci.failed.length > 0 ? `CI 失败 ${event.ci.failed.length}` : event.ci.running ? 'CI 运行中' : 'CI 通过';
  }
  if (event.type === 'state' && event.closed !== undefined) return event.closed ? '已关闭' : '重新打开';
  return eventTypeLabels[event.type];
}
