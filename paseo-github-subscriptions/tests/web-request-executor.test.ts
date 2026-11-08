import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebRequestExecutor, type WebRequestBridgePort, type WebRequestCandidate, type WebRequestRuntimePort } from '../server/web-request/executor.ts';
import { WebRequestLedger } from '../server/web-request/ledger.ts';
import type { WebRequestAnswer } from '../shared/web-request.ts';
import type { BrowserQuestion, Question } from '../shared/presence.ts';

function sampleExpected() {
  return {
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          multiSelect: false,
          options: [
            { label: 'Staging', description: 'Safe' },
            { label: 'Prod', description: 'Live' },
          ],
        },
      ],
    },
  };
}

function sampleBrowserQuestion(overrides: Partial<BrowserQuestion> = {}): BrowserQuestion {
  return {
    id: 'bq-1',
    sessionId: 'abc123',
    fingerprint: 'fp-1',
    toolUseId: 'toolu_01',
    prompts: [
      {
        question: 'Which environment?',
        header: 'Env',
        multiSelect: false,
        allowOther: true,
        options: [
          { label: 'Staging', description: 'Safe', recommended: true },
          { label: 'Prod', description: 'Live', recommended: false },
        ],
      },
    ],
    ...overrides,
  };
}

function createFakeEnv() {
  let now = 1_700_000_000_000;
  let sessions: Array<{ instanceId: string; sessionId?: string; lastSeenAt: number }> = [
    { instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: now - 1_000 },
  ];
  let candidates: WebRequestCandidate[] = [];
  let observedSessions = new Set<string>(['inst-1:abc123']);
  const states = new Map<string, {
    state: Question['state'];
    queued: boolean;
    claimedAt?: string;
    browserSubmittedAt?: string;
  }>();
  const delegatedCalls: Array<{
    id: string;
    answers: Record<string, string[]>;
    otherAnswers?: Record<string, string>;
    source?: 'automatic' | 'manual';
  }> = [];
  const cancelledIds: string[] = [];
  let onSleep: ((ms: number, currentNow: number) => void) | null = null;

  const bridge: WebRequestBridgePort = {
    sessions: () => sessions,
  };

  const runtime: WebRequestRuntimePort = {
    browserCandidates: (instanceId, sessionId) =>
      candidates.filter(c => c.question.sessionId === sessionId && instanceId === 'inst-1'),
    isSessionObserved: (instanceId, sessionId) => observedSessions.has(`${instanceId}:${sessionId}`),
    delegateBrowserAnswer: (id, answers, otherAnswers, source) => {
      delegatedCalls.push({ id, answers, otherAnswers, source });
      const st = states.get(id);
      if (!st || st.state !== 'pending') return false;
      st.queued = true;
      return true;
    },
    cancelBrowserDecision: id => {
      cancelledIds.push(id);
      const st = states.get(id);
      if (st) st.queued = false;
    },
    browserState: id => states.get(id) ?? null,
  };

  return {
    get now() { return now; },
    set now(value: number) { now = value; },
    setSessions(next: Array<{ instanceId: string; sessionId?: string; lastSeenAt: number }>) { sessions = next; },
    setCandidates(next: WebRequestCandidate[]) {
      candidates = next;
      for (const item of next) {
        if (!states.has(item.id)) {
          states.set(item.id, { state: item.state, queued: false });
        }
      }
    },
    setObserved(keys: string[]) { observedSessions = new Set(keys); },
    states,
    delegatedCalls,
    cancelledIds,
    setOnSleep(fn: ((ms: number, currentNow: number) => void) | null) { onSleep = fn; },
    bridge,
    runtime,
    options: {
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
        onSleep?.(ms, now);
      },
    },
  };
}

