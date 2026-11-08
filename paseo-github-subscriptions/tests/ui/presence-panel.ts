import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { makePresence } from './control-fixtures.ts';
import type { Question, QuestionAnswer } from '../../shared/presence.ts';
import type { QuestionDraftState } from '../../client/presence-panel.tsx';

let hooksInstalled = false;

export function installTsxAndReactNativeHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const rnSource = [
    "export const View = 'View';",
    "export const Text = 'Text';",
    "export const TextInput = 'TextInput';",
    "export const Pressable = 'Pressable';",
    "export const Switch = 'Switch';",
    "export const ScrollView = 'ScrollView';",
    "export const Platform = { select: (obj) => obj.default ?? obj.ios };",
  ].join('\n');
  const rnDataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(rnSource)}`;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react-native') {
        return { url: rnDataUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.tsx')) {
        const source = readFileSync(fileURLToPath(url), 'utf8');
        const transpiled = ts.transpileModule(source, {
          fileName: fileURLToPath(url),
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
          },
        });
        return {
          format: 'module',
          source: transpiled.outputText,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
}

interface RenderedNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RenderedNode | string>;
}

const mockTheme = {
  colors: {
    surface0: '#ffffff',
    surface1: '#f6f6f6',
    surface2: '#ececee',
    border: '#e4e4e7',
    foreground: '#1f1f22',
    foregroundMuted: '#8a8a90',
    accent: '#2f6bf0',
    accentForeground: '#ffffff',
    statusSuccess: '#2e9a52',
    statusWarning: '#c27a07',
    statusDanger: '#d6403a',
  },
};

function findNodes(node: RenderedNode | string, predicate: (n: RenderedNode) => boolean, out: RenderedNode[] = []): RenderedNode[] {
  if (typeof node === 'string') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children) findNodes(child, predicate, out);
  return out;
}

function collectText(node: RenderedNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(collectText).join('');
}

export async function runPresencePanelUiSuite() {
  installTsxAndReactNativeHooks();
  const panelMod = await import('../../client/presence-panel.tsx');
  const uiMod = await import('../../client/ui.tsx');

  const {
    QuestionCard,
    pickPromptOption,
    changePromptOther,
    isPromptComplete,
    isQuestionAnswerable,
    isQuestionComplete,
    buildQuestionSubmission,
  } = panelMod;
  const { bind } = uiMod;

  const fixture = makePresence();
  const question = fixture.questions[0]!;
  const singlePrompt = question.prompts[0]!;
  const multiPrompt = question.prompts[1]!;

  // 1. 单选互斥：选选项清空“其他”，输入“其他”清空已选选项
  let draft: QuestionDraftState = { answers: {}, otherAnswers: {} };
  draft = pickPromptOption(singlePrompt, draft, ['预发（推荐）']);
  assert.deepEqual(draft.answers[singlePrompt.question], ['预发（推荐）']);
  assert.equal(draft.otherAnswers[singlePrompt.question] ?? '', '');

  draft = changePromptOther(singlePrompt, draft, '自定义灰度环境');
  assert.deepEqual(draft.answers[singlePrompt.question], []);
  assert.equal(draft.otherAnswers[singlePrompt.question], '自定义灰度环境');

  draft = pickPromptOption(singlePrompt, draft, ['生产']);
  assert.deepEqual(draft.answers[singlePrompt.question], ['生产']);
  assert.equal(draft.otherAnswers[singlePrompt.question], '');

  // 2. 多选并存：可同时勾选多个选项并填写“其他”文本
  draft = pickPromptOption(multiPrompt, draft, ['类型检查']);
  draft = changePromptOther(multiPrompt, draft, '安全扫描');
  draft = pickPromptOption(multiPrompt, draft, ['类型检查', '集成测试']);
  assert.deepEqual(draft.answers[multiPrompt.question], ['类型检查', '集成测试']);
  assert.equal(draft.otherAnswers[multiPrompt.question], '安全扫描');

  // 3. 完成判定与提交报文
  assert.equal(isPromptComplete(singlePrompt, [], ''), false);
  assert.equal(isPromptComplete(singlePrompt, [], '   '), false);
  assert.equal(isPromptComplete(singlePrompt, ['生产'], ''), true);
  assert.equal(isPromptComplete(singlePrompt, [], '自定义灰度环境'), true);
  assert.equal(isPromptComplete(singlePrompt, ['生产'], '自定义灰度环境'), false);
  assert.equal(isPromptComplete(singlePrompt, [], 'x'.repeat(2001)), false);
  assert.equal(isPromptComplete({ ...singlePrompt, allowOther: false }, [], '自定义'), false);

  assert.equal(isPromptComplete(multiPrompt, [], ''), false);
  assert.equal(isPromptComplete(multiPrompt, ['类型检查'], ''), true);
  assert.equal(isPromptComplete(multiPrompt, [], '安全扫描'), true);
  assert.equal(isPromptComplete(multiPrompt, ['类型检查', '集成测试'], '安全扫描'), true);

  assert.equal(isQuestionComplete(question, { [singlePrompt.question]: ['生产'] }, {}), false);
  assert.equal(
    isQuestionComplete(
      question,
      { [singlePrompt.question]: [], [multiPrompt.question]: ['类型检查'] },
      { [singlePrompt.question]: '  自定义环境  ', [multiPrompt.question]: '  额外回归  ' },
    ),
    true,
  );
  assert.equal(isQuestionAnswerable({ ...question, pages: 2 }), false);

  const payload = buildQuestionSubmission(
    question,
    { [singlePrompt.question]: [], [multiPrompt.question]: ['类型检查'] },
    { [singlePrompt.question]: '  自定义环境  ', [multiPrompt.question]: '  额外回归  ' },
  );
  assert.deepEqual(payload, {
    id: 'q-cloud-1',
    answers: {
      '发布到哪个环境？': [],
      '需要执行哪些检查？': ['类型检查'],
    },
    otherAnswers: {
      '发布到哪个环境？': '自定义环境',
      '需要执行哪些检查？': '额外回归',
    },
  });

  // 4. 组件树渲染验证：待回答状态显示“其他”输入框、驱动单选互斥与多选并存并提交；已提交状态回显“其他”文本
  const submittedPayloads: QuestionAnswer[] = [];
  let hookStates: unknown[] = [];
  let hookCursor = 0;

  const origUseState = React.useState;
  const origUseMemo = React.useMemo;
  const origUseEffect = React.useEffect;
  const origUseContext = React.useContext;

  const contextValues = new Map<unknown, unknown>();
  const mockReact = React as unknown as Record<string, unknown>;
  const dispatcher = (
    (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: Record<string, unknown> } })
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  );

  function renderTree(element: ReactNode): RenderedNode | string {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) {
      return { type: 'Fragment', props: {}, children: element.map(renderTree).filter(c => c !== '') };
    }
    if (!isValidElement(element)) return '';
    const el = element as ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function') {
      const fn = el.type as (props: Record<string, unknown>) => ReactNode;
      return renderTree(fn(el.props));
    }
    if (typeof el.type === 'object' && el.type !== null && 'value' in el.props) {
      contextValues.set((el.type as { _context?: unknown })._context ?? el.type, el.props.value);
      return renderTree(el.props.children as ReactNode);
    }
    const rawChildren = el.props.children;
    const childList = Array.isArray(rawChildren) ? rawChildren : rawChildren !== undefined ? [rawChildren] : [];
    return {
      type: String(el.type),
      props: el.props,
      children: childList.map(renderTree).filter(c => c !== ''),
    };
  }

  const BoundCard = bind(
    {
      store: { subscribe: () => () => {}, getState: () => ({} as never) } as never,
      control: {
        subscribe: () => () => {},
        getState: () => ({} as never),
        answerQuestion: async (ans: QuestionAnswer) => { submittedPayloads.push(ans); },
      } as never,
      openScreen: () => {},
    },
    (props: PluginHostProps & { question: Question }) =>
      React.createElement(QuestionCard, {
        question: props.question,
        busy: false,
        run: async op => { await op(); },
      }),
  );

  function renderCard(targetQuestion: Question): RenderedNode {
    hookCursor = 0;
    const prevH = dispatcher?.H;
    const customDispatcher = {
      useState(init: unknown) {
        const idx = hookCursor++;
        if (idx >= hookStates.length) {
          hookStates[idx] = typeof init === 'function' ? (init as () => unknown)() : init;
        }
        const setState = (next: unknown) => {
          hookStates[idx] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(hookStates[idx]) : next;
        };
        return [hookStates[idx], setState];
      },
      useEffect() {},
      useMemo(fn: () => unknown) { return fn(); },
      useContext(ctx: { _currentValue?: unknown }) {
        return contextValues.has(ctx) ? contextValues.get(ctx) : ctx._currentValue;
      },
    };
    if (dispatcher) dispatcher.H = customDispatcher;
    try {
      return renderTree(
        React.createElement(BoundCard as unknown as React.ComponentType<Record<string, unknown>>, {
          theme: mockTheme,
          host: { id: 'h1', label: 'Host' },
          layout: { compact: false, platform: 'web' },
          question: targetQuestion,
        }),
      ) as RenderedNode;
    } finally {
      if (dispatcher && prevH) dispatcher.H = prevH;
      void origUseState; void origUseMemo; void origUseEffect; void origUseContext; void mockReact;
    }
  }

  hookStates = [];
  let tree = renderCard(question);
  const inputs = findNodes(tree, n => n.type === 'TextInput');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.props.accessibilityLabel, '发布到哪个环境？ 其他');
  assert.equal(inputs[1]?.props.accessibilityLabel, '需要执行哪些检查？ 其他');

  const submitBefore = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '提交回答')[0]!;
  assert.equal(submitBefore.props.disabled, true);

  // 先在单选题选“生产”，再输入“其他”文本，验证单选选项被清空
  const prodRadio = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '生产')[0]!;
  (prodRadio.props.onPress as () => void)();
  tree = renderCard(question);
  const prodAfterPick = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '生产')[0]!;
  assert.equal((prodAfterPick.props.accessibilityState as { checked: boolean }).checked, true);

  const singleInput = findNodes(tree, n => n.type === 'TextInput' && n.props.accessibilityLabel === '发布到哪个环境？ 其他')[0]!;
  (singleInput.props.onChangeText as (v: string) => void)('专有云环境');
  tree = renderCard(question);
  const prodAfterOther = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '生产')[0]!;
  assert.equal((prodAfterOther.props.accessibilityState as { checked: boolean }).checked, false);

  // 在多选题同时勾选“类型检查”并输入“其他”文本
  const checkOption = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '类型检查（推荐）')[0]!;
  (checkOption.props.onPress as () => void)();
  tree = renderCard(question);
  const multiInput = findNodes(tree, n => n.type === 'TextInput' && n.props.accessibilityLabel === '需要执行哪些检查？ 其他')[0]!;
  (multiInput.props.onChangeText as (v: string) => void)('回归冒烟');
  tree = renderCard(question);

  const submitReady = findNodes(tree, n => n.type === 'Pressable' && n.props.accessibilityLabel === '提交回答')[0]!;
  assert.equal(Boolean(submitReady.props.disabled), false);
  await (submitReady.props.onPress as () => Promise<void>)();

  assert.equal(submittedPayloads.length, 1);
  assert.deepEqual(submittedPayloads[0], {
    id: 'q-cloud-1',
    answers: {
      '发布到哪个环境？': [],
      '需要执行哪些检查？': ['类型检查'],
    },
    otherAnswers: {
      '发布到哪个环境？': '专有云环境',
      '需要执行哪些检查？': '回归冒烟',
    },
  });

  // 验证已提交状态的回显显示“其他”文本
  hookStates = [];
  const submittedQuestion: Question = {
    ...question,
    state: 'submitted',
    answer: {
      source: 'user',
      answers: {
        '发布到哪个环境？': [],
        '需要执行哪些检查？': ['类型检查'],
      },
      otherAnswers: {
        '发布到哪个环境？': '专有云环境',
        '需要执行哪些检查？': '回归冒烟',
      },
    },
  };
  const echoTree = renderCard(submittedQuestion);
  const fullText = collectText(echoTree);
  assert.match(fullText, /其他：专有云环境/);
  assert.match(fullText, /其他：回归冒烟/);
}
