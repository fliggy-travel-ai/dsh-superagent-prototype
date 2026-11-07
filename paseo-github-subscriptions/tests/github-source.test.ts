import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GithubEvent, Subscription } from '../shared/model.ts';
import { GithubSource } from '../server/github/source.ts';
import {
  commentItem, createFixture, issueItem, preferences, repository, subscription, type Fixture,
} from './github-fixture.ts';

const START = Date.parse('2026-11-06T00:00:00.000Z');
const TOKEN = 'ghp_supersecrettokenvalue';

function setup(options: { state?: unknown; extra?: (fixture: Fixture) => void } = {}) {
  const fixture = createFixture();
  fixture.world.organization = [repository('app'), repository('rea')];
  options.extra?.(fixture);
  const clock = { value: START };
  const source = new GithubSource({ getToken: async () => TOKEN, fetch: fixture.fetch, now: () => clock.value, state: options.state });
  const poll = async (subscriptions: Subscription[] = [], overrides = {}) => source.poll(preferences(overrides), subscriptions);
  const advance = (milliseconds: number) => { clock.value += milliseconds; };
  return { fixture, source, poll, advance, clock };
}

const types = (events: GithubEvent[]) => events.map(event => event.type);
const iso = (offsetSeconds: number) => new Date(START + offsetSeconds * 1000).toISOString();

test('首次轮询不倒灌历史，并跳过排除仓库', async () => {
  const { fixture, poll } = setup();
  fixture.world.honorSince = false;
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: '2026-10-30T00:00:00.000Z', updated_at: '2026-10-30T00:00:00.000Z' })];
  fixture.world.comments['org/app'] = [commentItem(5, 1, { created_at: '2026-10-30T00:00:00.000Z', updated_at: '2026-10-30T00:00:00.000Z' })];
  const result = await poll();
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.repositories.map(item => item.repo), ['org/app']);
  assert.equal(result.repositories[0]?.error, null);
  assert.equal(fixture.count(/\/repos\/org\/rea/), 0);
});

test('新事件：打开、评论新建与编辑、代码评论、关闭；重叠窗口不重复', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(30), updated_at: iso(30) })];
  fixture.world.comments['org/app'] = [commentItem(5, 1, {
    created_at: iso(40), updated_at: iso(40), body: 'quote <!-- paseo-ghsub agent=agent-1 --> reply\n\n<!-- paseo-ghsub agent=agent-9 -->\n<!-- paseo-ghsub-key id=abc123 -->',
  })];
  fixture.world.reviewComments['org/app'] = [{
    id: 8, body: 'inline', path: 'a.ts', line: 3, diff_hunk: '@@ -1 +1 @@', user: { login: 'carol' }, created_at: iso(45), updated_at: iso(45),
    html_url: 'https://github.com/org/app/pull/2#discussion_r8', pull_request_url: 'https://api.github.com/repos/org/app/pulls/2',
  }];
  const first = await poll();
  assert.deepEqual(types(first.events).sort(), ['comment', 'opened', 'review_comment']);
  const comment = first.events.find(event => event.type === 'comment')!;
  assert.equal(comment.markerAgentId, 'agent-9');
  assert.ok(!comment.text.includes('paseo-ghsub'));
  assert.match(comment.text, /^quote\s+reply/);
  assert.equal(comment.repo, 'org/app');
  assert.equal(comment.number, 1);
  assert.equal(comment.isPr, false);
  assert.equal(first.events.find(event => event.type === 'review_comment')?.isPr, true);
  advance(60_000);
  assert.deepEqual((await poll()).events, []);
  advance(60_000);
  fixture.world.comments['org/app']![0] = commentItem(5, 1, { created_at: iso(40), updated_at: iso(130), body: 'edited' });
  fixture.world.issues['org/app']![0] = issueItem(1, { created_at: iso(30), updated_at: iso(140), state: 'closed', closed_at: iso(140) });
  const second = await poll();
  assert.deepEqual(types(second.events).sort(), ['comment', 'state']);
  assert.match(second.events.find(event => event.type === 'comment')!.text, /^（已编辑）edited/);
  const state = second.events.find(event => event.type === 'state')!;
  assert.equal(state.closed, true);
  assert.match(state.text, /已关闭/);
  assert.equal(state.title, 'Issue 1');
});

