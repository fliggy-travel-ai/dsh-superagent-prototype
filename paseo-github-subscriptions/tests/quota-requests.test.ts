import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaRequests } from '../server/modules/usage-claude-accounts/quota-requests.ts';
const url = 'https://api.anthropic.com/api/oauth/usage';
const auth = (value = 'secret-token') => ({ headers: { authorization: 'Bearer ' + value } });

test('同账号并发与五分钟缓存共用请求，响应可分别读取，新凭据不复用旧响应', async () => {
  let now = 0, calls = 0;
  const requests = new QuotaRequests('/unused', async () => { calls++; return Response.json({ calls }); }, () => now);
  const fetch = requests.forAccount('account.org');
  const results = await Promise.all([fetch(url, auth()), fetch(url, auth())]);
  assert.deepEqual(await Promise.all(results.map(r => r.json())), [{ calls: 1 }, { calls: 1 }]);
  now = 299999; await fetch(url, auth()); assert.equal(calls, 1);
  now = 300000; await fetch(url, auth()); assert.equal(calls, 2);
  await fetch(url, auth('new-token')); assert.equal(calls, 3);
});

for (const endpoint of ['profile', 'usage']) for (const header of ['1800', 'Thu, 01 Jan 1970 00:30:00 GMT', null]) {
  test(`${endpoint} 429 等待跨重载与凭据续期生效，Retry-After=${header}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-requests-'));
    const file = join(dir, 'waits.json'); let now = 0, calls = 0;
    const send: typeof fetch = async () => { calls++; return new Response(null, { status: 429, headers: header ? { 'retry-after': header } : {} }); };
    try {
      const first = new QuotaRequests(file, send, () => now).forAccount('account.org');
      const response = await first('https://api.anthropic.com/api/oauth/' + endpoint, auth());
      const delay = header ? 1800000 : 900000;
      assert.equal(response.headers.get('retry-after'), String(delay / 1000));
      assert.doesNotMatch(readFileSync(file, 'utf8'), /secret-token|account.org|authorization/i);
      now = delay - 1;
      const reloaded = new QuotaRequests(file, send, () => now).forAccount('account.org');
      assert.equal((await reloaded(url, auth('renewed-token'))).status, 429); assert.equal(calls, 1);
      now = delay; await reloaded(url, auth()); assert.equal(calls, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('401/403和网络失败不缓存，不影响其他账号或非额度请求', async () => {
  let calls = 0;
  const requests = new QuotaRequests('/unused', async () => { calls++; return new Response(null, { status: 403 }); });
  const query = requests.forAccount('account.org');
  await query(url, auth()); await query(url, auth()); assert.equal(calls, 2);
  await query('https://example.com', auth()); await query('https://example.com', auth()); assert.equal(calls, 4);
  const network = new QuotaRequests('/unused', async () => { throw new Error('network'); }).forAccount('account.org');
  await assert.rejects(network(url, auth()), /network/); await assert.rejects(network(url, auth()), /network/);
});

test('首次登录尚无身份时记录的冷却，身份确认后仍然生效', async () => {
  const dir=mkdtempSync(join(tmpdir(),'quota-new-identity-'));let calls=0;
  try {
    const file=join(dir,'waits.json'),send:typeof fetch=async()=>{calls++;return new Response(null,{status:429});};
    await new QuotaRequests(file,send,()=>0).forAccount('/config')(url,auth());
    const query=new QuotaRequests(file,send,()=>1).forAccount('account.org','/config');
    assert.equal((await query(url,auth('new-token'))).status,429);assert.equal(calls,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
