// 上游 node-edge-tts/dist/edge-tts.d.ts 顶层含 `/// <reference types="node" />` 与 `import { WebSocket } from 'ws'`，
// 会改变本工程 @types/node 与 react-native 全局类型合并顺序并缺少 @types/ws；用本声明文件隔离上游全局副作用。
export interface EdgeTTSSubtitleCue {
  part: string;
  start: number;
  end: number;
}

export interface EdgeTTSOptions {
  voice?: string;
  lang?: string;
  outputFormat?: string;
  saveSubtitles?: boolean;
  proxy?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  timeout?: number;
}

export declare class EdgeTTS {
  constructor(options?: EdgeTTSOptions);
  ttsPromise(text: string, audioPath: string): Promise<void>;
  streamAudio(text: string): AsyncGenerator<Buffer | EdgeTTSSubtitleCue>;
}
