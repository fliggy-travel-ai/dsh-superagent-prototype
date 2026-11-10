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
