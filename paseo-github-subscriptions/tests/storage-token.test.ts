import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../server/storage.ts';
import { TokenVault } from '../server/token.ts';
import { parseTarget } from '../shared/target.ts';

test('目标解析接受GitHub地址，拒绝其他主机和路径', () => {
  assert.equal(parseTarget('https://github.com/OWNER/Repo/pull/123').key, 'owner/repo#123');
  assert.equal(parseTarget('OWNER/Repo').scope, 'repo');
  for (const input of ['https://other.test/owner/repo/issues/1', 'owner/repo#0', 'owner/repo/../secret', 'owner/repo#999999999999999999']) assert.throws(() => parseTarget(input));
});

test('状态变更串行落盘，失败事务不覆盖已有状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghsub-storage-'));
  try {
    const storage = new Storage(directory); await storage.load();
    await Promise.all(Array.from({ length: 20 }, (_, index) => storage.mutate(state => { state.seen[String(index)] = '2026-11-06'; })));
    assert.equal(Object.keys(storage.state.seen).length, 20);
    await assert.rejects(storage.mutate(state => { state.seen.lost = 'no'; throw new Error('事务失败'); }));
    assert.equal(storage.state.seen.lost, undefined);
    const persisted = new Storage(directory); await persisted.load();
    assert.equal(Object.keys(persisted.state.seen).length, 20);
    assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await writeFile(join(directory, 'state.json'), '{broken');
    await assert.rejects(new Storage(directory).load(), /状态文件/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('令牌仅存独立0600文件，状态和错误不含明文，重启读取及删除有效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghsub-token-'));
  const token = 'github_pat_TEST_SECRET_NOT_REAL';
  const request = (async () => new Response(JSON.stringify({ login: 'bbm9527' }), { headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1794000000' } })) as typeof fetch;
  try {
    const vault = new TokenVault(directory, request); await vault.load();
    assert.equal(await vault.read(), null);
    const result = await vault.save(token);
    assert.equal(result.login, 'bbm9527');
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(vault.redact(new Error(`failed ${token}`)).includes(token), false);
    assert.equal((await stat(join(directory, 'github-token'))).mode & 0o777, 0o600);
    const restarted = new TokenVault(directory, request); await restarted.load();
    assert.equal(await restarted.read(), token);
    await restarted.remove();
    assert.equal(await restarted.read(), null);
    assert.equal(restarted.status.configured, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('令牌验证失败保留已有令牌，不向错误输出输入明文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghsub-token-reject-'));
  try {
    await writeFile(join(directory, 'github-token'), 'ghp_OLD_TOKEN');
    const vault = new TokenVault(directory, (async () => { throw new Error('github_pat_NEW_SECRET'); }) as typeof fetch);
    await vault.load();
    await assert.rejects(vault.save('github_pat_NEW_SECRET'), error => !String(error).includes('github_pat_NEW_SECRET'));
    assert.equal(await vault.read(), 'ghp_OLD_TOKEN');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
