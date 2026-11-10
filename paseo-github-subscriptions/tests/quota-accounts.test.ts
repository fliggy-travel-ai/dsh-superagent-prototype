import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAccounts, APPLE_SUFFIX } from '../server/modules/usage-claude-accounts/accounts.ts';

const RELAY = 'private' + 'relay.appleid.example';

test('列出 Claude 账号：显示名称、邮箱、Apple 登录、配置目录缩写、需要重新登录、剩余额度', async () => {
  const home = mkdtempSync(join(tmpdir(), 'accounts-'));
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: {
      claude: { label: 'Claude · 默认' },
      'claude-2': { extends: 'claude', label: 'Claude · 剩 40% · a@example.com', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-2' } },
      'claude-3': { extends: 'claude', label: 'Claude · 待登录', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-3' } },
      'claude-4': { extends: 'claude', enabled: false, env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-4' } },
      codex: { label: 'Codex' },
    } } }));
    const emails: Record<string, string | null> = { '/Users/test/.claude-2': `x@${RELAY}`, '/Users/test/.claude-3': null };
    const accounts = await listAccounts({
      home, homeDirectory: '/Users/test', baseEnv: {},
      labels: () => ({ [`x@${RELAY}`]: `real@example.com${APPLE_SUFFIX}` }),
      quotas: new Map([['claude-2', { remainingPct: 40, weeklyResetAt: null }]]),
      needsLogin: async env => env.CLAUDE_CONFIG_DIR === '/Users/test/.claude-3',
      identityEmail: env => (env.CLAUDE_CONFIG_DIR ? emails[env.CLAUDE_CONFIG_DIR] ?? null : 'default@example.com'),
    });
    assert.deepEqual(accounts.map(a => a.providerId), ['claude', 'claude-2', 'claude-3']);
    assert.deepEqual(accounts[0], { providerId: 'claude', label: 'Claude · 默认', email: 'default@example.com', appleLogin: false, configDir: '~/.claude', needsRelogin: false, remainingPct: null });
    assert.deepEqual(accounts[1], { providerId: 'claude-2', label: 'Claude · 剩 40% · a@example.com', email: 'real@example.com', appleLogin: true, configDir: '~/.claude-2', needsRelogin: false, remainingPct: 40 });
    assert.equal(accounts[2]!.needsRelogin, true);
    assert.equal(accounts[2]!.email, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('config.json 读不到时只列默认账号，不抛错', async () => {
  const accounts = await listAccounts({ home: '/nonexistent-home', homeDirectory: '/Users/test', baseEnv: {}, labels: () => ({}), quotas: new Map(), needsLogin: async () => true, identityEmail: () => null });
  assert.deepEqual(accounts.map(a => a.providerId), ['claude']);
  assert.equal(accounts[0]!.needsRelogin, true);
});
