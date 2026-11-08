import test from 'node:test';
import assert from 'node:assert/strict';
import { toWebAnswer } from '../server/web-request/normalize.ts';

const expected = (questions: Record<string, unknown>[], toolName = 'AskUserQuestion') => ({
  toolName,
  input: { questions },
});

const singlePrompt = {
  question: '选择哪个环境？',
  header: '环境',
  multiSelect: false,
  options: [{ label: '测试环境' }, { label: '预发环境' }],
};

const multiPrompt = {
  question: '需要执行哪些检查？',
  header: '检查项',
  multiSelect: true,
  options: [{ label: '类型检查' }, { label: '单元测试' }, { label: '集成测试' }],
};

test('结构化格式与数组形式支持单选、多选和自由文本', () => {
  const both = expected([singlePrompt, multiPrompt]);
  assert.deepEqual(
    toWebAnswer(both, {
      behavior: 'allow',
      updatedInput: {
        answers: {
          [singlePrompt.question]: ['测试环境'],
          [multiPrompt.question]: ['类型检查', '集成测试'],
        },
      },
    }),
    {
      ok: true,
      answers: {
        [singlePrompt.question]: ['测试环境'],
        [multiPrompt.question]: ['类型检查', '集成测试'],
      },
    },
  );

  assert.deepEqual(
    toWebAnswer(both, {
      behavior: 'allow',
      updatedInput: {
        answers: {
          [singlePrompt.question]: [],
          [multiPrompt.question]: ['类型检查'],
        },
        otherAnswers: {
          [singlePrompt.question]: '  独立沙箱环境  ',
          [multiPrompt.question]: '  端到端冒烟  ',
        },
      },
    }),
    {
      ok: true,
      answers: {
        [singlePrompt.question]: [],
        [multiPrompt.question]: ['类型检查'],
      },
      otherAnswers: {
        [singlePrompt.question]: '独立沙箱环境',
        [multiPrompt.question]: '端到端冒烟',
      },
    },
  );
});

test('原文键与唯一 header 键均可匹配，header 重复时拒绝按 header 匹配', () => {
  const both = expected([singlePrompt, multiPrompt]);
  assert.deepEqual(
    toWebAnswer(both, {
      behavior: 'allow',
      updatedInput: {
        answers: {
          环境: '预发环境',
          检查项: '类型检查, 单元测试',
        },
      },
    }),
    {
      ok: true,
      answers: {
        [singlePrompt.question]: ['预发环境'],
        [multiPrompt.question]: ['类型检查', '单元测试'],
      },
    },
  );

  const duplicateHeaders = expected([
    { ...singlePrompt, question: '问题一', header: '相同标题' },
    { ...singlePrompt, question: '问题二', header: '相同标题' },
  ]);
  assert.deepEqual(
    toWebAnswer(duplicateHeaders, {
      behavior: 'allow',
      updatedInput: { answers: { 相同标题: '测试环境' } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );
  assert.deepEqual(
    toWebAnswer(duplicateHeaders, {
      behavior: 'allow',
      updatedInput: { answers: { 问题一: '测试环境', 问题二: '预发环境' } },
    }),
    {
      ok: true,
      answers: { 问题一: ['测试环境'], 问题二: ['预发环境'] },
    },
  );
});

test('多选逗号连接与含逗号标签的唯一和歧义切分', () => {
  const uniqueComma = expected([{
    question: '验证哪些步骤？',
    header: '步骤',
    multiSelect: true,
    options: [{ label: '构建, 打包' }, { label: '运行测试' }],
  }]);
  assert.deepEqual(
    toWebAnswer(uniqueComma, {
      behavior: 'allow',
      updatedInput: { answers: { 步骤: '构建, 打包, 运行测试' } },
    }),
    {
      ok: true,
      answers: { '验证哪些步骤？': ['构建, 打包', '运行测试'] },
    },
  );

  const longerSequenceWins = expected([{
    question: '验证哪些步骤？',
    header: '步骤',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'A, B' }, { label: 'B, C' }],
  }]);
  assert.deepEqual(
    toWebAnswer(longerSequenceWins, {
      behavior: 'allow',
      updatedInput: { answers: { 步骤: 'A, B, C' } },
    }),
    {
      ok: true,
      answers: { '验证哪些步骤？': ['A', 'B, C'] },
    },
  );

  const ambiguous = expected([{
    question: '验证哪些步骤？',
    header: '步骤',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'A, B' }],
  }]);
  assert.deepEqual(
    toWebAnswer(ambiguous, {
      behavior: 'allow',
      updatedInput: { answers: { 步骤: 'A, B' } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );
});

test('单选非标签文字作为其他，多选尾部文字作为其他，以及其他与标签相同的已知限制', () => {
  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { 环境: 'PASEO_OTHER_1704' } },
    }),
    {
      ok: true,
      answers: { [singlePrompt.question]: [] },
      otherAnswers: { [singlePrompt.question]: 'PASEO_OTHER_1704' },
    },
  );

  assert.deepEqual(
    toWebAnswer(expected([multiPrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { 检查项: '类型检查, 单元测试, 补充人工巡检' } },
    }),
    {
      ok: true,
      answers: { [multiPrompt.question]: ['类型检查', '单元测试'] },
      otherAnswers: { [multiPrompt.question]: '补充人工巡检' },
    },
  );

  assert.deepEqual(
    toWebAnswer(expected([multiPrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { 检查项: '仅填写其他说明' } },
    }),
    {
      ok: true,
      answers: { [multiPrompt.question]: [] },
      otherAnswers: { [multiPrompt.question]: '仅填写其他说明' },
    },
  );

  // Known limitation: in Paseo string format for multi-select, typing an existing option label in "Other" is parsed as selecting that option.
  assert.deepEqual(
    toWebAnswer(expected([multiPrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { 检查项: '类型检查, 集成测试' } },
    }),
    {
      ok: true,
      answers: { [multiPrompt.question]: ['类型检查', '集成测试'] },
    },
  );
});

