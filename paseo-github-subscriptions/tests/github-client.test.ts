import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubClient, GithubError } from '../server/github/client.ts';

const TOKEN = 'ghp_supersecrettokenvalue';

function clientWith(handler: (url: URL, init: RequestInit) => Response, clock: { value: number } = { value: 1_000_000 }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    urls.push(String(input));
    return handler(new URL(String(input)), init ?? {});
  }) as typeof fetch;
  return { client: new GithubClient({ token: TOKEN, fetch: fetchImpl, now: () => clock.value, timeoutMs: 500 }), urls, clock };
}

test('请求只发往 api.github.com，并带上令牌头', async () => {
  const seen: Array<Record<string, string>> = [];
  const { client } = clientWith((url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    seen.push(headers);
    assert.equal(url.origin, 'https://api.github.com');
    return new Response('[]', { status: 200 });
  });
  await client.request('repos/org/app/issues');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
});

test('拒绝通知接口、路径穿越和其他主机', async () => {
  const { client, urls } = clientWith(() => new Response('[]'));
  await assert.rejects(client.request('notifications?all=true'), /通知接口/);
  await assert.rejects(client.request('/notifications'), /通知接口/);
  await assert.rejects(client.request('repos/org/../secret'), /路径无效/);
  await assert.rejects(client.request('https://evil.example.com/repos/org/app'), /api\.github\.com/);
  assert.deepEqual(urls, []);
});

test('分页下一页指向其他主机时拒绝，且不发出该请求', async () => {
  const { client, urls } = clientWith(() => new Response('[{"id":1}]', {
    status: 200, headers: { link: '<https://evil.example.com/repos/org/app/issues?page=2>; rel="next"' },
  }));
  await assert.rejects(client.list('repos/org/app/issues'), /api\.github\.com/);
  assert.equal(urls.length, 1);
});

test('分页跟随同主机下一页并合并', async () => {
  const { client } = clientWith(url => url.searchParams.get('page') === '2'
    ? new Response('[{"id":2}]')
    : new Response('[{"id":1}]', { headers: { link: '<https://api.github.com/repos/org/app/issues?page=2>; rel="next"' } }));
  const listed = await client.list('repos/org/app/issues');
  assert.deepEqual(listed.items, [{ id: 1 }, { id: 2 }]);
  assert.equal(listed.truncated, false);
});

test('页数达到上限时标记为截断', async () => {
  const { client } = clientWith(() => new Response('[{"id":1}]', { headers: { link: '<https://api.github.com/repos/org/app/issues?page=2>; rel="next"' } }));
  const listed = await client.list('repos/org/app/issues', { maxPages: 2 });
  assert.equal(listed.items.length, 2);
  assert.equal(listed.truncated, true);
});

test('拒绝重定向', async () => {
  const { client } = clientWith(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }));
  await assert.rejects(client.request('repos/org/app/issues'), /重定向/);
});

test('304 直接返回并保留 ETag', async () => {
  const { client } = clientWith(() => new Response(null, { status: 304 }));
  const response = await client.request('repos/org/app/issues', { etag: '"abc"' });
  assert.equal(response.status, 304);
  assert.equal(response.etag, '"abc"');
});

test('错误消息不泄漏令牌', async () => {
  const { client } = clientWith(() => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 }));
  await assert.rejects(client.request('repos/org/app/issues'), (error: Error) => {
    assert.ok(error instanceof GithubError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test('网络错误只给出类别，不带令牌', async () => {
  const fetchImpl = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', detail: TOKEN } }); }) as typeof fetch;
  const client = new GithubClient({ token: TOKEN, fetch: fetchImpl, now: () => 0 });
  await assert.rejects(client.request('repos/org/app/issues'), (error: Error) => {
    assert.match(error.message, /ECONNRESET/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test('Retry-After 暂停后续请求，到期后恢复', async () => {
  let calls = 0;
  const clock = { value: 10_000 };
  const { client } = clientWith(() => {
    calls += 1;
    return calls === 1 ? new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '30' } }) : new Response('[]');
  }, clock);
  await assert.rejects(client.request('repos/org/app/issues'), (error: GithubError) => error.rateLimited && error.retryAt === 40_000);
  await assert.rejects(client.request('repos/org/app/issues'), (error: GithubError) => error.rateLimited);
  assert.equal(calls, 1);
  clock.value = 40_001;
  await client.request('repos/org/app/issues');
  assert.equal(calls, 2);
});

test('额度耗尽的 403 按 x-ratelimit-reset 暂停', async () => {
  const { client } = clientWith(() => new Response('{"message":"API rate limit exceeded"}', {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' },
  }), { value: 1000 });
  await assert.rejects(client.request('repos/org/app/issues'), (error: GithubError) => error.retryAt === 2_000_000);
  assert.equal(client.rate.remaining, 0);
});

test('权限不足的 403 不触发暂停', async () => {
  const { client } = clientWith(() => new Response('{"message":"Resource not accessible by personal access token"}', { status: 403 }));
  await assert.rejects(client.request('repos/org/app/issues'), (error: GithubError) => error.status === 403 && !error.rateLimited);
  assert.equal(client.pausedUntil, 0);
});

test('超时转为请求超时错误', async () => {
  const fetchImpl = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  })) as typeof fetch;
  const client = new GithubClient({ token: TOKEN, fetch: fetchImpl, now: () => 0, timeoutMs: 20 });
  await assert.rejects(client.request('repos/org/app/issues'), /超时/);
});
