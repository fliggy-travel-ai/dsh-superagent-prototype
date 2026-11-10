import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EdgeTTS } from 'node-edge-tts';
import { z } from 'zod';
import { SPEECH_COOLDOWN_MS, SpeechResultSchema, type SpeechResult } from '../shared/speech.ts';
import { atomicWrite } from './storage.ts';

const run = promisify(execFile);
export type SpeechExecutor = (executable: string, args: string[], options: { timeout: number; signal: AbortSignal }) => Promise<void>;
export interface SpeechSynthesizeOptions {
  text: string;
  voice: string;
  mediaPath: string;
  proxy?: string;
  timeout: number;
  signal: AbortSignal;
}
export type SpeechSynthesizer = (options: SpeechSynthesizeOptions) => Promise<void>;

const execute: SpeechExecutor = async (executable, args, options) => { await run(executable, args, { ...options, maxBuffer: 64 * 1024 }); };
const LedgerSchema = z.object({ lastPlayedAt: z.number(), receipts: z.array(z.object({ id: z.string(), result: SpeechResultSchema })) });

export async function synthesizeWithNodeEdgeTts(options: SpeechSynthesizeOptions): Promise<void> {
  const { text, voice, mediaPath, proxy, timeout, signal } = options;
  if (signal.aborted) throw new Error('语音播放已取消');
  const lang = /^[a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z]+)?/.exec(voice)?.[0] ?? 'zh-CN';
  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    proxy: proxy || undefined,
    timeout,
  });

  let activeWs = null as { terminate(): void } | null;
  const rawTts = tts as unknown as { _connectWebSocket?: () => Promise<{ terminate(): void }> };
  if (typeof rawTts._connectWebSocket === 'function') {
    const origConnect = rawTts._connectWebSocket.bind(tts);
    rawTts._connectWebSocket = async () => {
      const ws = await origConnect();
      activeWs = ws;
      if (signal.aborted) {
        try { ws.terminate(); } catch {}
        throw new Error('语音播放已取消');
      }
      return ws;
    };
  }

  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortOrTimeout = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try { activeWs?.terminate(); } catch {}
      reject(new Error('语音播放已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      try { activeWs?.terminate(); } catch {}
      reject(new Error('内置语音合成超时'));
    }, timeout);
  });
  void abortOrTimeout.catch(() => {});

  const handle = await open(mediaPath, 'w');
  const iterator = tts.streamAudio(text)[Symbol.asyncIterator]();
  try {
    while (true) {
      const stepPromise = iterator.next();
      void stepPromise.catch(() => {});
      const { value, done } = await Promise.race([stepPromise, abortOrTimeout]);
      if (done) break;
      if (Buffer.isBuffer(value)) {
        await handle.writeFile(value);
      }
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try { activeWs?.terminate(); } catch {}
    void iterator.return?.(undefined).catch(() => {});
    await handle.close().catch(() => {});
  }
}