test('相同游标时带 ETag，304 不产生事件', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  await poll();
  const issueCalls = fixture.calls.filter(call => call.path === '/repos/org/app/issues');
  assert.equal(issueCalls.length, 2);
  assert.equal(issueCalls[0]?.headers['if-none-match'], undefined);
  assert.ok(issueCalls[1]?.headers['if-none-match']);
  advance(60_000);
  assert.deepEqual((await poll()).events, []);
});

test('某一条流失败时不推进它，下一轮补上；其余流照常输出', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(30), updated_at: iso(30) })];
  fixture.world.comments['org/app'] = [commentItem(5, 1, { created_at: iso(40), updated_at: iso(40) })];
  fixture.world.failures['/repos/org/app/issues/comments'] = [{ status: 500, body: { message: 'boom' } }];
  const failed = await poll();
  assert.deepEqual(types(failed.events), ['opened']);
  assert.match(failed.repositories[0]?.error ?? '', /对话评论/);
  advance(60_000);
  const retried = await poll();
  assert.deepEqual(types(retried.events), ['comment']);
  assert.equal(retried.repositories[0]?.error, null);
});

test('分页读取全部页', async () => {
  const { fixture, poll, advance } = setup();
  fixture.world.pageSize = 2;
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [1, 2, 3, 4, 5].map(number => issueItem(number, { created_at: iso(10 + number), updated_at: iso(10 + number) }));
  const result = await poll();
  assert.equal(result.events.filter(event => event.type === 'opened').length, 5);
});

test('序列化后恢复：不重复也不丢失', async () => {
  const first = setup();
  await first.poll();
  first.advance(60_000);
  first.fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(30), updated_at: iso(30) })];
  assert.equal((await first.poll()).events.length, 1);
  const saved = JSON.parse(JSON.stringify(first.source.serialize()));
  const second = setup({ state: saved });
  second.fixture.world = first.fixture.world;
  const resumed = new GithubSource({ getToken: async () => TOKEN, fetch: first.fixture.fetch, now: () => first.clock.value + 60_000, state: saved });
  assert.deepEqual((await resumed.poll(preferences(), [])).events, []);
  first.fixture.world.comments['org/app'] = [commentItem(9, 1, { created_at: iso(100), updated_at: iso(100) })];
  const later = new GithubSource({ getToken: async () => TOKEN, fetch: first.fixture.fetch, now: () => first.clock.value + 120_000, state: saved });
  assert.deepEqual(types((await later.poll(preferences(), [])).events), ['comment']);
});

test('损坏的状态被忽略并按全新状态启动', async () => {
  const { poll, source } = setup({ state: { version: 9, nonsense: true } });
  assert.deepEqual((await poll()).events, []);
  assert.equal((source.serialize() as { version: number }).version, 1);
});

