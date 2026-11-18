import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adsPowerLoginMethod, browserAccountKey, registeredClaudeAccounts } from '../server/browser-usage-accounts.ts';
import { BrowserUsageStore } from '../server/browser-usage.ts';

test('AdsPower 登录标签区分 Apple 和直接登录，缺失或冲突标签不用于去重', () => {
  for (const name of ['Apple登陆', 'Apple 登录']) assert.equal(adsPowerLoginMethod({ fbcc_user_tag: [{ name }] }), 'apple');
  for (const name of ['Google登陆', 'Google登录', '邮箱登录']) assert.equal(adsPowerLoginMethod({ fbcc_user_tag: [{ name }] }), 'direct');
  assert.equal(adsPowerLoginMethod({ fbcc_user_tag: [{ name: 'MacMini' }] }), 'unknown');
  assert.equal(adsPowerLoginMethod({ fbcc_user_tag: [{ name: 'Apple登陆' }, { name: 'Google登陆' }] }), 'unknown');
  assert.equal(adsPowerLoginMethod({ fbcc_user_tag: 'Apple登陆' }), 'unknown');
  assert.equal(browserAccountKey(' USER@example.com ', 'apple'), 'apple:user@example.com');
  assert.equal(browserAccountKey('user@example.com', 'unknown'), undefined);
  assert.equal(browserAccountKey('Claude · user@example.com', 'direct'), undefined);
});

