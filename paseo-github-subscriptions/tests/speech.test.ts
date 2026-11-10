import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GuardSpeech, type SpeechExecutor, type SpeechSynthesizeOptions, type SpeechSynthesizer } from '../server/speech.ts';

type SynthInput = SpeechSynthesizeOptions;

test('内置晓晓合成成功：提示音→内置合成→afplay 顺序执行且不调 Python；支持 ASKUSER_VOICE 与代理；冷却与去重保持不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-builtin-'));
  const execCalls: Array<{ executable: string; args: string[] }> = [];
  const synthCalls: SynthInput[] = [];
  const origVoice = process.env.ASKUSER_VOICE;
  const origHttpsProxy = process.env.https_proxy;
  let now = 1;

  const execute: SpeechExecutor = async (executable, args) => {
    execCalls.push({ executable, args });
  };
  const synthesizer = async (input: SynthInput) => {
    synthCalls.push(input);
    await writeFile(input.mediaPath, 'builtin-mp3-audio');
  };

  try {
    process.env.ASKUSER_VOICE = 'zh-CN-XiaoxiaoNeural';
    process.env.https_proxy = 'http://127.0.0.1:6152';

    const speech = new GuardSpeech(
      directory,
      execute,
      () => now,
      synthesizer,
    );
    const first = await speech.speak('one', '有一个问题等待确认');
    assert.equal(first.played, true);
    assert.equal(first.engine, 'neural');
    assert.match(first.detail ?? '', /晓晓语音合成（内置）成功/);
    assert.deepEqual(
      execCalls.map(call => call.executable),
      ['/usr/bin/afplay', '/usr/bin/afplay'],
      '内置合成成功时不应调用 python3 或 say',
    );
    assert.ok(execCalls[0].args.includes('/System/Library/Sounds/Glass.aiff'));
    assert.equal(synthCalls.length, 1);
    assert.equal(synthCalls[0].voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(synthCalls[0].proxy, 'http://127.0.0.1:6152');
    assert.equal(synthCalls[0].timeout, 25_000);

    // 冷却期内拒绝新提问，同 ID 跨重启去重
    assert.equal((await speech.speak('two', '下一个问题')).played, false);
    const restarted = new GuardSpeech(
      directory,
      execute,
      () => now,
      synthesizer,
    );
    assert.deepEqual(await restarted.speak('one', '有一个问题等待确认'), first);
    assert.equal(synthCalls.length, 1);
    now += 180_001;
    assert.equal((await restarted.speak('two', '下一个问题')).played, true);
    assert.deepEqual(await readdir(directory), ['plugin-speech.json']);
  } finally {
    if (origVoice === undefined) delete process.env.ASKUSER_VOICE;
    else process.env.ASKUSER_VOICE = origVoice;
    if (origHttpsProxy === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = origHttpsProxy;
    await rm(directory, { recursive: true, force: true });
  }
});