test('PR 订阅：推送、Review、CI 失败与恢复', async () => {
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  const pullBody = (sha: string) => ({
    title: 'PR 7', state: 'open', html_url: 'https://github.com/org/app/pull/7', user: { login: 'bob' }, head: { sha }, updated_at: iso(50),
  });
  const run = (id: number, sha: string, status: string, conclusion: string | null, at: number) => ({
    id, name: 'ci', status, conclusion, head_sha: sha, head_branch: 'feature', workflow_id: 1, event: 'pull_request',
    created_at: iso(at), updated_at: iso(at), pull_requests: [{ number: 7 }],
  });
  world.issues['org/app'] = [issueItem(7, {
    created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z', pull_request: { url: 'x', merged_at: null },
  })];
  world.pulls['org/app#7'] = pullBody('aaa1111');
  world.runs['org/app'] = [run(1, 'aaa1111', 'in_progress', null, -10)];
  world.jobs['org/app#1'] = [{ name: 'build', status: 'in_progress', conclusion: null }];
  const subscriptions = [subscription()];
  const baseline = await poll(subscriptions);
  assert.deepEqual(baseline.events, []);
  advance(60_000);
  world.pulls['org/app#7'] = pullBody('bbb2222');
  world.issues['org/app'] = [issueItem(7, {
    created_at: '2026-11-05T00:00:00.000Z', updated_at: iso(50), pull_request: { url: 'x', merged_at: null },
  })];
  world.reviews['org/app#7'] = [{
    id: 100, state: 'CHANGES_REQUESTED', body: 'please fix', commit_id: 'bbb2222', submitted_at: iso(55), user: { login: 'dave' },
    html_url: 'https://github.com/org/app/pull/7#pullrequestreview-100',
  }];
  world.runs['org/app'] = [run(1, 'aaa1111', 'completed', 'cancelled', 20), run(2, 'bbb2222', 'completed', 'failure', 58)];
  world.jobs['org/app#2'] = [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }];
  const second = await poll(subscriptions);
  assert.deepEqual(types(second.events).sort(), ['ci', 'push', 'review']);
  const ci = second.events.find(event => event.type === 'ci')!;
  assert.deepEqual(ci.ci?.failed, ['test']);
  assert.equal(ci.ci?.running, false);
  assert.match(ci.text, /CI 失败 1\/2：test/);
  assert.equal(ci.number, 7);
  assert.equal(ci.revision, '1');
  const review = second.events.find(event => event.type === 'review')!;
  assert.match(review.text, /CHANGES_REQUESTED review of commit bbb2222/);
  assert.equal(review.actor, 'dave');
  assert.equal(second.events.find(event => event.type === 'push')?.revision, 'bbb2222');
  advance(60_000);
  assert.deepEqual((await poll(subscriptions)).events, []);
  advance(60_000);
  world.runs['org/app'] = [run(1, 'aaa1111', 'completed', 'cancelled', 20), run(2, 'bbb2222', 'completed', 'failure', 58), run(3, 'bbb2222', 'completed', 'success', 120)];
  const recovered = await poll(subscriptions);
  assert.deepEqual(types(recovered.events), ['ci']);
  assert.match(recovered.events[0]!.text, /已恢复，全部通过/);
  assert.deepEqual(recovered.events[0]!.ci?.failed, []);
  assert.equal(recovered.events[0]!.revision, '2');
});

test('PR 订阅：CI 进行中转全部通过会送一次，未订阅的 PR 不补读', async () => {
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  const run = (status: string, conclusion: string | null, at: number) => ({
    id: 1, name: 'ci', status, conclusion, head_sha: 'aaa1111', head_branch: 'feature', workflow_id: 1, event: 'pull_request',
    created_at: iso(-10), updated_at: iso(at), pull_requests: [{ number: 7 }],
  });
  world.pulls['org/app#7'] = { title: 'PR 7', state: 'open', html_url: 'https://github.com/org/app/pull/7', user: { login: 'bob' }, head: { sha: 'aaa1111' } };
  world.runs['org/app'] = [run('in_progress', null, 0)];
  world.jobs['org/app#1'] = [{ name: 'build', status: 'in_progress', conclusion: null }];
  assert.equal((await poll([subscription({ events: ['ci'] })])).events.length, 0);
  advance(60_000);
  world.runs['org/app'] = [run('completed', 'success', 55)];
  const passed = await poll([subscription({ events: ['ci'] })]);
  assert.equal(passed.events.length, 1);
  assert.match(passed.events[0]!.text, /^CI 全部通过 1\/1/);
  assert.equal(fixture.count(/\/pulls\/8/), 0);
  advance(60_000);
  assert.equal((await poll([subscription({ events: ['ci'] })])).events.length, 0);
});

