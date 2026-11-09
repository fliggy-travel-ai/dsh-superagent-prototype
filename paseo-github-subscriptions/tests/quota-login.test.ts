import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginFlows, ensureConfigDirectory, extractLoginUrl, nextProviderId, parseAuthStatus, type LoginPorts, type TerminalLike } from '../server/modules/usage-claude-accounts/login.ts';

const challenge = 'a'.repeat(43);
const URL_TEXT = `https://claude.com/cai/oauth/authorize?code=true&client_id=test&code_challenge=${challenge}&state=${'b'.repeat(43)}`;

test('登录链接被终端折成多行时拼回完整链接，长度不对时报错', () => {
  const half = Math.floor(URL_TEXT.length / 2);
  assert.equal(extractLoginUrl(['登录中…', URL_TEXT.slice(0, half), URL_TEXT.slice(half), 'Paste code here if prompted > ']), URL_TEXT);
  assert.equal(extractLoginUrl(['还没有链接']), null);
  assert.throws(() => extractLoginUrl([URL_TEXT.slice(0, URL_TEXT.length - 5), 'Paste code here']), /state 长度是 38/);
});

test('下一个 Provider 编号：claude-N 的最大值加一，最小 2', () => {
  assert.equal(nextProviderId({}), 'claude-2');
  assert.equal(nextProviderId({ claude: {}, 'claude-2': {}, 'claude-10': {}, 'claude-x': {}, codex: {} }), 'claude-11');
});

test('读取登录状态：JSON 和纯文本两种输出', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"email":"u@example.com","subscriptionType":"max"}'), { loggedIn: true, email: 'u@example.com', subscriptionType: 'max' });
  assert.deepEqual(parseAuthStatus('Login method: Claude\nemail: u@example.com'), { loggedIn: true, email: 'u@example.com', subscriptionType: null });
  assert.deepEqual(parseAuthStatus('Not logged in'), { loggedIn: false, email: null, subscriptionType: null });
});

