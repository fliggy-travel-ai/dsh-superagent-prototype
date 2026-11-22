import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

test('拒绝结果按凭据缓存，新凭据、其他账号和非额度请求不受影响', async () => {
  let calls = 0;
  const requests = new QuotaRequests('/unused', async () => { calls++; return new Response(null, { status: 403 }); });
  const query = requests.forAccount('account.org');
  await query(url, auth()); await query(url, auth()); assert.equal(calls, 1);
  await query(url, auth('new-token')); assert.equal(calls, 2);
  await requests.forAccount('other.org')(url, auth()); assert.equal(calls, 3);
  await query('https://example.com', auth()); await query('https://example.com', auth()); assert.equal(calls, 5);
});

for (const failure of ['network', '503'] as const) {
  test(`${failure} 失败后的反复刷新不会增加请求，重载后仍等待，退避递增且成功恢复`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-request-failure-'));
    const file = join(dir, 'waits.json'); let now = 0, calls = 0, healthy = false;
    const send: typeof fetch = async () => {
      calls++;
      if (healthy) return Response.json({ ok: true });
      if (failure === 'network') throw new Error('private failure detail');
      return new Response(null, { status: 503 });
    };
    const query = (requests: QuotaRequests) => requests.forAccount('failed.org')(url, auth()).catch(() => null);
    try {
      let requests = new QuotaRequests(file, send, () => now);
      await Promise.all([query(requests), query(requests)]);
      assert.equal(calls, 1);
      for (now = 60_000; now < 300_000; now += 60_000) await query(requests);
      assert.equal(calls, 1, '失败期间不能退回每分钟发请求');
      requests = new QuotaRequests(file, send, () => now - 1);
      await query(requests); assert.equal(calls, 1, '重载不能绕过等待');
      now = 300_001; requests = new QuotaRequests(file, send, () => now);
      await query(requests); assert.equal(calls, 2);
      now += 300_000; await query(requests); assert.equal(calls, 2, '第二次失败至少等待十分钟');
      healthy = true; now += 300_000;
      await query(requests); assert.equal(calls, 3);
      now += 299_999; await query(requests); assert.equal(calls, 3, '成功后恢复五分钟缓存');
      now++; await query(requests); assert.equal(calls, 4);
      for (const entry of readFileSync(file, 'utf8').split('\n')) assert.doesNotMatch(entry, /secret-token|failed\.org|private failure detail/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('首次登录尚无身份时记录的冷却，身份确认后仍然生效', async () => {
  const dir=mkdtempSync(join(tmpdir(),'quota-new-identity-'));let calls=0;
  try {
    const file=join(dir,'waits.json'),send:typeof fetch=async()=>{calls++;return new Response(null,{status:429});};
    await new QuotaRequests(file,send,()=>0).forAccount('/config')(url,auth());
    const query=new QuotaRequests(file,send,()=>1).forAccount('account.org','/config');
    assert.equal((await query(url,auth('new-token'))).status,429);assert.equal(calls,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('身份暂时缺失时仍遵守原账号429等待，其他已确认账号不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-lost-identity-')); let calls = 0;
  try {
    const file = join(dir, 'waits.json');
    const send: typeof fetch = async () => { calls++; return new Response(null, { status: 429 }); };
    await new QuotaRequests(file, send, () => 0).forAccount('known.org', '/config')(url, auth());
    const reloaded = new QuotaRequests(file, send, () => 1);
    assert.equal((await reloaded.forAccount('/config', '/config')(url, auth('renewed-token'))).status, 429);
    assert.equal(calls, 1);
    await reloaded.forAccount('other.org', '/config')(url, auth('other-token'));
    assert.equal(calls, 2);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /known\.org|\/config|token/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('合并旧查询目录的等待时保留较晚截止，不修改旧文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-legacy-wait-')); let calls = 0;
  try {
    const file = join(dir, 'waits.json'), legacy = join(dir, 'old-waits.json');
    const key = createHash('sha256').update('legacy.org').digest('hex');
    writeFileSync(file, JSON.stringify({ [key]: 1000 }));
    const original = JSON.stringify({ [key]: 2000 }); writeFileSync(legacy, original);
    const requests = new QuotaRequests(file, async () => { calls++; return Response.json({}); }, () => 1500, legacy);
    assert.equal((await requests.forAccount('legacy.org')(url, auth())).status, 429);
    assert.equal(calls, 0); assert.equal(readFileSync(legacy, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('连续故障等待最多三十分钟，成功后重新计数，其他账号和接口不被阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-failure-cap-')); let now = 0, calls = 0, healthy = false;
  try {
    const requests = new QuotaRequests(join(dir, 'waits.json'), async input => {
      calls++;
      return healthy || String(input).endsWith('/profile') ? Response.json({}) : new Response(null, { status: 503 });
    }, () => now);
    const query = requests.forAccount('backoff.org');
    for (const wait of [300_000, 600_000, 1200_000, 1800_000, 1800_000]) {
      await query(url, auth()); const sent = calls;
      assert.equal(requests.problem('backoff.org')?.until, now + wait);
      now += wait - 1; await query(url, auth()); assert.equal(calls, sent);
      now++;
    }
    await query(url, auth()); const sent = calls;
    await query('https://api.anthropic.com/api/oauth/profile', auth()); assert.equal(calls, sent + 1);
    await requests.forAccount('independent.org')(url, auth()); assert.equal(calls, sent + 2);
    healthy = true; now += 1800_000; await query(url, auth());
    assert.equal(requests.problem('backoff.org'), null);
    healthy = false; now += 300_000; await query(url, auth());
    assert.equal(requests.problem('backoff.org')?.until, now + 300_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