test('整仓库订阅：默认分支 CI 失败与恢复', async () => {
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  const run = (id: number, sha: string, conclusion: string, at: number) => ({
    id, name: 'ci', status: 'completed', conclusion, head_sha: sha, head_branch: 'main', workflow_id: 1, event: 'push',
    created_at: iso(at), updated_at: iso(at), pull_requests: [],
  });
  const repoSubscription = subscription({ key: 'org/app', scope: 'repo', number: null, isPr: null, events: ['ci', 'opened'] });
  world.commits['org/app@main'] = 'm1';
  world.runs['org/app'] = [run(1, 'm1', 'success', -5)];
  assert.deepEqual((await poll([repoSubscription])).events, []);
  advance(60_000);
  world.commits['org/app@main'] = 'm2';
  world.runs['org/app'] = [run(1, 'm1', 'success', -5), run(2, 'm2', 'failure', 50)];
  world.jobs['org/app#2'] = [{ name: 'deploy', status: 'completed', conclusion: 'failure' }];
  const failed = await poll([repoSubscription]);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0]?.number, null);
  assert.deepEqual(failed.events[0]?.ci?.failed, ['deploy']);
  assert.match(failed.events[0]!.url, /commit\/m2$/);
  advance(60_000);
  world.commits['org/app@main'] = 'm3';
  world.runs['org/app'] = [run(1, 'm1', 'success', -5), run(2, 'm2', 'failure', 50), run(3, 'm3', 'success', 100)];
  const recovered = await poll([repoSubscription]);
  assert.equal(recovered.events.length, 1);
  assert.match(recovered.events[0]!.text, /已恢复/);
});

test('无订阅时不读取 PR 详情、Review 和默认分支 CI', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(7, { updated_at: iso(50), pull_request: { url: 'x' } })];
  await poll();
  assert.equal(fixture.count(/\/pulls\/\d+/), 0);
  assert.equal(fixture.count(/\/commits\//), 0);
});

test('合并 PR 产生状态事件', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(7, {
    created_at: iso(10), updated_at: iso(50), state: 'closed', closed_at: iso(50), pull_request: { url: 'x', merged_at: iso(50) },
  })];
  const result = await poll();
  assert.deepEqual(types(result.events).sort(), ['opened', 'state']);
  const merged = result.events.find(event => event.type === 'state')!;
  assert.match(merged.text, /已合并/);
  assert.equal(merged.isPr, true);
});

test('限流：尊重 Retry-After，暂停期间不发请求，到期恢复', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.failures['/repos/org/app/issues'] = [{ status: 429, headers: { 'retry-after': '120' }, body: { message: 'slow' } }];
  const limited = await poll();
  assert.match(limited.repositories[0]?.error ?? '', /限流/);
  const requests = fixture.calls.length;
  advance(60_000);
  const paused = await poll();
  assert.equal(fixture.calls.length, requests);
  assert.match(paused.repositories[0]?.error ?? '', /限流/);
  advance(61_000);
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(70), updated_at: iso(70) })];
  const resumed = await poll();
  assert.deepEqual(types(resumed.events), ['opened']);
  assert.equal(resumed.repositories[0]?.error, null);
});

test('额度偏低时拉长轮询间隔，耗尽时等到重置', async () => {
  const { fixture, poll, advance } = setup();
  fixture.world.rateRemaining = 400;
  await poll();
  const requests = fixture.calls.length;
  advance(60_000);
  const skipped = await poll();
  assert.equal(fixture.calls.filter(call => call.path !== '/rate_limit').length, requests - 1);
  assert.equal(skipped.repositories[0]?.remaining, 400);
  advance(300_000);
  await poll();
  assert.ok(fixture.calls.filter(call => call.path === '/repos/org/app/issues').length >= 2);
  fixture.world.rateRemaining = 50;
  advance(300_000);
  const before = fixture.calls.filter(call => call.path !== '/rate_limit').length;
  const exhausted = await poll();
  assert.equal(fixture.calls.filter(call => call.path !== '/rate_limit').length, before);
  assert.match(exhausted.repositories[0]?.error ?? '', /限流/);
});