test('入参校验、前缀转换、tool_in_browser 与 unsupported_tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-basic-'));
  try {
    const env = createFakeEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);

    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'bad_prefix',
        toolUseId: 'toolu_01',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Staging'] },
      }),
      { status: 'unknown', detail: 'invalid_answer' },
    );

    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_perm_1',
        expected: { toolName: 'Bash', input: { command: 'ls' } },
        kind: 'tool',
        decision: 'allow',
      }),
      { status: 'unknown', detail: 'tool_in_browser' },
    );

    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_plan_1',
        expected: { toolName: 'ExitPlanMode', input: {} },
        kind: 'question',
        answers: {},
      }),
      { status: 'unknown', detail: 'unsupported_tool' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同键同答案只转交一次，原请求或答案（含其他文本）变化时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-dedup-'));
  try {
    const env = createFakeEnv();
    env.setCandidates([{
      id: 'browser:inst-1:abc123:bq-1',
      question: sampleBrowserQuestion(),
      seen: env.now,
      state: 'pending',
    }]);
    env.setOnSleep(() => {
      const st = env.states.get('browser:inst-1:abc123:bq-1')!;
      st.state = 'submitted';
      st.browserSubmittedAt = new Date(env.now).toISOString();
    });
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);

    const request: WebRequestAnswer = {
      webSessionId: 'session_abc123',
      toolUseId: 'toolu_01',
      expected: sampleExpected(),
      kind: 'question',
      answers: { 'Which environment?': [] },
      otherAnswers: { 'Which environment?': 'Custom Box A' },
    };

    const [first, second] = await Promise.all([
      executor.answerWebRequest(request),
      executor.answerWebRequest(request),
    ]);
    assert.deepEqual(first, { status: 'submitted' });
    assert.deepEqual(second, { status: 'submitted' });
    assert.equal(env.delegatedCalls.length, 1);

    const changedOther = await executor.answerWebRequest({
      ...request,
      otherAnswers: { 'Which environment?': 'Custom Box B' },
    });
    assert.deepEqual(changedOther, { status: 'unknown', detail: 'answer_changed' });

    const changedAnswer = await executor.answerWebRequest({
      ...request,
      answers: { 'Which environment?': ['Staging'] },
      otherAnswers: undefined,
    });
    assert.deepEqual(changedAnswer, { status: 'unknown', detail: 'answer_changed' });

    const changedExpected = await executor.answerWebRequest({
      ...request,
      expected: { toolName: 'AskUserQuestion', input: { questions: [] } },
    });
    assert.deepEqual(changedExpected, { status: 'unknown', detail: 'request_changed' });
    assert.equal(env.delegatedCalls.length, 1);

    // 超过 10 分钟后 dedup 过期清理，新答案不再报 answer_changed
    env.now += 10 * 60_000;
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.states.set('browser:inst-1:abc123:bq-1', { state: 'pending', queued: false });
    env.setCandidates([{
      id: 'browser:inst-1:abc123:bq-1',
      question: sampleBrowserQuestion(),
      seen: env.now,
      state: 'pending',
    }]);
    const afterTtl = await executor.answerWebRequest({
      ...request,
      answers: { 'Which environment?': ['Staging'] },
      otherAnswers: undefined,
    });
    assert.deepEqual(afterTtl, { status: 'submitted' });
    assert.equal(env.delegatedCalls.length, 2);

    // 超过 500 条时淘汰最早的 dedup 记录
    for (let i = 0; i < 501; i++) {
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: `toolu_cap_${i}`,
        expected: { toolName: 'Bash', input: { i } },
        kind: 'tool',
        decision: 'allow',
      });
    }
    // toolu_cap_0 已被淘汰，换 decision 不会报 answer_changed；toolu_cap_500 仍在去重表内，换 decision 报 answer_changed
    const evictedRes = await executor.answerWebRequest({
      webSessionId: 'session_abc123',
      toolUseId: 'toolu_cap_0',
      expected: { toolName: 'Bash', input: { i: 0 } },
      kind: 'tool',
      decision: 'deny',
    });
    assert.deepEqual(evictedRes, { status: 'unknown', detail: 'tool_in_browser' });
    const retainedRes = await executor.answerWebRequest({
      webSessionId: 'session_abc123',
      toolUseId: 'toolu_cap_500',
      expected: { toolName: 'Bash', input: { i: 500 } },
      kind: 'tool',
      decision: 'deny',
    });
    assert.deepEqual(retainedRes, { status: 'unknown', detail: 'answer_changed' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('浏览器环境四种判定：未连接、不新鲜、未打开、多个环境', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-env-'));
  try {
    const env = createFakeEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);
    const makeReq = (toolUseId: string): WebRequestAnswer => ({
      webSessionId: 'session_abc123',
      toolUseId,
      expected: sampleExpected(),
      kind: 'question',
      answers: { 'Which environment?': ['Staging'] },
    });

    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now - 160_000 }]);
    assert.deepEqual(await executor.answerWebRequest(makeReq('t1')), {
      status: 'unknown',
      detail: 'bridge_not_connected',
    });

    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now - 90_000 }]);
    assert.deepEqual(await executor.answerWebRequest(makeReq('t2')), {
      status: 'unknown',
      detail: 'scan_stale',
    });

    env.setSessions([{ instanceId: 'inst-1', sessionId: 'other_session', lastSeenAt: env.now - 5_000 }]);
    assert.deepEqual(await executor.answerWebRequest(makeReq('t3')), {
      status: 'page_not_open',
    });

    env.setSessions([
      { instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now - 5_000 },
      { instanceId: 'inst-2', sessionId: 'abc123', lastSeenAt: env.now - 5_000 },
    ]);
    assert.deepEqual(await executor.answerWebRequest(makeReq('t4')), {
      status: 'unknown',
      detail: 'multiple_instances',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('网页提问候选判定：找不到、扫描不完整、多个候选、other_not_on_page 与 10 秒内后到提问', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-candidates-'));
  try {
    const env = createFakeEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);

    // 1. 扫描完整但找不到 -> not_found
    env.setCandidates([]);
    env.setObserved(['inst-1:abc123']);
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_nf',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Staging'] },
      }),
      { status: 'unknown', detail: 'not_found' },
    );

    // 2. 扫描不完整且找不到 -> scan_incomplete
    env.setObserved([]);
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_si',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Staging'] },
      }),
      { status: 'unknown', detail: 'scan_incomplete' },
    );

    // 3. 多个候选 -> multiple_candidates
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.setCandidates([
      {
        id: 'browser:inst-1:abc123:bq-a',
        question: sampleBrowserQuestion({ id: 'bq-a', toolUseId: undefined }),
        seen: env.now,
        state: 'pending',
      },
      {
        id: 'browser:inst-1:abc123:bq-b',
        question: sampleBrowserQuestion({ id: 'bq-b', toolUseId: undefined }),
        seen: env.now,
        state: 'pending',
      },
    ]);
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_mc',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Staging'] },
      }),
      { status: 'unknown', detail: 'multiple_candidates' },
    );

    // 4. 页面提问不支持 allowOther 但答案含 otherAnswers -> other_not_on_page
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.setCandidates([
      {
        id: 'browser:inst-1:abc123:bq-no-other',
        question: sampleBrowserQuestion({
          id: 'bq-no-other',
          toolUseId: 'toolu_no_other',
          prompts: [
            {
              question: 'Which environment?',
              header: 'Env',
              multiSelect: false,
              allowOther: false,
              options: [
                { label: 'Staging', description: 'Safe', recommended: true },
                { label: 'Prod', description: 'Live', recommended: false },
              ],
            },
          ],
        }),
        seen: env.now,
        state: 'pending',
      },
    ]);
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_no_other',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': [] },
        otherAnswers: { 'Which environment?': 'My custom env' },
      }),
      { status: 'unknown', detail: 'other_not_on_page' },
    );

    // 5. 10 秒内后到的网页提问成功匹配并提交
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.setCandidates([]);
    const startWait = env.now;
    env.setOnSleep((_ms, currentNow) => {
      env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: currentNow }]);
      if (currentNow - startWait === 2_000) {
        env.setCandidates([
          {
            id: 'browser:inst-1:abc123:bq-late-arrival',
            question: sampleBrowserQuestion({ id: 'bq-late-arrival', toolUseId: 'toolu_arrive' }),
            seen: currentNow,
            state: 'pending',
          },
        ]);
      } else if (currentNow - startWait >= 2_500) {
        const st = env.states.get('browser:inst-1:abc123:bq-late-arrival');
        if (st) {
          st.state = 'submitted';
          st.browserSubmittedAt = new Date(currentNow).toISOString();
        }
      }
    });
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_arrive',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Prod'] },
      }),
      { status: 'submitted' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('20 秒未领取撤销、15 秒无回执与迟到回执只写审计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-timeouts-'));
  try {
    const env = createFakeEnv();
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, undefined, env.options);

    // 1. 20 秒未领取撤销 decision 并返回 not_claimed
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.setCandidates([
      {
        id: 'browser:inst-1:abc123:bq-unclaimed',
        question: sampleBrowserQuestion({ id: 'bq-unclaimed', toolUseId: 'toolu_unclaimed' }),
        seen: env.now,
        state: 'pending',
      },
    ]);
    env.setOnSleep((_ms, currentNow) => {
      env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: currentNow }]);
    });
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_unclaimed',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Staging'] },
      }),
      { status: 'unknown', detail: 'not_claimed' },
    );
    assert.deepEqual(env.cancelledIds, ['browser:inst-1:abc123:bq-unclaimed']);

    // 2. 领取后 15 秒无回执返回 no_receipt，之后回执迟到更新审计为 lateReceipt: true
    const candId = 'browser:inst-1:abc123:bq-noreceipt';
    env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
    env.setCandidates([
      {
        id: candId,
        question: sampleBrowserQuestion({ id: 'bq-noreceipt', toolUseId: 'toolu_noreceipt' }),
        seen: env.now,
        state: 'pending',
      },
    ]);
    const claimStart = env.now;
    env.setOnSleep((_ms, currentNow) => {
      env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: currentNow }]);
      if (currentNow - claimStart === 500) {
        const st = env.states.get(candId)!;
        st.state = 'submitted';
        st.claimedAt = new Date(currentNow).toISOString();
      }
    });
    assert.deepEqual(
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: 'toolu_noreceipt',
        expected: sampleExpected(),
        kind: 'question',
        answers: { 'Which environment?': ['Prod'] },
      }),
      { status: 'unknown', detail: 'no_receipt' },
    );

    const beforeLate = await executor.audit();
    const entryBefore = beforeLate.entries.find(e => e.toolUseId === 'toolu_noreceipt');
    assert.equal(entryBefore?.webSubmitted?.status, 'unknown');
    assert.equal(entryBefore?.webSubmitted?.detail, 'no_receipt');

    // 模拟迟到回执到达
    const lateIso = new Date(env.now + 3_000).toISOString();
    env.states.get(candId)!.browserSubmittedAt = lateIso;
    executor.confirmCloud({ webSessionId: 'session_abc123', toolUseId: 'toolu_noreceipt', outcome: 'answered' });

    const afterLate = await executor.audit();
    const entryAfter = afterLate.entries.find(e => e.toolUseId === 'toolu_noreceipt');
    assert.equal(entryAfter?.webSubmitted?.status, 'submitted');
    assert.equal(entryAfter?.webSubmitted?.at, lateIso);
    assert.equal(entryAfter?.webSubmitted?.lateReceipt, true);
    assert.equal(entryAfter?.cloudConfirmed?.outcome, 'answered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source 三种取值映射、审计不存其他原文及 300 条持久化上限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-exec-audit-'));
  try {
    const env = createFakeEnv();
    const ledger = new WebRequestLedger(() => env.now);
    const executor = new WebRequestExecutor(dir, env.bridge, env.runtime, ledger, env.options);

    const runWithSource = async (toolUseId: string, ledgerSource?: 'user' | 'automatic', otherText?: string) => {
      const candId = `browser:inst-1:abc123:${toolUseId}`;
      env.setSessions([{ instanceId: 'inst-1', sessionId: 'abc123', lastSeenAt: env.now }]);
      env.setCandidates([
        {
          id: candId,
          question: sampleBrowserQuestion({ id: toolUseId, toolUseId }),
          seen: env.now,
          state: 'pending',
        },
      ]);
      const answers = otherText ? { 'Which environment?': [] } : { 'Which environment?': ['Staging'] };
      const otherAnswers = otherText ? { 'Which environment?': otherText } : undefined;
      if (ledgerSource) {
        ledger.record({
          webSessionId: 'session_abc123',
          toolUseId,
          answers,
          otherAnswers,
          source: ledgerSource,
        });
      }
      env.setOnSleep((_ms, currentNow) => {
        const st = env.states.get(candId);
        if (st) {
          st.state = 'submitted';
          st.browserSubmittedAt = new Date(currentNow).toISOString();
        }
      });
      const res = await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId,
        expected: sampleExpected(),
        kind: 'question',
        answers,
        otherAnswers,
      });
      assert.deepEqual(res, { status: 'submitted' });
    };

    const secretOther = 'SECRET_FREE_TEXT_DO_NOT_PERSIST_99182';
    await runWithSource('toolu_src_user', 'user', secretOther);
    await runWithSource('toolu_src_auto', 'automatic');
    await runWithSource('toolu_src_paseo', undefined);

    assert.equal(env.delegatedCalls[0]?.source, 'manual');
    assert.equal(env.delegatedCalls[1]?.source, 'automatic');
    assert.equal(env.delegatedCalls[2]?.source, 'manual');

    const auditSnap = await executor.audit();
    assert.equal(JSON.stringify(auditSnap).includes(secretOther), false);
    const userEntry = auditSnap.entries.find(e => e.toolUseId === 'toolu_src_user');
    const autoEntry = auditSnap.entries.find(e => e.toolUseId === 'toolu_src_auto');
    const paseoEntry = auditSnap.entries.find(e => e.toolUseId === 'toolu_src_paseo');
    assert.equal(userEntry?.answerReceived?.source, 'user');
    assert.equal(userEntry?.answerSummary.other?.['Which environment?']?.length, secretOther.length);
    assert.equal(autoEntry?.answerReceived?.source, 'automatic');
    assert.equal(paseoEntry?.answerReceived?.source, 'paseo');

    // 验证最多保留 300 条并持久化
    for (let i = 0; i < 305; i++) {
      await executor.answerWebRequest({
        webSessionId: 'session_abc123',
        toolUseId: `toolu_bulk_${i}`,
        expected: { toolName: 'Bash', input: {} },
        kind: 'tool',
        decision: 'allow',
      });
    }
    const capped = await executor.audit();
    assert.equal(capped.entries.length, 300);
    assert.equal(capped.entries[0]?.toolUseId, 'toolu_bulk_5');
    assert.equal(capped.entries[299]?.toolUseId, 'toolu_bulk_304');

    const reloaded = new WebRequestExecutor(dir, env.bridge, env.runtime, ledger, env.options);
    const reloadedAudit = await reloaded.audit();
    assert.equal(reloadedAudit.entries.length, 300);
    assert.equal(reloadedAudit.entries[299]?.toolUseId, 'toolu_bulk_304');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