test('内置合成失败且存在 Python edge_tts 时自动回退 Python 合成（保持专用环境与显式解释器优先级）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-python-fallback-'));
  const installedPython = join(directory, 'speech-venv', 'bin', 'python3');
  const originalPython = process.env.ASKUSER_PYTHON;
  const interpreters: string[] = [];
  let now = 1000;
  const execute: SpeechExecutor = async (executable, args) => {
    if (!args.includes('--write-media')) return;
    interpreters.push(executable);
    await writeFile(args[args.indexOf('--write-media') + 1], 'python-mp3-audio');
  };
  const failingSynthesizer = async () => {
    throw new Error('network error');
  };
  try {
    await mkdir(dirname(installedPython), { recursive: true });
    await writeFile(installedPython, '', { mode: 0o700 });
    delete process.env.ASKUSER_PYTHON;
    const speech = new GuardSpeech(
      directory,
      execute,
      () => now,
      failingSynthesizer,
    );
    const res1 = await speech.speak('installed', '专用语音环境');
    assert.equal(res1.engine, 'neural');
    assert.match(res1.detail ?? '', /晓晓语音合成（内置）失败.*晓晓语音合成（Python）成功/);

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

test('内置与 Python 均失败（或无 Python edge_tts）时回退系统语音 say；全部失败不写成功记录且不泄露凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-failure-'));
  let failSystem = true;
  const execute: SpeechExecutor = async executable => {
    if (executable !== '/usr/bin/afplay' && (executable !== '/usr/bin/say' || failSystem)) {
      throw new Error('secret-proxy-password');
    }
  };
  const failingSynthesizer = async () => {
    throw new Error('secret-proxy-password');
  };
  try {
    const speech = new GuardSpeech(
      directory,
      execute,
      () => 1000,
      failingSynthesizer,
    );
    const failed = await speech.speak('one', '请确认');
    assert.equal(failed.played, false);
    assert.equal(failed.retryAt, 181000);
    assert.equal(JSON.stringify(failed).includes('secret-proxy-password'), false);
    assert.deepEqual(await readdir(directory), []);

    failSystem = false;
    const recovered = await speech.speak('one', '请确认');
    assert.equal(recovered.played, true);
    assert.equal(recovered.engine, 'system');
    assert.match(recovered.detail!, /晓晓语音合成（内置）失败.*系统语音回退成功/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('内置合成期间调用 cancel 或 stop 会通过 AbortSignal 立即中止网络合成并清理临时目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-cancel-synth-'));
  let synthStarted!: () => void;
  let entered = new Promise<void>(resolve => { synthStarted = resolve; });
  let abortedCount = 0;
  let blockSynth = true;
  let now = 1000;

  const execute: SpeechExecutor = async () => {};
  const synthesizer = async ({ mediaPath, signal }: SynthInput) => {
    if (!blockSynth) {
      await writeFile(mediaPath, 'audio');
      return;
    }
    synthStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          abortedCount++;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  };

  try {
    const speech = new GuardSpeech(
      directory,
      execute,
      () => now,
      synthesizer,
    );
    const playing = speech.speak('one', '请确认');
    await entered;
    assert.match((await speech.speak('two', '请确认')).detail!, /正在播放/);
    assert.equal(speech.cancel('other'), false);
    assert.equal(speech.cancel('one'), true);
    const cancelledRes = await playing;
    assert.deepEqual(cancelledRes, { played: false, cancelled: true, detail: '语音播放已取消' });
    assert.equal(abortedCount, 1, '取消应立即触发内置合成器的 AbortSignal');
    assert.deepEqual(await readdir(directory), []);
    assert.equal((await speech.speak('other', '请确认')).cancelled, true);

    // 取消不进入冷却，之后重播同一 ID 正常成功
    blockSynth = false;
    const replay = await speech.speak('one', '请确认');
    assert.equal(replay.played, true);
    assert.equal(replay.engine, 'neural');

    // 跳过冷却期后，stop() 同样中止在途内置合成
    now += 180_001;
    blockSynth = true;
    entered = new Promise<void>(resolve => { synthStarted = resolve; });
    const playing2 = speech.speak('stop-me', '请确认');
    await entered;
    speech.stop();
    assert.deepEqual(await playing2, { played: false, cancelled: true, detail: '语音播放已取消' });
    await assert.rejects(speech.speak('after-stop', '请确认'), /停止/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('临时文件清理失败不掩盖已成功播放的回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-cleanup-'));
  let locked = '';
  const execute: SpeechExecutor = async () => {};
  const synthesizer = async ({ mediaPath }: SynthInput) => {
    await writeFile(mediaPath, 'audio');
    locked = dirname(mediaPath);
    await chmod(locked, 0o500);
  };
  try {
    const speech = new GuardSpeech(
      directory,
      execute,
      () => 1000,
      synthesizer,
    );
    const result = await speech.speak('one', '请确认');
    assert.equal(result.played, true);
    assert.ok((await readdir(directory)).includes('plugin-speech.json'));
  } finally {
    if (locked) await chmod(locked, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