export class GuardSpeech {
  private directory: string;
  private execute: SpeechExecutor;
  private clock: () => number;
  private synthesize: SpeechSynthesizer;
  private active: { id: string; controller: AbortController } | null = null;
  private cancelled = new Map<string, number>();
  private stopped = false;
  private ledger = LedgerSchema.parse({ lastPlayedAt: 0, receipts: [] });
  private loaded = false;
  constructor(
    directory = join(homedir(), '.claude-guard'),
    executor = execute,
    clock = Date.now,
    synthesizer: SpeechSynthesizer = synthesizeWithNodeEdgeTts,
  ) {
    this.directory = directory;
    this.execute = executor;
    this.clock = clock;
    this.synthesize = synthesizer;
  }
  async speak(id: string, text: string): Promise<SpeechResult> {
    if (!id || id.length > 200 || !text.trim() || text.length > 500 || text.includes('\0')) throw new Error('语音提醒文本无效');
    if (this.stopped) throw new Error('语音服务已停止');
    const cancelledAt = this.cancelled.get(id);
    this.cancelled.delete(id);
    if (cancelledAt !== undefined && this.clock() - cancelledAt < 15_000) return { played: false, cancelled: true, detail: '语音播放已取消' };
    if (this.active) return { played: false, detail: '正在播放其他提醒，稍后重试', retryAt: this.clock() + 5000 };
    const controller = new AbortController(); this.active = { id, controller };
    let temporary: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!this.loaded) {
        try { this.ledger = LedgerSchema.parse(JSON.parse(await readFile(join(this.directory, 'plugin-speech.json'), 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('语音播放记录读取失败'); }
        this.loaded = true;
      }
      const previous = this.ledger.receipts.find(receipt => receipt.id === id);
      if (previous) return previous.result;
      const retryAt = this.ledger.lastPlayedAt + SPEECH_COOLDOWN_MS;
      if (this.ledger.receipts.length && this.clock() < retryAt) return { played: false, detail: '提醒冷却中，稍后播放', retryAt };
      const details: string[] = [];
      const step = async (name: string, executable: string, args: string[], timeout: number) => {
        if (controller.signal.aborted) throw new Error('语音播放已取消');
        try { await this.execute(executable, args, { timeout, signal: controller.signal }); details.push(`${name}成功`); return true; }
        catch { if (controller.signal.aborted) throw new Error('语音播放已取消'); details.push(`${name}失败`); return false; }
      };
      await step('提示音', '/usr/bin/afplay', ['-v', '3', '/System/Library/Sounds/Glass.aiff'], 5000);
      temporary = await mkdtemp(join(this.directory, 'voice-'));
      const media = join(temporary, 'notification.mp3');
      const voice = process.env.ASKUSER_VOICE || 'zh-CN-XiaoxiaoNeural';
      const proxy = process.env.https_proxy || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      const checkUsable = () => stat(media).then(file => file.size > 0 && file.size < 10 * 1024 * 1024, () => false);

      if (controller.signal.aborted) throw new Error('语音播放已取消');
      let usable = false;
      try {
        await this.synthesize({ text, voice, mediaPath: media, proxy, timeout: 25_000, signal: controller.signal });
        usable = await checkUsable();
        details.push(usable ? '晓晓语音合成（内置）成功' : '晓晓语音合成（内置）失败');
      } catch {
        if (controller.signal.aborted) throw new Error('语音播放已取消');
        details.push('晓晓语音合成（内置）失败');
      }

      if (!usable) {
        if (controller.signal.aborted) throw new Error('语音播放已取消');
        const installedPython = join(this.directory, 'speech-venv', 'bin', 'python3');
        const python = process.env.ASKUSER_PYTHON || await access(installedPython, constants.X_OK).then(() => installedPython, () => 'python3');
        const hasPythonEdgeTts = await this.execute(python, ['-c', 'import edge_tts'], { timeout: 3000, signal: controller.signal }).then(
          () => true,
          () => {
            if (controller.signal.aborted) throw new Error('语音播放已取消');
            return false;
          },
        );
        if (hasPythonEdgeTts) {
          await rm(media, { force: true }).catch(() => {});
          const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', media];
          if (proxy) args.push('--proxy', proxy);
          const generated = await step('晓晓语音合成（Python）', python, args, 25_000);
          usable = generated && await checkUsable();
        }
      }

      let played = usable && await step('神经语音播放', '/usr/bin/afplay', ['-v', '3', media], 30_000);
      let engine: 'neural' | 'system' = 'neural';
      if (!played) { engine = 'system'; played = await step('系统语音回退', '/usr/bin/say', ['-v', 'Flo', '--rate', '200', '--', text], 30_000); }
      const result: SpeechResult = { played, engine, detail: details.join('；'), ...(!played ? { retryAt: this.clock() + SPEECH_COOLDOWN_MS } : {}) };
      if (played) {
        this.ledger.lastPlayedAt = this.clock();
        this.ledger.receipts.push({ id, result });
        this.ledger.receipts = this.ledger.receipts.slice(-2000);
        await atomicWrite(join(this.directory, 'plugin-speech.json'), JSON.stringify(this.ledger)).catch(() => { result.detail = `${result.detail}；去重记录保存失败，重启后可能再次提醒`; });
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) return { played: false, cancelled: true, detail: '语音播放已取消' };
      throw error;
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
      this.active = null;
    }
  }
  cancel(id: string) {
    if (this.active?.id === id) { this.active.controller.abort(); return true; }
    const now = this.clock();
    for (const [key, at] of this.cancelled) if (now - at >= 15_000) this.cancelled.delete(key);
    if (this.cancelled.size < 100) this.cancelled.set(id, now);
    return false;
  }
  stop() { this.stopped = true; this.active?.controller.abort(); }
}
