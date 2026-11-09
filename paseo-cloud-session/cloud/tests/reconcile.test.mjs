import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { forward, notifyRequest } from '../dist/paseo-cloud-session.mjs';

// #1737 评论 6734539343：云端 forward 停止后关闭请求不再到达；按工具名猜编号会猜到上一个同名调用。

const env = { PASEO_MINI_HOST: 'https://app.paseo.sh/#offer=FAKE-SECRET' };
const sessionDir = id => join(tmpdir(), 'paseo-cloud-session-' + createHash('sha256').update(id).digest('hex'));
const marker = (id, toolUseId) => join(sessionDir(id), 'requests', createHash('sha256').update(toolUseId).digest('hex'));
const waitFor = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('timed out'); };
const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = id => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('钩子没带编号时按“同名且输入相同”的 tool_use 找编号，新调用晚写入也能等到；找不到就不通知', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-id-test-')), transcript = join(dir, 't.jsonl');
  const e = { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_id' + Date.now() };
  try {
    await writeFile(transcript, use('old-id', 'mcp__paseo__add_repo', { repo: 'first' }) + '\n');
    const seen = [];
    const rpc = async (c, v) => { seen.push(v.request.toolUseId); return { shown: true }; };
    setTimeout(() => void appendFile(transcript, use('new-id', 'mcp__paseo__add_repo', { repo: 'second' }) + '\n'), 400);
    await notifyRequest({ tool_name: 'mcp__paseo__add_repo', tool_input: { repo: 'second' }, transcript_path: transcript }, e, rpc);
    assert.deepEqual(seen, ['new-id']);
    // 两个调用都已有结果后，没有同名且无结果的调用：等不到就不通知
    await appendFile(transcript, [result('old-id'), result('new-id')].join('\n') + '\n');
    await notifyRequest({ tool_name: 'mcp__paseo__add_repo', tool_input: { repo: 'never' }, transcript_path: transcript }, { ...e, PASEO_CLOUD_ID_WAIT_MS: '300' }, rpc);
    assert.deepEqual(seen, ['new-id']);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID), { recursive: true, force: true }); }
});

test('钩子输入带默认值（multiSelect:false、replace_all:false）而记录里没有时，同名且无结果的调用只有一个就用它；有两个时不猜', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-default-test-')), transcript = join(dir, 't.jsonl');
  const e = { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_default' + Date.now(), PASEO_CLOUD_ID_WAIT_MS: '300' };
  try {
    await writeFile(transcript, [
      use('ask-done', 'AskUserQuestion', { questions: [{ question: '旧问题' }] }), result('ask-done'),
      use('ask-1', 'AskUserQuestion', { questions: [{ question: '选哪个？', options: [{ label: 'A' }] }] }),
      use('edit-1', 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }),
    ].join('\n') + '\n');
    const seen = [];
    const rpc = async (c, v) => { seen.push(v.request.toolUseId); return { shown: true }; };
    await notifyRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选哪个？', options: [{ label: 'A' }], multiSelect: false }] }, transcript_path: transcript }, e, rpc);
    await notifyRequest({ tool_name: 'Edit', tool_input: { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false }, transcript_path: transcript }, e, rpc);
    assert.deepEqual(seen, ['ask-1', 'edit-1']);
    // 两个同名且无结果的调用：输入对不上时不猜
    await appendFile(transcript, use('edit-2', 'Edit', { file_path: '/b', old_string: 'x', new_string: 'y' }) + '\n');
    await notifyRequest({ tool_name: 'Edit', tool_input: { file_path: '/c', old_string: 'x', new_string: 'y', replace_all: false }, transcript_path: transcript }, e, rpc);
    assert.deepEqual(seen, ['ask-1', 'edit-1']);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID), { recursive: true, force: true }); }
});

