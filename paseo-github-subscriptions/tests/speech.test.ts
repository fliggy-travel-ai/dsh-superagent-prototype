import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as speechMod from '../server/speech.ts';
import { GuardSpeech, synthesizeWithNodeEdgeTts, type SpeechExecutor, type SpeechSynthesizeOptions } from '../server/speech.ts';

type SynthInput = SpeechSynthesizeOptions;

test('内置晓晓合成成功：提示音→内置合成→afplay 顺序执行且不调 Python；各步超时上限总和低于 90 秒；冷却与去重保持不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-builtin-'));
  const execCalls: Array<{ executable: string; args: string[]; timeout: number }> = [];
  const synthCalls: SynthInput[] = [];
  const origVoice = process.env.ASKUSER_VOICE;
  const origHttpsProxy = process.env.https_proxy;
  let now = 1;

  const execute: SpeechExecutor = async (executable, args, options) => {
    execCalls.push({ executable, args, timeout: options.timeout });
  };
  const synthesizer = async (input: SynthInput) => {
    synthCalls.push(input);
    await writeFile(input.mediaPath, 'builtin-mp3-audio');
  };

  try {
    process.env.ASKUSER_VOICE = 'zh-CN-XiaoxiaoNeural';
    process.env.https_proxy = 'http://127.0.0.1:6152';

    const speech = new GuardSpeech(directory, execute, () => now, synthesizer);
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
    assert.equal(synthCalls[0].timeout, 15_000, '内置合成单步超时应控制在 15 秒以内');

    const timeouts = (speechMod as unknown as { SPEECH_STEP_TIMEOUTS?: Record<string, number> }).SPEECH_STEP_TIMEOUTS;
    assert.ok(timeouts, '应导出 SPEECH_STEP_TIMEOUTS 明确约束各步超时');
    const worstCaseMs = Object.values(timeouts).reduce((sum, ms) => sum + ms, 0);
    assert.ok(worstCaseMs < 90_000, `各步最坏超时总和（${worstCaseMs}ms）必须低于 90 秒（小于 presence.speak 的 100 秒限制）`);

    // 冷却期内拒绝新提问，同 ID 跨重启去重
    assert.equal((await speech.speak('two', '下一个问题')).played, false);
    const restarted = new GuardSpeech(directory, execute, () => now, synthesizer);
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

test('审阅项 1 & 2：open() 失败时清理计时器与取消监听；voiceLang 从音色名正确提取 zh-CN 而非整串音色名', async () => {
  const voiceLang = (speechMod as unknown as { voiceLang?: (v: string) => string }).voiceLang;
  assert.equal(typeof voiceLang, 'function', '应导出 voiceLang 供校验语言代码提取');
  assert.equal(voiceLang!('zh-CN-XiaoxiaoNeural'), 'zh-CN');
  assert.equal(voiceLang!('en-US-AriaNeural'), 'en-US');
  assert.equal(voiceLang!('fil-PH-BlessicaNeural'), 'fil-PH');

  const dir = await mkdtemp(join(tmpdir(), 'speech-open-err-'));
  try {
    const ac = new AbortController();
    // 传入目录路径使 open(dir, 'w') 立即抛 EISDIR，验证不会残留 abort 监听器或长定时器
    await assert.rejects(
      synthesizeWithNodeEdgeTts({
        text: '测试打开文件失败',
        voice: 'zh-CN-XiaoxiaoNeural',
        mediaPath: dir,
        timeout: 60_000,
        signal: ac.signal,
      }),
    );
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'open() 失败后不得在 AbortSignal 上残留监听器');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('审阅项 4：仅在存在 speech-venv/bin/python3 或设置 ASKUSER_PYTHON 时尝试 Python 回退，绝不调用系统默认 python3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-python-fallback-'));
  const installedPython = join(directory, 'speech-venv', 'bin', 'python3');
  const originalPython = process.env.ASKUSER_PYTHON;
  const interpreters: string[] = [];
  const pythonTimeouts: number[] = [];
  let now = 1000;
  const execute: SpeechExecutor = async (executable, args, options) => {
    if (executable.includes('python')) {
      interpreters.push(executable);
      if (args.includes('--write-media')) {
        pythonTimeouts.push(options.timeout);
        await writeFile(args[args.indexOf('--write-media') + 1], 'python-mp3-audio');
      }
      return;
    }
  };
  const failingSynthesizer = async () => {
    throw new Error('Timed out waiting for Edge TTS');
  };
  try {
    await mkdir(dirname(installedPython), { recursive: true });
    await writeFile(installedPython, '', { mode: 0o700 });
    delete process.env.ASKUSER_PYTHON;
    const speech = new GuardSpeech(directory, execute, () => now, failingSynthesizer);

    // 1. speech-venv 存在且可执行：回退到 installedPython，且内置失败写明“超时”
    const res1 = await speech.speak('installed', '专用语音环境');
    assert.equal(res1.engine, 'neural');
    assert.match(res1.detail ?? '', /晓晓语音合成（内置）失败：超时.*晓晓语音合成（Python）成功/);
    assert.equal(pythonTimeouts[0], 15_000);

    // 2. 显式设置 ASKUSER_PYTHON：优先使用显式解释器
    process.env.ASKUSER_PYTHON = '/configured/python3';
    now += 180_001;
    assert.equal((await speech.speak('configured', '指定语音环境')).engine, 'neural');

    // 3. 既无 ASKUSER_PYTHON，speech-venv 也不可执行：绝不调用系统 'python3'，直接回退 say
    delete process.env.ASKUSER_PYTHON;
    await chmod(installedPython, 0o600);
    interpreters.length = 0;
    now += 180_001;
    const res3 = await speech.speak('no-system-python', '无专用环境时不碰系统 python3');
    assert.equal(res3.engine, 'system');
    assert.deepEqual(interpreters, [], '没有 speech-venv 且未配置 ASKUSER_PYTHON 时不得调用系统 python3');
  } finally {
    if (originalPython === undefined) delete process.env.ASKUSER_PYTHON;
    else process.env.ASKUSER_PYTHON = originalPython;
    await rm(directory, { recursive: true, force: true });
  }
});