test('单选同时有标签和文本、空文本、超长文本、重复标签、漏答及不支持其他时拒绝，deny 返回 dismissed', () => {
  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), {
      behavior: 'allow',
      updatedInput: {
        answers: { [singlePrompt.question]: ['测试环境'] },
        otherAnswers: { [singlePrompt.question]: '同时填了其他' },
      },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), {
      behavior: 'allow',
      updatedInput: {
        answers: { [singlePrompt.question]: '测试环境' },
        otherAnswers: { [singlePrompt.question]: '同时填了其他' },
      },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  for (const empty of ['', '   ']) {
    assert.deepEqual(
      toWebAnswer(expected([singlePrompt]), {
        behavior: 'allow',
        updatedInput: { answers: { [singlePrompt.question]: empty } },
      }),
      { ok: false, status: 'unknown', detail: 'invalid_answer' },
    );
    assert.deepEqual(
      toWebAnswer(expected([singlePrompt]), {
        behavior: 'allow',
        updatedInput: { answers: { [singlePrompt.question]: [] }, otherAnswers: { [singlePrompt.question]: empty } },
      }),
      { ok: false, status: 'unknown', detail: 'invalid_answer' },
    );
  }

  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { [singlePrompt.question]: 'x'.repeat(2000) } },
    }),
    {
      ok: true,
      answers: { [singlePrompt.question]: [] },
      otherAnswers: { [singlePrompt.question]: 'x'.repeat(2000) },
    },
  );
  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { [singlePrompt.question]: 'x'.repeat(2001) } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  assert.deepEqual(
    toWebAnswer(expected([singlePrompt, multiPrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { [singlePrompt.question]: ['测试环境'] } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  assert.deepEqual(
    toWebAnswer(expected([multiPrompt]), {
      behavior: 'allow',
      updatedInput: { answers: { [multiPrompt.question]: ['类型检查', '类型检查'] } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  assert.deepEqual(
    toWebAnswer(expected([{ ...singlePrompt, allowOther: false }]), {
      behavior: 'allow',
      updatedInput: { answers: { [singlePrompt.question]: '自定义' } },
    }),
    { ok: false, status: 'unknown', detail: 'invalid_answer' },
  );

  assert.deepEqual(
    toWebAnswer(expected([singlePrompt]), { behavior: 'deny' }),
    { ok: false, status: 'unknown', detail: 'dismissed' },
  );
});