test('注册账号使用启用的 Claude Provider，优先读取身份元数据并支持 Apple 标签映射', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-claude-registry-'));
  try {
    const local = join(directory, 'local');
    const apple = join(directory, 'apple');
    await mkdir(local);
    await mkdir(apple);
    const identity = (emailAddress: string) => JSON.stringify({ oauthAccount: { accountUuid: 'account', organizationUuid: 'org', emailAddress } });
    const hiddenEmail = `hidden@${'private' + 'relay.appleid.example'}`;
    await writeFile(join(local, '.claude.json'), identity('real@example.com'));
    await writeFile(join(apple, '.claude.json'), identity(hiddenEmail));
    const labels = join(directory, 'labels.json');
    await writeFile(labels, JSON.stringify({ [hiddenEmail]: 'apple@example.com（Apple 登录）' }));
    const config = {
      agents: { providers: {
        claude: { enabled: false },
        local: { extends: 'claude', label: 'Claude · stale@example.com', env: { CLAUDE_CONFIG_DIR: local } },
        apple: { extends: 'claude', label: 'Claude · stale-apple@example.com（Apple 登录）', env: { CLAUDE_CONFIG_DIR: apple } },
        isolated: { extends: 'claude', label: 'Claude · 剩 5% · ISOLATED@example.com（Apple 登录）', env: { CLAUDE_CONFIG_DIR: join(directory, 'unreadable') } },
        direct: { extends: 'claude', enabled: true, label: 'Claude · 剩 54% · user@example.com', env: { CLAUDE_CONFIG_DIR: join(directory, 'direct') } },
        disabled: { extends: 'claude', enabled: false, label: 'Claude · disabled@example.com' },
        codex: { extends: 'codex', label: 'Claude · codex@example.com' },
        api: { extends: 'claude', label: 'Claude · api@example.com', env: { ANTHROPIC_API_KEY: 'fixture' } },
        custom: { extends: 'claude', label: 'Claude · custom@example.com', env: { ANTHROPIC_BASE_URL: 'https://example.com' } },
        oauth: { extends: 'claude', label: 'Claude · oauth@example.com', env: { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'fixture' } },
        bedrock: { extends: 'claude', label: 'Claude · bedrock@example.com', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
        ambiguous: { extends: 'claude', label: 'Claude · first@example.com / second@example.com', env: { CLAUDE_CONFIG_DIR: join(directory, 'ambiguous') } },
        inherited: { extends: 'claude', label: 'Claude · inherited@example.com' },
      } },
    };
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    assert.deepEqual([...registeredClaudeAccounts(directory, labels)].sort(), [
      'apple:apple@example.com', 'apple:isolated@example.com', 'direct:real@example.com', 'direct:user@example.com',
    ]);
    config.agents.providers.direct.enabled = false;
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    assert.equal(registeredClaudeAccounts(directory, labels).has('direct:user@example.com'), false);
    await writeFile(join(directory, 'config.json'), '{');
    assert.equal(registeredClaudeAccounts(directory, labels).size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Apple 隐藏邮箱缺少映射和账号标签时保留浏览器项', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-claude-unmapped-'));
  try {
    const hiddenEmail = `hidden@${'private' + 'relay.appleid.example'}`;
    await writeFile(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account', organizationUuid: 'org', emailAddress: hiddenEmail } }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({ agents: { providers: {
      claude: { enabled: false },
      apple: { extends: 'claude', label: 'Claude', env: { CLAUDE_CONFIG_DIR: directory } },
    } } }));
    assert.equal(registeredClaudeAccounts(directory, join(directory, 'labels.json')).size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('完整账号资料查询失败时保留自动识别的环境名称，未知登录方式不隐藏', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-claude-fallback-'));
  const now = Date.parse('2026-11-18T12:00:00Z');
  const store = new BrowserUsageStore(directory, () => now, {
    registeredClaudeAccounts: () => new Set(['direct:user@example.com']),
    adspowerMinIntervalMs: 0,
    fetchFn: (async input => {
      const active = new URL(String(input)).pathname.endsWith('local-active');
      return { ok: active, status: active ? 200 : 503, json: async () => active
        ? { code: 0, data: { list: [{ user_id: 'profile', name: 'user@example.com' }] } }
        : { code: -1, msg: 'error' } } as Response;
    }) as typeof fetch,
  });
  try {
    await store.load();
    await store.record({ instanceId: 'extension', instanceName: '未命名浏览器环境', status: 'ok', observedAt: new Date(now).toISOString(), fiveHour: null, weekly: null });
    await store.flushQueries();
    const record = await store.get('extension');
    assert.equal(record?.displayName, 'user@example.com');
    assert.equal(record?.adspowerLoginMethod, 'unknown');
    assert.equal((await store.discover()).length, 1);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重载已确认未知的登录方式或多个无绑定环境时不重复补取资料', async () => {
  for (const records of [
    [{ instanceId: 'first', instanceName: '未命名浏览器环境', adspowerProfile: 'profile', adspowerName: 'user@example.com', adspowerLoginMethod: 'unknown' }],
    [{ instanceId: 'first', instanceName: '未命名浏览器环境', adspowerName: 'user@example.com' }, { instanceId: 'second', instanceName: '未命名浏览器环境', adspowerName: 'other@example.com' }],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'browser-claude-no-reprobe-'));
    const now = Date.parse('2026-11-18T12:00:00Z');
    let calls = 0;
    const store = new BrowserUsageStore(directory, () => now, {
      registeredClaudeAccounts: () => new Set(['direct:user@example.com']), adspowerMinIntervalMs: 0,
      fetchFn: (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch,
    });
    try {
      await writeFile(join(directory, 'browser-usage.json'), JSON.stringify({ records: records.map(record => ({ ...record, lastPostAt: now, status: 'ok', fiveHour: null, weekly: null })) }));
      await store.load();
      await store.flushQueries();
      assert.equal(calls, 0);
      assert.equal((await store.discover()).length, records.length);
    } finally {
      await store.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('同账号浏览器项自动去重，Provider 变化后恢复，记录与 Apple 同邮箱账号保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-claude-dedup-'));
  let now = Date.parse('2026-11-18T12:00:00Z');
  const registered = new Set(['direct:user@example.com']);
  let requests = 0;
  const rows = [
    { user_id: 'direct', name: 'USER@example.com', fbcc_user_tag: [{ name: '邮箱登录' }] },
    { user_id: 'apple', name: 'user@example.com', fbcc_user_tag: [{ name: 'Apple登陆' }] },
    { user_id: 'other', name: 'other@example.com', fbcc_user_tag: [{ name: 'Google登陆' }] },
    { user_id: 'unknown', name: 'user@example.com', fbcc_user_tag: [] },
  ];
  const store = new BrowserUsageStore(directory, () => now, {
    registeredClaudeAccounts: () => registered,
    adspowerMinIntervalMs: 0,
    fetchFn: (async () => {
      requests++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rows } }) } as Response;
    }) as typeof fetch,
  });
  try {
    await store.load();
    for (const row of rows) {
      await store.record({ instanceId: row.user_id, instanceName: '未命名浏览器环境', adspowerProfile: row.user_id, status: 'ok', observedAt: new Date(now).toISOString(), fiveHour: null, weekly: null });
      await store.flushQueries();
    }
    const discovered = await store.discover();
    assert.deepEqual(discovered.map(account => (account.input as { instanceId: string }).instanceId).sort(), ['apple', 'other', 'unknown']);
    assert.equal((await store.get('direct'))?.adspowerLoginMethod, 'direct');
    const before = requests;
    registered.clear();
    assert.equal((await store.discover()).length, 4);
    registered.add('apple:user@example.com');
    assert.deepEqual((await store.discover()).map(account => (account.input as { instanceId: string }).instanceId).sort(), ['direct', 'other', 'unknown']);
    assert.equal(requests, before);
    const saved = JSON.parse(await readFile(join(directory, 'browser-usage.json'), 'utf8'));
    assert.equal(saved.records.length, 4);
    now += 11 * 60_000;
    await store.record({ instanceId: 'direct', instanceName: '未命名浏览器环境', adspowerProfile: 'other', status: 'ok', observedAt: new Date(now).toISOString(), fiveHour: null, weekly: null });
    await store.flushQueries();
    registered.add('direct:user@example.com');
    assert.equal((await store.discover()).some(account => (account.input as { instanceId: string }).instanceId === 'direct'), true);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧记录热更新后补取登录标签，自动识别环境有名称时仍核对完整账号资料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-claude-migrate-'));
  const now = Date.parse('2026-11-18T12:00:00Z');
  const calls: string[] = [];
  const store = new BrowserUsageStore(directory, () => now, {
    registeredClaudeAccounts: () => new Set(['direct:user@example.com']),
    adspowerMinIntervalMs: 0,
    fetchFn: (async input => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      const row = { user_id: 'profile', name: 'user@example.com' };
      const data = path.endsWith('local-active') ? { list: [row] } : { list: [{ ...row, fbcc_user_tag: [{ name: '邮箱登录' }] }] };
      return { ok: true, status: 200, json: async () => ({ code: 0, data }) } as Response;
    }) as typeof fetch,
  });
  try {
    await writeFile(join(directory, 'browser-usage.json'), JSON.stringify({ records: [{
      instanceId: 'extension', instanceName: '未命名浏览器环境', adspowerName: 'user@example.com', adspowerQueriedAt: now,
      lastPostAt: now, status: 'ok', fiveHour: null, weekly: null,
    }] }));
    await store.load();
    await store.flushQueries();
    assert.deepEqual(await store.discover(), []);
    assert.deepEqual(calls, ['/api/v1/browser/local-active', '/api/v1/user/list']);
    assert.equal((await store.get('extension'))?.adspowerLoginMethod, 'direct');
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
