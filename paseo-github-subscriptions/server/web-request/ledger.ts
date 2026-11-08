import { createHash } from 'node:crypto';
import type { WebRequestAnswerSummary, WebRequestSource } from '../../shared/web-request.ts';

const MAX_ENTRIES = 500;
const TTL_MS = 10 * 60_000;

export function summarizeWebAnswer(
  input:
    | { kind: 'question'; answers: Record<string, string[]>; otherAnswers?: Record<string, string> }
    | { kind: 'tool'; decision: 'allow' | 'deny' },
): WebRequestAnswerSummary {
  if (input.kind === 'tool') {
    const digest = createHash('sha256')
      .update(JSON.stringify({ kind: 'tool', decision: input.decision }))
      .digest('hex');
    return { digest, decision: input.decision };
  }
  const sortedAnswers: Array<[string, string[]]> = Object.keys(input.answers)
    .sort()
    .map(question => [question, [...(input.answers[question] ?? [])]]);
  const sortedOther: Array<[string, { length: number; sha256: string }]> = Object.keys(input.otherAnswers ?? {})
    .sort()
    .flatMap(question => {
      const text = input.otherAnswers?.[question]?.trim();
      if (!text) return [];
      const sha256 = createHash('sha256').update(text).digest('hex');
      return [[question, { length: text.length, sha256 }]];
    });
  const digest = createHash('sha256')
    .update(JSON.stringify({
      kind: 'question',
      answers: sortedAnswers,
      other: sortedOther,
    }))
    .digest('hex');
  return {
    digest,
    answers: Object.fromEntries(sortedAnswers),
    ...(sortedOther.length ? { other: Object.fromEntries(sortedOther) } : {}),
  };
}

export class WebRequestLedger {
  private entries = new Map<string, { source: 'user' | 'automatic'; at: number }>();
  private clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= TTL_MS) this.entries.delete(key);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private makeKey(webSessionId: string, toolUseId: string, digest: string): string {
    return `${webSessionId}:${toolUseId}:${digest}`;
  }

  record(input: {
    webSessionId: string;
    toolUseId: string;
    answers: Record<string, string[]>;
    otherAnswers?: Record<string, string>;
    source: 'user' | 'automatic';
  }): string {
    const now = this.clock();
    this.prune(now);
    const { digest } = summarizeWebAnswer({
      kind: 'question',
      answers: input.answers,
      ...(input.otherAnswers ? { otherAnswers: input.otherAnswers } : {}),
    });
    const key = this.makeKey(input.webSessionId, input.toolUseId, digest);
    this.entries.delete(key);
    this.entries.set(key, { source: input.source, at: now });
    this.prune(now);
    return digest;
  }

  lookup(input: { webSessionId: string; toolUseId: string; digest: string }): WebRequestSource {
    const now = this.clock();
    this.prune(now);
    const key = this.makeKey(input.webSessionId, input.toolUseId, input.digest);
    return this.entries.get(key)?.source ?? 'paseo';
  }
}