test('新仓库和额外仓库纳入轮询，并带上最近一次目录刷新之后的事件', async () => {
  const { fixture, poll, advance } = setup();
  fixture.world.repositories['other/tool'] = { full_name: 'other/tool', default_branch: 'trunk' };
  await poll();
  advance(11 * 60_000);
  fixture.world.organization = [repository('app'), repository('rea'), repository('lib')];
  fixture.world.issues['org/lib'] = [issueItem(1, { created_at: iso(300), updated_at: iso(300), html_url: 'https://github.com/org/lib/issues/1' })];
  const result = await poll([], { extraRepos: ['other/tool'] });
  assert.deepEqual(result.repositories.map(item => item.repo).sort(), ['org/app', 'org/lib', 'other/tool']);
  assert.deepEqual(result.events.map(event => `${event.repo}:${event.type}`), ['org/lib:opened']);
});

test('排除列表变化后仓库被移出', async () => {
  const { poll } = setup();
  assert.equal((await poll()).repositories.length, 1);
  const result = await poll([], { excludedRepos: ['rea', 'app'] });
  assert.equal(result.repositories.length, 0);
});

test('归档仓库不轮询', async () => {
  const { fixture, poll } = setup();
  fixture.world.organization = [{ ...repository('app'), archived: true }];
  assert.equal((await poll()).repositories.length, 0);
});

test('没有令牌时抛出明确错误且不发请求', async () => {
  const fixture = createFixture();
  const source = new GithubSource({ getToken: async () => null, fetch: fixture.fetch });
  await assert.rejects(source.poll(preferences(), []), /未配置 GitHub 令牌/);
  assert.equal(fixture.calls.length, 0);
});

test('令牌无效时抛错，错误里没有令牌', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 })) as typeof fetch;
  const source = new GithubSource({ getToken: async () => TOKEN, fetch: fetchImpl });
  await assert.rejects(source.poll(preferences(), []), (error: Error) => /401/.test(error.message) && !error.message.includes(TOKEN));
});

test('目录读取失败时记录到组织条目，不抛错', async () => {
  const fixture = createFixture();
  fixture.world.failures['/orgs/org/repos'] = [{ status: 404, body: { message: 'Not Found' } }];
  const source = new GithubSource({ getToken: async () => TOKEN, fetch: fixture.fetch, now: () => START });
  const result = await source.poll(preferences(), []);
  assert.equal(result.repositories[0]?.repo, 'org');
  assert.match(result.repositories[0]?.error ?? '', /组织仓库列表/);
});

test('中止信号传给请求并抛出', async () => {
  const fixture = createFixture();
  const source = new GithubSource({ getToken: async () => TOKEN, fetch: fixture.fetch, now: () => START });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.poll(preferences(), [], controller.signal));
});

test('readThread 返回标题、类型和关闭状态；不存在时给出修正提示', async () => {
  const { fixture, source } = setup();
  fixture.world.issues['org/app'] = [issueItem(3, { title: 'Open PR', state: 'closed', pull_request: { url: 'x' } })];
  assert.deepEqual(await source.readThread({ owner: 'org', repo: 'app', number: 3 }), { title: 'Open PR', isPr: true, closed: true });
  await assert.rejects(source.readThread({ owner: 'org', repo: 'app', number: 99 }), /编号不存在、已删除，或令牌无权访问/);
});

