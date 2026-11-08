import { test } from 'node:test';
import { runPresencePanelUiSuite } from './ui/presence-panel.ts';

test('人工待办“其他”输入框支持单选互斥、多选并存、完成判定与已提交答案回显', async () => {
  await runPresencePanelUiSuite();
});