test('审阅项 5：合成失败说明包含简短原因（超时/网络失败），全部失败不写成功记录且绝不泄露原始凭据错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-failure-'));
  const origPython = process.env.ASKUSER_PYTHON;
  let failSystem = true;
  const execute: SpeechExecutor = async executable => {
    if (executable !== '/usr/bin/afplay' && (executable !== '/usr/bin/say' || failSystem)) {
      throw new Error('http://user:secret-proxy-password@127.0.0.1:6152 connection refused');
    }
  };
  const failingSynthesizer = async () => {
    throw new Error('http://user:secret-proxy-password@127.0.0.1:6152 ECONNREFUSED');
  };
  try {
    delete process.env.ASKUSER_PYTHON;
    const speech = new GuardSpeech(directory, execute, () => 1000, failingSynthesizer);
    const failed = await speech.speak('one', '请确认');
    assert.equal(failed.played, false);
    assert.equal(failed.retryAt, 181000);
    assert.equal(JSON.stringify(failed).includes('secret-proxy-password'), false);
    assert.match(failed.detail!, /晓晓语音合成（内置）失败：网络失败/);
    assert.deepEqual(await readdir(directory), []);

    failSystem = false;
    const recovered = await speech.speak('one', '请确认');
    assert.equal(recovered.played, true);
    assert.equal(recovered.engine, 'system');
    assert.match(recovered.detail!, /晓晓语音合成（内置）失败：网络失败.*系统语音回退成功/);
  } finally {
    if (origPython === undefined) delete process.env.ASKUSER_PYTHON;
    else process.env.ASKUSER_PYTHON = origPython;
    await rm(directory, { recursive: true, force: true });
  }
});

test('内置合成取消后立即返回且不播放；传输阶段立即断开，握手阶段在握手完成后断开', async () => {
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
    const speech = new GuardSpeech(directory, execute, () => now, synthesizer);
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

    // 跳过冷却期后，stop() 同样触发取消并立即返回
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
    const speech = new GuardSpeech(directory, execute, () => 1000, synthesizer);
    const result = await speech.speak('one', '请确认');
    assert.equal(result.played, true);
    assert.ok((await readdir(directory)).includes('plugin-speech.json'));
  } finally {
    if (locked) await chmod(locked, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