test('readResource：checks 走 Actions 作业，不访问 check-runs', async () => {
  const { fixture, source } = setup();
  const world = fixture.world;
  world.pulls['org/app#7'] = { title: 'PR 7', state: 'open', html_url: 'x', user: { login: 'bob' }, head: { sha: 'aaa1111' } };
  world.runs['org/app'] = [{
    id: 1, name: 'ci', status: 'completed', conclusion: 'failure', head_sha: 'aaa1111', workflow_id: 1, event: 'push', created_at: iso(0), updated_at: iso(0),
  }];
  world.jobs['org/app#1'] = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
  const checks = await source.readResource('org/app', 7, 'checks') as { failed: number; checks: Array<{ name: string }>; summary: string };
  assert.equal(checks.failed, 1);
  assert.deepEqual(checks.checks.map(item => item.name), ['test']);
  assert.ok(!fixture.calls.some(call => /check-runs/.test(call.path)));
  const actions = await source.readResource('org/app', 7, 'actions') as { runs: Array<{ id: number; conclusion: string }> };
  assert.deepEqual(actions.runs.map(item => `${item.id}:${item.conclusion}`), ['1:failure']);
});

test('readResource：参数检查', async () => {
  const { source } = setup();
  await assert.rejects(source.readResource('not a repo', 1, 'issue'), /owner\/repo/);
  await assert.rejects(source.readResource('org/app', null, 'comments'), /编号/);
});

test('readResource：issue 读取说明与评论页', async () => {
  const { fixture, source } = setup();
  fixture.world.issues['org/app'] = [issueItem(3, { title: 'Plain issue', body: 'details' })];
  const issue = await source.readResource('org/app', 3, 'issue') as { number: number; title: string };
  assert.equal(issue.number, 3);
  assert.equal(issue.title, 'Plain issue');
});

const pullFixture = (world: Fixture['world'], overrides: Record<string, unknown> = {}) => {
  world.pulls['org/app#7'] = {
    title: 'PR 7', state: 'open', html_url: 'https://github.com/org/app/pull/7', user: { login: 'bob' }, head: { sha: 'aaa1111' }, ...overrides,
  };
  world.issues['org/app'] = [issueItem(7, {
    created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z', pull_request: { url: 'x', merged_at: null },
  })];
};
const ciRun = (id: number, sha: string, conclusion: string, at: number, extra: Record<string, unknown> = {}) => ({
  id, name: 'ci', status: 'completed', conclusion, head_sha: sha, head_branch: 'feature', workflow_id: 1, event: 'pull_request',
  created_at: iso(at), updated_at: iso(at), pull_requests: [{ number: 7 }], ...extra,
});

test('标记：只认末尾标记，容许其后的 key 标记，引用里的旧标记不算', async () => {
  const { fixture, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(30), updated_at: iso(30) })];
  fixture.world.comments['org/app'] = [
    commentItem(5, 1, { created_at: iso(40), updated_at: iso(40), body: 'a <!-- paseo-ghsub agent=old --> b' }),
    commentItem(6, 1, { created_at: iso(41), updated_at: iso(41), body: 'x\n<!-- paseo-ghsub agent=quoted -->\ny\n<!-- paseo-ghsub agent=last -->\n<!-- paseo-ghsub-key id=k1 -->\n' }),
  ];
  const result = await poll();
  const markers = result.events.filter(event => event.type === 'comment').map(event => event.markerAgentId);
  assert.deepEqual(markers, [null, 'last']);
});

