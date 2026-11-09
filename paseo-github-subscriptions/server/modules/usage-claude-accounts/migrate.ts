import { join } from 'node:path';
import { copyLegacyFiles, type CopyReport } from '../../core/legacy-copy.ts';
import { mergeLabels } from './labels-file.ts';

export interface ClaudeQuotaMigration {
  report: CopyReport;
  labels: { added: number };
}

/**
 * 旧插件 claude-quota-resume 的状态迁移（只复制，不移动、不覆盖，可重复运行）：
 * jobs.json、enabled-agents.json、disabled-agents.json、usage-history.json、cross-user-*.json 和 renewal/
 * 复制到 `quota/`；account-labels.json 的内容并入 labels.json（已有标签不覆盖）。旧目录保留到旧插件删除为止。
 */
export function migrateLegacyClaudeQuota(legacyDirectory: string, targetDirectory: string, labelsFile: string): ClaudeQuotaMigration {
  const report = copyLegacyFiles(legacyDirectory, targetDirectory, [
    { from: 'jobs.json' }, { from: 'enabled-agents.json' }, { from: 'disabled-agents.json' }, { from: 'usage-history.json' },
    { from: 'cross-user-providers.json' }, { from: 'cross-user-cache.json' }, { from: 'renewal', directory: true },
  ]);
  return { report, labels: { added: mergeLabels(join(legacyDirectory, 'account-labels.json'), labelsFile) } };
}
