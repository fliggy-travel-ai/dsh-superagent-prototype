import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GuardSpeech, type SpeechExecutor } from '../server/speech.ts';

test('晓晓合成、提示音和播放按顺序执行；冷却与成功回执跨重启去重', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-'));
  const calls: Array<{ executable: string; args: string[] }> = [];
  let now = 1;
  const execute: SpeechExecutor = async (executable, args) => {
    calls.push({ executable, args });
    if (args.includes('--write-media')) await writeFile(args[args.indexOf('--write-media') + 1], 'audio');
  };
  try {
    const speech = new GuardSpeech(directory, execute, () => now);
    const first = await speech.speak('one', '有一个问题等待确认');
    assert.equal(first.played, true); assert.equal(first.engine, 'neural');
    assert.deepEqual(calls.map(call => call.executable), ['/usr/bin/afplay', process.env.ASKUSER_PYTHON || 'python3', '/usr/bin/afplay']);
    assert.ok(calls[0].args.includes('/System/Library/Sounds/Glass.aiff'));
    assert.ok(calls[1].args.includes(process.env.ASKUSER_VOICE || 'zh-CN-XiaoxiaoNeural'));
    assert.equal((await speech.speak('two', '下一个问题')).played, false);
    const restarted = new GuardSpeech(directory, execute, () => now);
    assert.deepEqual(await restarted.speak('one', '有一个问题等待确认'), first);
    assert.equal(calls.length, 3);
    now += 180_001;
    assert.equal((await restarted.speak('two', '下一个问题')).played, true);
    assert.deepEqual(await readdir(directory), ['plugin-speech.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('优先使用可执行的专用语音环境；显式解释器优先；专用环境不可执行时回退 PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-python-'));
  const installedPython = join(directory, 'speech-venv', 'bin', 'python3');
  const originalPython = process.env.ASKUSER_PYTHON;
  const interpreters: string[] = [];
  let now = 1000;
  const execute: SpeechExecutor = async (executable, args) => {
    if (!args.includes('--write-media')) return;
    interpreters.push(executable);
    await writeFile(args[args.indexOf('--write-media') + 1], 'audio');
  };
  try {
    await mkdir(dirname(installedPython), { recursive: true });
    await writeFile(installedPython, '', { mode: 0o700 });
    delete process.env.ASKUSER_PYTHON;
    const speech = new GuardSpeech(directory, execute, () => now);
    assert.equal((await speech.speak('installed', '专用语音环境')).engine, 'neural');
    process.env.ASKUSER_PYTHON = '/configured/python3';
    now += 180_001;
    assert.equal((await speech.speak('configured', '指定语音环境')).engine, 'neural');
    delete process.env.ASKUSER_PYTHON;
    await chmod(installedPython, 0o600);
    now += 180_001;
    assert.equal((await speech.speak('fallback', '默认语音环境')).engine, 'neural');
    assert.deepEqual(interpreters, [installedPython, '/configured/python3', 'python3']);
  } finally {
    if (originalPython === undefined) delete process.env.ASKUSER_PYTHON;
    else process.env.ASKUSER_PYTHON = originalPython;
    await rm(directory, { recursive: true, force: true });
  }
});

test('合成失败回退系统语音；全部失败不占用成功记录且不泄露执行错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-failure-'));
  let failSystem = true;
  const execute: SpeechExecutor = async (executable) => {
    if (executable !== '/usr/bin/afplay' && (executable !== '/usr/bin/say' || failSystem)) throw new Error('secret-proxy-password');
  };
  try {
    const speech = new GuardSpeech(directory, execute, () => 1000);
    const failed = await speech.speak('one', '请确认');
    assert.equal(failed.played, false); assert.equal(failed.retryAt, 181000);
    assert.equal(JSON.stringify(failed).includes('secret-proxy-password'), false);
    assert.deepEqual(await readdir(directory), []);
    failSystem = false;
    const recovered = await speech.speak('one', '请确认');
    assert.equal(recovered.played, true); assert.equal(recovered.engine, 'system');
    assert.match(recovered.detail!, /合成失败.*回退成功/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('播放单飞；停止会取消子进程且不会生成成功回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-cancel-'));
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const execute: SpeechExecutor = async (_executable, _args, { signal }) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  try {
    const speech = new GuardSpeech(directory, execute);
    const playing = speech.speak('one', '请确认');
    await entered;
    assert.match((await speech.speak('two', '请确认')).detail!, /正在播放/);
    speech.stop();
    assert.deepEqual(await playing, { played: false, cancelled: true, detail: '语音播放已取消' });
    await assert.rejects(speech.speak('three', '请确认'), /停止/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('只取消匹配编号的语音；取消不写成功记录也不进入冷却；提前到达的取消同样生效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-match-'));
  let started!: () => void;
  let entered = new Promise<void>(resolve => { started = resolve; });
  let block = true;
  const execute: SpeechExecutor = async (_executable, args, { signal }) => {
    if (args.includes('--write-media')) await writeFile(args[args.indexOf('--write-media') + 1], 'audio');
    if (!block) return;
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  try {
    const speech = new GuardSpeech(directory, execute, () => 1000);
    const playing = speech.speak('one', '请确认');
    await entered;
    assert.equal(speech.cancel('other'), false);
    assert.equal(speech.cancel('one'), true);
    assert.equal((await playing).cancelled, true);
    assert.deepEqual(await readdir(directory), []);
    assert.equal((await speech.speak('other', '请确认')).cancelled, true);
    block = false;
    entered = new Promise<void>(resolve => { started = resolve; });
    const replay = await speech.speak('one', '请确认');
    assert.equal(replay.played, true);
    assert.equal(replay.cancelled, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('临时文件清理失败不掩盖已成功播放的回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-cleanup-'));
  let locked = '';
  const execute: SpeechExecutor = async (_executable, args) => {
    if (!args.includes('--write-media')) return;
    const media = args[args.indexOf('--write-media') + 1];
    await writeFile(media, 'audio');
    locked = dirname(media);
    await chmod(locked, 0o500);
  };
  try {
    const result = await new GuardSpeech(directory, execute, () => 1000).speak('one', '请确认');
    assert.equal(result.played, true);
    assert.ok((await readdir(directory)).includes('plugin-speech.json'));
  } finally { if (locked) await chmod(locked, 0o700).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