test('CI：同一提交失败、恢复、同名再失败各有新编号；状态重建后编号也不撞', async () => {
  const subscriptions = [subscription({ events: ['ci'] })];
  const first = setup();
  const world = first.fixture.world;
  pullFixture(world);
  world.runs['org/app'] = [ciRun(1, 'aaa1111', 'success', -5)];
  await first.poll(subscriptions);
  const failedIds: string[] = [];
  const step = async (runs: Array<Record<string, unknown>>, jobs: Array<Record<string, unknown>> = []) => {
    first.advance(60_000);
    world.runs['org/app'] = runs;
    world.jobs[`org/app#${runs.at(-1)!.id}`] = jobs;
    return (await first.poll(subscriptions)).events;
  };
  const failing = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
  const firstFailure = await step([ciRun(1, 'aaa1111', 'success', -5), ciRun(2, 'aaa1111', 'failure', 70, { created_at: iso(70) })], failing);
  failedIds.push(firstFailure[0]!.id);
  const recovery = await step([ciRun(1, 'aaa1111', 'success', -5), ciRun(3, 'aaa1111', 'success', 130, { created_at: iso(130) })]);
  assert.match(recovery[0]!.text, /已恢复/);
  failedIds.push(recovery[0]!.id);
  const again = await step([ciRun(1, 'aaa1111', 'success', -5), ciRun(4, 'aaa1111', 'failure', 190, { created_at: iso(190) })], failing);
  assert.equal(again.length, 1);
  assert.match(again[0]!.text, /CI 失败/);
  failedIds.push(again[0]!.id);
  assert.equal(new Set(failedIds).size, 3);
  assert.deepEqual([firstFailure[0]!.revision, recovery[0]!.revision, again[0]!.revision], ['1', '2', '3']);

  const rebuilt = setup();
  rebuilt.advance(3_600_000);
  const rebuiltWorld = rebuilt.fixture.world;
  pullFixture(rebuiltWorld);
  rebuiltWorld.runs['org/app'] = [ciRun(1, 'aaa1111', 'success', -5)];
  await rebuilt.poll(subscriptions);
  rebuilt.advance(61_000);
  rebuiltWorld.runs['org/app'] = [ciRun(1, 'aaa1111', 'success', -5), ciRun(2, 'aaa1111', 'failure', 3_670)];
  rebuiltWorld.jobs['org/app#2'] = failing;
  const afterReset = await rebuilt.poll(subscriptions);
  assert.equal(afterReset.events[0]!.revision, '1');
  assert.notEqual(afterReset.events[0]!.id, firstFailure[0]!.id);
});

test('CI：新提交上同名失败也要发送，不会因失败集合相同被吞', async () => {
  const subscriptions = [subscription({ events: ['ci', 'push'] })];
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  const failing = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
  pullFixture(world);
  world.runs['org/app'] = [ciRun(1, 'aaa1111', 'failure', -5)];
  world.jobs['org/app#1'] = failing;
  assert.deepEqual((await poll(subscriptions)).events, []);
  advance(60_000);
  pullFixture(world, { head: { sha: 'bbb2222' } });
  world.issues['org/app'] = [issueItem(7, { created_at: '2026-11-05T00:00:00.000Z', updated_at: iso(50), pull_request: { url: 'x' } })];
  world.runs['org/app'] = [ciRun(1, 'aaa1111', 'failure', -5), ciRun(2, 'bbb2222', 'failure', 55)];
  world.jobs['org/app#2'] = failing;
  const result = await poll(subscriptions);
  assert.deepEqual(types(result.events).sort(), ['ci', 'push']);
  const ci = result.events.find(event => event.type === 'ci')!;
  assert.deepEqual(ci.ci?.failed, ['test']);
  assert.match(ci.text, /bbb2222/);
});

test('Actions 运行列表只读第一页，每页 100 条', async () => {
  const { fixture, poll, advance } = setup();
  fixture.world.pageSize = 2;
  fixture.world.runs['org/app'] = [1, 2, 3, 4, 5].map(id => ciRun(id, `sha${id}`, 'success', id));
  await poll();
  advance(60_000);
  fixture.world.runs['org/app'] = [1, 2, 3, 4, 5, 6].map(id => ciRun(id, `sha${id}`, 'success', id));
  await poll();
  const runCalls = fixture.calls.filter(call => call.path === '/repos/org/app/actions/runs');
  assert.equal(runCalls.length, 2);
  assert.ok(runCalls.every(call => call.search.includes('per_page=100') && !call.search.includes('page=2')));
});

test('定时核对：没有 issues 更新信号时也能发现推送与新 Review', async () => {
  const subscriptions = [subscription({ events: ['push', 'review'] })];
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  pullFixture(world);
  await poll(subscriptions);
  advance(60_000);
  pullFixture(world, { head: { sha: 'ccc3333' } });
  world.reviews['org/app#7'] = [{
    id: 9, state: 'APPROVED', body: 'ok', commit_id: 'ccc3333', submitted_at: iso(30), user: { login: 'dave' }, html_url: 'https://github.com/org/app/pull/7#r9',
  }];
  assert.deepEqual((await poll(subscriptions)).events, []);
  advance(5 * 60_000);
  const reconciled = await poll(subscriptions);
  assert.deepEqual(types(reconciled.events).sort(), ['push', 'review']);
});

