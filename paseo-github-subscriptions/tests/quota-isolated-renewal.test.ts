import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeIsolatedLogin } from '../server/modules/usage-claude-accounts/isolated-renewal.ts';

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'isolated-login-'));
  const command = join(directory, 'claude');
  writeFileSync(command, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return { directory, command, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('仅发送初始化控制消息，禁用工具与hooks，等待官方程序正常退出', async () => {
  const fake = fixture(`
    const assert = require('node:assert/strict');
    assert.ok(process.argv.includes('--safe-mode'));
    assert.ok(process.argv.includes('--no-session-persistence'));
    assert.equal(process.argv[process.argv.indexOf('--tools') + 1], '');
    assert.deepEqual(JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]), {mcpServers:{}});
    assert.deepEqual(JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]), {disableAllHooks:true});
    let received = '';
    process.stdin.on('data', chunk => {
      received += chunk;
      if (!received.endsWith('\\n')) return;
      const request = JSON.parse(received);
      assert.deepEqual(request, {type:'control_request',request_id:'isolated-quota-renewal',request:{subtype:'initialize'}});
      process.stdout.write(JSON.stringify({type:'system',subtype:'init'})+'\\n');
      const response = JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id}})+'\\n';
      process.stdout.write(response.slice(0, 12));
      setTimeout(() => process.stdout.write(response.slice(12)), 5);
    });
  `);
  try { assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 2000), true); }
  finally { fake.close(); }
});

test('错误应答、提前退出、错误退出和意外模型输出不能视为初始化完成', async () => {
  const responses = [
    `process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:'isolated-quota-renewal'}})+'\\n');`,
    'process.exit(0);',
    `process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'isolated-quota-renewal'}})+'\\n'); process.exitCode=1;`,
    `process.stdout.write(JSON.stringify({type:'assistant',message:'fake-sensitive-value'})+'\\n');`,
    `process.stdout.write('x'.repeat(65537));`,
  ];
  for (const response of responses) {
    const fake = fixture(`process.stdin.once('data', () => { ${response} });`);
    try { assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 1000), false); }
    finally { fake.close(); }
  }
});

test('非本次请求的应答不会完成初始化，超时会停止进程组', async () => {
  const fake = fixture(`
    const {spawn} = require('node:child_process');
    const path = require('node:path');
    process.stdin.once('data', () => {
      require('node:fs').writeFileSync(path.join(process.cwd(), 'started'), 'ready');
      spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), 1200)", path.join(process.cwd(), 'leaked')], {stdio:'ignore'});
      process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'wrong-request'}})+'\\n');
      setInterval(() => {}, 100);
    });
  `);
  try {
    assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 1000), false);
    assert.equal(existsSync(join(fake.directory, 'started')), true);
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(existsSync(join(fake.directory, 'leaked')), false);
  } finally { fake.close(); }
});

test('启动器不存在或工作目录不可用时失败且不泄露子进程输出', async () => {
  assert.equal(await initializeIsolatedLogin('/nonexistent/launcher', '/tmp', 1000), false);
  assert.equal(await initializeIsolatedLogin(process.execPath, '/nonexistent/workspace', 1000), false);
});
test('忽略SIGTERM的启动器会被强制停止，清理包含在总预算内', async () => {
  const fake = fixture(`
    require('node:fs').writeFileSync('started', String(process.pid));
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    setInterval(() => {}, 100);
  `);
  try {
    const startedAt = Date.now();
    assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 1000), false);
    assert.equal(existsSync(join(fake.directory, 'started')), true);
    assert.ok(Date.now() - startedAt < 1400);
  } finally { fake.close(); }
});
test('等待启动器处理SIGTERM并关闭后才返回', async () => {
  const fake = fixture(`
    process.on('SIGTERM', () => setTimeout(() => {require('node:fs').writeFileSync('closed', 'ready');process.exit(0);}, 20));
    process.stdin.resume();
    setInterval(() => {}, 100);
  `);
  try {
    assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 1000), false);
    assert.equal(existsSync(join(fake.directory, 'closed')), true);
  } finally { fake.close(); }
});
test('关闭stdin使另一个进程组内的子进程退出，不依赖跨用户信号权限', async () => {
  const fake = fixture(`
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync('descendant-closed','ready');process.exit(0);});"], {detached:true,stdio:['pipe','ignore','ignore']});
    process.stdin.pipe(descendant.stdin);
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 100);
  `);
  try {
    assert.equal(await initializeIsolatedLogin(fake.command, fake.directory, 1000), false);
    assert.equal(existsSync(join(fake.directory, 'descendant-closed')), true);
  } finally { fake.close(); }
});
