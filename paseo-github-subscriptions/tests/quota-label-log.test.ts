import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaLabelService } from '../server/modules/usage-claude-accounts/quota-labels.ts';

test('全部 Claude 账号停用时，不请求额度或读取登录凭据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-disabled-'));
  const previous = process.env.PASEO_CLI;
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agents: { providers: {
      claude: { enabled: false, label: 'Claude' },
      'claude-off': { extends: 'claude', enabled: false, env: { CLAUDE_CONFIG_DIR: '/u/.claude-off' } },
    } } }));
    process.env.PASEO_CLI = join(dir, 'must-not-run');
    const service = new QuotaLabelService({ home: dir, discover: async () => {
      assert.fail('停用的账号不得读取登录凭据');
    } });
    await (service as unknown as { update(): Promise<void> }).update();
    assert.equal(service.quotas().size, 0);
  } finally {
    if (previous === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('更新显示名称的日志只写 Provider 编号和百分比，不写含邮箱的显示名称', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-label-log-'));
  const previous = process.env.PASEO_CLI; const info = console.info;
  const lines: string[] = [];
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agents: { providers: { 'claude-2': { extends: 'claude', label: 'Claude · who@example.com', env: { CLAUDE_CONFIG_DIR: '/u/.claude-2' } } } } }));
    const reports = [{ sourceId: 'claude-accounts', id: 'claude-accounts:k1', report: { status: 'available', windows: [{ id: 'five_hour', usedPct: 60, remainingPct: 40, resetsAt: '2099-01-01T00:00:00Z' }] } }];
    const cli = join(dir, 'cli'); writeFileSync(cli, `#!/bin/sh\nif [ "$1" = "usage" ]; then echo '${JSON.stringify(reports)}'; else echo '{}'; fi\n`); chmodSync(cli, 0o755);
    process.env.PASEO_CLI = cli;
    console.info = (...args: unknown[]) => { lines.push(args.join(' ')); };
    const service = new QuotaLabelService({ home: dir, discover: (async () => [{ key: 'k1', harness: 'Claude', input: {} }]) as never });
    await (service as unknown as { update(): Promise<void> }).update();
    assert.match(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).agents.providers['claude-2'].label, /剩 40%/);
    const text = lines.join('\n');
    assert.ok(text.includes('claude-2'), text);
    assert.ok(text.includes('40%'), text);
    assert.ok(!text.includes('who@example.com'), text);
  } finally {
    console.info = info;
    if (previous === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
