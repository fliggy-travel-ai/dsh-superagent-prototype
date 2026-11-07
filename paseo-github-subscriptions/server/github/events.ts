import { z } from 'zod';
import type { GithubEvent } from '../../shared/model.ts';
import { ciCounts, ciFailures, ciSummary, type CiSnapshot } from '../vendor/dsh-superagent/github-read.ts';
import {
  branchCiTrigger, ciTrigger, CommentSchema, commentTrigger, githubPage, issueTrigger, pullTrigger, type GithubComment, type GithubIssue,
} from '../vendor/dsh-superagent/github-trigger.ts';
import { key } from '../vendor/dsh-superagent/shim.ts';
import type { CiEmit } from './ci.ts';

export const MARKER_PATTERN = /<!--\s*paseo-ghsub\s+agent=([\w-]+)\s*-->(?:\s*<!--\s*paseo-ghsub-key\s+id=[\w-]+\s*-->)*\s*$/;
const MARKER_STRIP_PATTERN = /<!--\s*paseo-ghsub(?:-key)?\s+[\w=\s-]*?-->/g;
export const EXCERPT_LIMIT = 500;

export const ListedCommentSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() });
export type ListedComment = z.infer<typeof ListedCommentSchema>;

export const markerAgentId = (body: string | null | undefined): string | null => MARKER_PATTERN.exec(body ?? '')?.[1] ?? null;

export function clip(text: string, limit = EXCERPT_LIMIT): string {
  const characters = [...text.replace(MARKER_STRIP_PATTERN, '').trim()];
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
}

interface Subject { repo: string; number: number; isPr: boolean; title: string | null }

export function openedEvent(repo: string, issue: GithubIssue, isPr: boolean): GithubEvent {
  const trigger = isPr ? pullTrigger(issue, '') : issueTrigger(issue, '');
  return {
    id: key(repo, trigger.id), repo, number: issue.number, isPr, title: issue.title, type: 'opened', actor: issue.user.login,
    at: issue.created_at, url: issue.html_url, text: clip(trigger.text), markerAgentId: markerAgentId(issue.body),
  };
}

export function commentEvent(subject: Subject, item: GithubComment, kind: 'conversation' | 'inline' | 'review'): GithubEvent | null {
  const trigger = commentTrigger(item, { number: subject.number, isPr: subject.isPr }, kind, '');
  if (!trigger.text) return null;
  const edited = kind !== 'review' && !!item.created_at && !!item.updated_at && item.created_at !== item.updated_at;
  const type = kind === 'review' ? 'review' : kind === 'inline' ? 'review_comment' : 'comment';
  return {
    id: key(subject.repo, trigger.id), repo: subject.repo, number: subject.number, isPr: subject.isPr, title: subject.title, type,
    actor: item.user.login, at: trigger.at, url: trigger.url ?? githubPage(subject.repo, subject.number, subject.isPr),
    text: clip(`${edited ? '（已编辑）' : ''}${trigger.text}`), markerAgentId: markerAgentId(item.body),
  };
}

export type StateKind = 'open' | 'closed' | 'merged';

export function stateEvent(subject: Subject, state: StateKind, at: string, actor: string): GithubEvent {
  const noun = subject.isPr ? 'PR' : 'Issue';
  const label = state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : '已重新打开';
  return {
    id: key(subject.repo, 'state', String(subject.number), state, at), repo: subject.repo, number: subject.number, isPr: subject.isPr,
    title: subject.title, type: 'state', actor, at, url: githubPage(subject.repo, subject.number, subject.isPr),
    text: clip(`${noun} #${subject.number} ${label}${subject.title ? `：${subject.title}` : ''}`), markerAgentId: null,
    closed: state !== 'open',
  };
}

export function pushEvent(subject: Subject, head: string, actor: string, at: string): GithubEvent {
  return {
    id: key(subject.repo, 'push', String(subject.number), head), repo: subject.repo, number: subject.number, isPr: true,
    title: subject.title, type: 'push', actor, at, url: githubPage(subject.repo, subject.number, true),
    text: clip(`PR #${subject.number} 有新提交 ${head.slice(0, 7)}${subject.title ? `：${subject.title}` : ''}`), markerAgentId: null,
    revision: head,
  };
}

function ciText(snapshot: CiSnapshot, emit: CiEmit, where: string): string {
  const counts = ciCounts(snapshot);
  const total = snapshot.checks.length + snapshot.statuses.length;
  const head = snapshot.head.slice(0, 7);
  if (emit === 'failed') {
    const names = ciFailures(snapshot);
    const listed = names.slice(0, 5).join('、') + (names.length > 5 ? `等 ${names.length} 项` : '');
    const still = counts.running ? `，另有 ${counts.running} 项运行中` : '';
    return `CI 失败 ${counts.failed}/${total}：${listed}${still}（${where}，提交 ${head}）`;
  }
  return `CI ${emit === 'recovered' ? '已恢复，' : ''}全部通过 ${total}/${total}（${where}，提交 ${head}）`;
}

interface CiEventInput {
  repo: string; snapshot: CiSnapshot; emit: CiEmit; revision: number; epoch: number; at: string;
  pull?: { number: number; title: string | null; url: string; author: string };
  branch?: string;
}

export function ciEvent(input: CiEventInput): GithubEvent {
  const { repo, snapshot, emit, revision, at } = input;
  const where = input.pull ? `PR #${input.pull.number}` : input.branch ?? '';
  const summary = ciSummary(snapshot, where, `commits/${snapshot.head}/checks`).split('\n')[0] ?? '';
  const failed = ciFailures(snapshot);
  const running = ciCounts(snapshot).running > 0;
  const url = input.pull ? input.pull.url : `https://github.com/${repo}/commit/${snapshot.head}`;
  const trigger = input.pull
    ? ciTrigger({ number: input.pull.number, html_url: url, user: { login: input.pull.author } }, revision, summary)
    : branchCiTrigger(input.branch ?? '', snapshot.head, revision, summary, url);
  return {
    id: key(repo, trigger.id, snapshot.head, input.emit, failed.join('\n'), String(input.epoch)), repo, number: input.pull?.number ?? null, isPr: input.pull ? true : null,
    title: input.pull?.title ?? null, type: 'ci', actor: '', at, url, text: clip(ciText(snapshot, emit, where)), markerAgentId: null,
    revision: String(revision), ci: { failed, running, summary },
  };
}