test('建配置目录：子目录权限 700，技能和提示词用链接共享，已有内容不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'login-dir-'));
  try {
    const shared = join(root, '.claude'); mkdirSync(join(shared, 'skills'), { recursive: true }); writeFileSync(join(shared, 'CLAUDE.md'), 'x');
    const dir = join(root, '.claude-5');
    ensureConfigDirectory(dir, shared);
    assert.equal(statSync(join(dir, 'tmp')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'cache', 'xdg')).mode & 0o777, 0o700);
    assert.equal(existsSync(join(dir, 'projects')), true);
    assert.equal(readlinkSync(join(dir, 'skills')), join(shared, 'skills'));
    assert.equal(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink(), true);
    writeFileSync(join(dir, 'CLAUDE.md.keep'), 'k');
    ensureConfigDirectory(dir, shared);
    assert.equal(existsSync(join(dir, 'CLAUDE.md.keep')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(options: { email?: string | null; urlLines?: string[]; workspace?: boolean; loggedInAfter?: number } = {}) {
  const log: string[] = [];
  const state = { providers: { claude: { models: [{ id: 'm1' }] } } as Record<string, any>, written: [] as Array<[string, any]>, reloads: 0, backups: [] as string[], reloadFails: false, labels: {} as Record<string, string>, typed: [] as string[], keys: [] as string[][], statusCalls: 0, provider: {} as Record<string, string>, killed: 0 };
  let phase: 'login' | 'shell' = 'login';
  const terminal: TerminalLike = {
    id: 'term-1',
    write: data => { state.typed.push(data); if (data.includes('claude auth login')) phase = 'login'; },
    sendKeys: keys => { state.keys.push([...keys]); if (keys.includes('C-c')) phase = 'shell'; },
    capture: async () => phase === 'shell' ? ['bbm@host ~ % '] : options.urlLines ?? [URL_TEXT.slice(0, 60), URL_TEXT.slice(60), 'Paste code here if prompted > '],
    kill: async () => { state.killed++; },
  };
  const ports: LoginPorts = {
    homeDirectory: '/Users/test', providers: () => state.providers, backupConfig: () => { log.push('backup'); const path = `/backup/${state.backups.length}`; state.backups.push(path); return path; },
    writeProvider: (id, entry) => { state.written.push([id, entry]); state.providers[id] = { ...state.providers[id], ...entry }; if (entry.label !== undefined) state.provider[id] = entry.label as string; },
    reloadProviders: async () => { state.reloads++; if (state.reloadFails) throw new Error('reload failed'); },
    ensureConfigDirectory: dir => { log.push(`dir:${dir}`); },
    findLoginWorkspace: async () => options.workspace === false ? null : { id: 'wks-login', cwd: '/tmp/login' },
    createTerminal: async (workspaceId, name) => { log.push(`terminal:${workspaceId}:${name}`); return terminal; },
    authStatus: async () => { state.statusCalls++; return state.statusCalls > (options.loggedInAfter ?? 0) ? { loggedIn: true, email: options.email === undefined ? 'new@example.com' : options.email, subscriptionType: 'max' } : { loggedIn: false, email: null, subscriptionType: null }; },
    setLabel: (key, value) => { state.labels[key] = value; },
    sleep: async () => {},
  };
  return { flows: new LoginFlows(ports), state, log, terminal };
}

test('添加账号：写配置、建目录、开终端、读到登录链接，停在等授权码', async () => {
  const { flows, state, log } = fixture();
  const flow = await flows.start({});
  assert.deepEqual(log.slice(0, 3), ['backup', 'dir:/Users/test/.claude-2', 'terminal:wks-login:Claude 2 登录']);
  const [id, entry] = state.written[0]!;
  assert.equal(state.reloads, 1);
  assert.equal(id, 'claude-2');
  assert.equal(entry.extends, 'claude');
  assert.equal(entry.env.CLAUDE_CONFIG_DIR, '/Users/test/.claude-2');
  assert.equal(entry.env.TMPDIR, '/Users/test/.claude-2/tmp');
  assert.deepEqual(entry.models, [{ id: 'm1' }]);
  assert.match(state.typed.join(''), /BROWSER=\/usr\/bin\/true CLAUDE_CONFIG_DIR='\/Users\/test\/\.claude-2' claude auth login --claudeai/);
  assert.deepEqual(state.keys.at(-1), ['Enter']);
  assert.equal(flow.providerId, 'claude-2');
  assert.equal(flow.step, 5);
  assert.equal(flow.loginUrl, URL_TEXT);
  assert.equal(flow.terminalId, 'term-1');
  assert.equal(flow.workspaceId, 'wks-login');
  assert.equal(flow.error, null);
});

test('重新登录已有账号：不改配置，只开终端', async () => {
  const { flows, state } = fixture();
  state.providers['claude-3'] = { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-3' } };
  const flow = await flows.start({ providerId: 'claude-3' });
  assert.deepEqual(state.written, []);
  assert.equal(flow.providerId, 'claude-3');
  assert.equal(flow.configDir, '~/.claude-3');
  await assert.rejects(flows.start({ providerId: 'nope' }), /不存在/);
});

test('没有“账号登录”工作区时先报错，不写配置、不备份、不开终端', async () => {
  const { flows, state, log } = fixture({ workspace: false });
  const flow = await flows.start({});
  assert.match(flow.error!, /账号登录/);
  assert.equal(flow.step, 1);
  assert.deepEqual(state.written, []);
  assert.deepEqual(log, []);
  assert.equal(state.reloads, 0);
});

test('重复点“添加账号”复用没登录完的 Provider，不再新建、不再备份', async () => {
  const { flows, state } = fixture({ workspace: false });
  await flows.start({});
  assert.equal(state.written.length, 0);
  const second = fixture();
  await second.flows.start({});
  assert.equal(second.state.written.length, 1);
  assert.equal(second.state.backups.length, 1);
  second.state.providers['claude-2'].label = 'Claude 2（待登录）';
  // 流程出错后再点添加：复用 claude-2
  const failing = fixture({ workspace: true });
  failing.state.providers['claude-2'] = { extends: 'claude', label: 'Claude 2（待登录）', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-2' } };
  const flow = await failing.flows.start({});
  assert.equal(flow.providerId, 'claude-2');
  assert.deepEqual(failing.state.written, []);
  assert.deepEqual(failing.state.backups, []);
});

test('同时只允许一个登录流程；同一个账号可以重新开始，出错的流程可以被替换', async () => {
  const { flows, state } = fixture();
  await flows.start({});
  await assert.rejects(flows.start({}), /已有进行中的登录引导（claude-2）/);
  state.providers['claude-5'] = { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-5' } };
  await assert.rejects(flows.start({ providerId: 'claude-5' }), /已有进行中/);
  const again = await flows.start({ providerId: 'claude-2' });
  assert.equal(again.providerId, 'claude-2');
  assert.equal(state.killed, 1);
  const failed = fixture({ workspace: false });
  await failed.flows.start({});
  failed.state.providers['claude-5'] = { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-5' } };
  assert.equal((await failed.flows.start({ providerId: 'claude-5' })).providerId, 'claude-5');
});

test('写配置后重载；写后读回不一致时报错并停在第 1 步，不开终端', async () => {
  const bad = fixture();
  const original = bad.state.providers;
  void original;
  const ports = (bad.flows as unknown as { ports: LoginPorts }).ports;
  ports.writeProvider = () => { throw new Error('写入后读回不一致（extends）。配置可能被其他程序改动，可用备份 /backup/0 恢复'); };
  const flow = await bad.flows.start({});
  assert.match(flow.error!, /读回不一致.*\/backup\/0/);
  assert.equal(flow.step, 1);
  assert.equal(bad.state.reloads, 0);
  assert.ok(!bad.log.some(line => line.startsWith('terminal')));
});

test('配置已写入但重载失败：提示手动重载，不开终端', async () => {
  const { flows, state, log } = fixture();
  state.reloadFails = true;
  const flow = await flows.start({});
  assert.match(flow.error!, /配置已写入，但 Paseo 重载失败/);
  assert.equal(state.written.length, 1);
  assert.ok(!log.some(line => line.startsWith('terminal')));
});

test('提交授权码：输入到终端，读到邮箱后命名为“Claude · 邮箱”，流程结束并关闭终端', async () => {
  const { flows, state } = fixture();
  await flows.start({});
  state.typed.length = 0; state.keys.length = 0;
  const snapshot = await flows.submitCode({ providerId: 'claude-2', code: 'code-123' });
  assert.deepEqual(state.typed, ['code-123']);
  assert.deepEqual(state.keys.at(-1), ['Enter']);
  assert.equal(snapshot, null);
  assert.equal(state.provider['claude-2'], 'Claude · new@example.com');
  assert.equal(state.killed, 1);
  assert.equal(flows.current(), null);
});

test('Apple 隐藏邮箱：停在第 6 步要求确认真实邮箱，确认后写 labels.json 并命名“（Apple 登录）”', async () => {
  const hidden = 'x@' + 'private' + 'relay.appleid.example';
  const { flows, state } = fixture({ email: hidden });
  await flows.start({});
  const waiting = await flows.submitCode({ providerId: 'claude-2', code: 'c' });
  assert.equal(waiting!.step, 6);
  assert.equal(waiting!.requiresRealEmailConfirmation, true);
  assert.equal(waiting!.detectedEmail, hidden);
  assert.equal(state.provider['claude-2'], 'Claude 2（待登录）');
  assert.equal(await flows.confirmRealEmail('claude-2', 'Real.User@Example.com'), true);
  assert.equal(state.labels[hidden], 'real.user@example.com（Apple 登录）');
  assert.equal(state.provider['claude-2'], 'Claude · real.user@example.com（Apple 登录）');
  assert.equal(flows.current(), null);
  assert.equal(await flows.confirmRealEmail('claude-2', 'a@example.com'), false);
});

test('授权码无效或登录没完成：保留流程并给出错误，可以重试', async () => {
  const { flows } = fixture({ loggedInAfter: 1000 });
  await flows.start({});
  const failed = await flows.submitCode({ providerId: 'claude-2', code: 'bad' });
  assert.match(failed!.error!, /没有完成/);
  assert.equal(failed!.step, 5);
  await assert.rejects(flows.submitCode({ providerId: 'other', code: 'x' }), /没有正在进行/);
});

test('重新触发：发送 Ctrl-C，确认回到命令行后重新登录并读到新链接', async () => {
  const { flows, state } = fixture();
  await flows.start({});
  state.keys.length = 0; state.typed.length = 0;
  const flow = await flows.retry('claude-2');
  assert.deepEqual(state.keys[0], ['C-c']);
  assert.match(state.typed.join(''), /claude auth login --claudeai/);
  assert.equal(flow.loginUrl, URL_TEXT);
});

import { claudeAccountsLoginSubmitCode } from '../shared/claude-accounts.ts';

test('授权码只能含字母、数字和 _ - # . ~，长度有限；含 shell 字符的被拒绝，终端里什么都不输入', async () => {
  const { flows, state } = fixture();
  await flows.start({});
  state.typed.length = 0; state.keys.length = 0;
  for (const code of ['x; rm -rf ~', '$(touch /tmp/x)', 'a b', 'a`b`', 'a\nb', 'a|b', "a'b", 'a&b', 'a'.repeat(513), '']) {
    await assert.rejects(flows.submitCode({ providerId: 'claude-2', code }), /授权码/, JSON.stringify(code));
  }
  assert.deepEqual(state.typed, []);
  assert.deepEqual(state.keys, []);
  assert.equal(claudeAccountsLoginSubmitCode.input.safeParse({ providerId: 'claude-2', code: 'x; rm -rf ~' }).success, false);
  assert.equal(claudeAccountsLoginSubmitCode.input.safeParse({ providerId: 'claude-2', code: 'AbC123_-.~#xyz' }).success, true);
});

test('写入授权码前确认终端仍在等待授权码，否则拒绝，不输入', async () => {
  const { flows, state, terminal } = fixture();
  await flows.start({});
  terminal.sendKeys(['C-c']);
  state.typed.length = 0; state.keys.length = 0;
  await assert.rejects(flows.submitCode({ providerId: 'claude-2', code: 'valid-code#123' }), /终端已不在等待授权码/);
  assert.deepEqual(state.typed, []);
  assert.deepEqual(state.keys, []);
});