test('通知前先写 marker（内容是编号）；通知失败时删掉 marker', async () => {
  const e = { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_marker' + Date.now() };
  try {
    let existed = null;
    await notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_m1', tool_input: { command: 'x' } }, e, async () => { existed = await readFile(marker(e.CLAUDE_CODE_REMOTE_SESSION_ID, 'toolu_m1'), 'utf8').catch(() => null); return { shown: true }; });
    assert.equal(existed, 'toolu_m1');
    await assert.rejects(notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_m2', tool_input: { command: 'x' } }, e, async () => { throw Error('unreachable'); }));
    await assert.rejects(stat(marker(e.CLAUDE_CODE_REMOTE_SESSION_ID, 'toolu_m2')));
  } finally { await rm(sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID), { recursive: true, force: true }); }
});

test('forward 重启后从记录开头回放已有工具结果，补发重启前漏掉的关闭', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-replay-test-')), path = join(dir, 't.jsonl');
  const e = { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_replay' + Date.now() };
  const lock = join(sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID), 'forward.pid');
  const resolved = [];
  const rpc = async (c, v) => { if (c.name.endsWith('ensure')) return { agentId: 'a', workspaceId: 'w', epoch: 'e' }; if (c.name.endsWith('timeline.push')) return { accepted: v.items.length, epoch: 'e' }; if (c.name.endsWith('request.notify')) return { shown: true }; if (c.name.endsWith('request.resolve')) { resolved.push(v.toolUseId); return { closed: true }; } throw Error(c.name); };
  // 重启前：请求已通知（有 marker），工具结果也已写进记录，但旧 forward 已停止
  await notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_before', tool_input: { command: 'x' } }, e, rpc);
  await writeFile(path, [use('toolu_before', 'Bash', { command: 'x' }), result('toolu_before')].join('\n') + '\n');
  const size = (await stat(path)).size;
  const task = forward(path, e, rpc, size);
  try {
    await waitFor(() => resolved.includes('toolu_before'));
    await waitFor(async () => { try { return !!JSON.parse(await readFile(lock, 'utf8')).beatAt; } catch { return false; } });
  } finally { try { await writeFile(lock, JSON.stringify({ pid: process.pid, path: 'finished', token: 'finished' })); } catch {} await task; await rm(dir, { recursive: true, force: true }); await rm(sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID), { recursive: true, force: true }); }
});

test('通知时发现 forward 不在或心跳过期，结束旧进程并重新拉起 forward；心跳新鲜时不动', async () => {
  const e = { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_revive' + Date.now() };
  const dir = sessionDir(e.CLAUDE_CODE_REMOTE_SESSION_ID); await mkdir(dir, { recursive: true });
  const lock = join(dir, 'forward.pid');
  const launches = [];
  const launch = (_exe, args) => { launches.push(args.slice(1)); return { unref() {}, on() {} }; };
  const rpc = async () => ({ shown: true });
  try {
    // 1. 进程已不存在
    await writeFile(lock, JSON.stringify({ pid: 999999, path: '/cloud/t.jsonl', token: 't', beatAt: Date.now() }));
    await notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_r1', tool_input: {} }, e, rpc, launch);
    assert.equal(launches.length, 1); assert.equal(launches[0][0], 'forward'); assert.equal(launches[0][1], '/cloud/t.jsonl');
    // 2. 进程活着、心跳新鲜：不动
    await writeFile(lock, JSON.stringify({ pid: process.pid, path: '/cloud/t.jsonl', token: 't', beatAt: Date.now() }));
    await notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_r2', tool_input: {} }, e, rpc, launch);
    assert.equal(launches.length, 1);
    // 3. 进程活着但心跳过期（卡住）：结束它并重新拉起
    const stuck = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    const exited = new Promise(resolve => stuck.on('exit', resolve));
    await writeFile(lock, JSON.stringify({ pid: stuck.pid, path: '/cloud/t.jsonl', token: 't', beatAt: Date.now() - 10 * 60_000 }));
    await notifyRequest({ tool_name: 'Bash', tool_use_id: 'toolu_r3', tool_input: {} }, e, rpc, launch);
    await exited;
    assert.equal(launches.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