test('关闭后重开的已跟踪 PR 恢复补读，不因关闭标记永久跳过', async () => {
  const subscriptions = [subscription({ events: ['push'] })];
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  pullFixture(world, { state: 'closed' });
  await poll(subscriptions);
  advance(60_000);
  pullFixture(world, { state: 'closed', head: { sha: 'ddd4444' } });
  assert.deepEqual((await poll(subscriptions)).events, []);
  advance(60_000);
  world.issues['org/app'] = [issueItem(7, { created_at: '2026-11-05T00:00:00.000Z', updated_at: iso(150), state: 'open', pull_request: { url: 'x' } })];
  pullFixture(world, { state: 'open', head: { sha: 'ddd4444' } });
  world.issues['org/app']![0] = issueItem(7, { created_at: '2026-11-05T00:00:00.000Z', updated_at: iso(150), state: 'open', pull_request: { url: 'x' } });
  const reopened = await poll(subscriptions);
  assert.deepEqual(types(reopened.events), ['push']);
  advance(60_000);
  pullFixture(world, { state: 'open', head: { sha: 'eee5555' } });
  world.issues['org/app']![0] = issueItem(7, { created_at: '2026-11-05T00:00:00.000Z', updated_at: iso(250), state: 'open', pull_request: { url: 'x' } });
  assert.deepEqual(types((await poll(subscriptions)).events), ['push']);
});

test('关闭 PR 没有 issues 信号时，定时核对也能发现已重开', async () => {
  const subscriptions = [subscription({ events: ['push'] })];
  const { fixture, poll, advance } = setup();
  const world = fixture.world;
  pullFixture(world, { state: 'closed' });
  await poll(subscriptions);
  advance(6 * 60_000);
  pullFixture(world, { state: 'open', head: { sha: 'fff6666' } });
  const reconciled = await poll(subscriptions);
  assert.deepEqual(types(reconciled.events), ['push']);
});

test('订阅时已关闭的旧 Issue 重开会发状态事件', async () => {
  const hinted = subscription({ key: 'org/app#3', number: 3, isPr: false, events: ['state'], expiresAt: iso(3 * 86400) });
  const { fixture, poll, advance } = setup();
  await poll([hinted]);
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(3, { created_at: '2026-10-01T00:00:00.000Z', updated_at: iso(50), state: 'open' })];
  const result = await poll([hinted]);
  assert.deepEqual(types(result.events), ['state']);
  assert.match(result.events[0]!.text, /已重新打开/);
  assert.equal(result.events[0]!.closed, false);
});

test('组织变更且目录读取失败时保留旧目录、旧游标和旧仓库', async () => {
  const { fixture, source, poll, advance } = setup();
  await poll();
  advance(60_000);
  fixture.world.failures['/orgs/org2/repos'] = [{ status: 500, body: { message: 'down' } }];
  const failed = await source.poll(preferences({ organization: 'org2' }), []);
  assert.deepEqual(failed.repositories.map(item => item.repo).sort(), ['org/app', 'org2']);
  assert.match(failed.repositories.find(item => item.repo === 'org2')?.error ?? '', /组织仓库列表/);
  const saved = source.serialize() as { repos: Record<string, unknown>; directory: { organization: unknown[] } };
  assert.ok(saved.repos['org/app']);
  assert.equal(saved.directory.organization.length, 2);
  advance(60_000);
  fixture.world.issues['org/app'] = [issueItem(1, { created_at: iso(100), updated_at: iso(100) })];
  const recovered = await source.poll(preferences(), []);
  assert.deepEqual(types(recovered.events), ['opened']);
});
