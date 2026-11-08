import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyLegacyFiles, type CopyReport } from '../../core/legacy-copy.ts';

export interface EscalationMigration {
  report: CopyReport;
  /** 旧 config.json 中能对应到 machine.json `escalation` 区块的字段。只给建议，不写文件。 */
  suggestion: { delivery?: 'shadow' | 'live'; webhook?: { urlEnv?: string; authEnv?: string } } | null;
  notes: string[];
}

/**
 * 旧插件 event-notifications 的状态迁移（只复制）：
 * - `state.json` → `escalation/state.json`（实际发送模式的去重记录，影子模式用单独的 state-shadow.json）；
 * - `quota-alerts.json` → `escalation/quota-alerts.json`；
 * - `events.jsonl` 和 `config.json` 不复制：事件日志留作旧记录，配置只生成建议。
 */
export function migrateLegacyEscalation(legacyDirectory: string, targetDirectory: string): EscalationMigration {
  const report = copyLegacyFiles(legacyDirectory, targetDirectory, [{ from: 'state.json' }, { from: 'quota-alerts.json' }]);
  const notes: string[] = [];
  let suggestion: EscalationMigration['suggestion'] = null;
  try {
    const old = JSON.parse(readFileSync(join(legacyDirectory, 'config.json'), 'utf8')) as { delivery?: unknown; webhook?: { urlEnv?: unknown; authEnv?: unknown } };
    suggestion = {};
    if (old.delivery === 'shadow' || old.delivery === 'live') suggestion.delivery = old.delivery;
    if (old.webhook && (typeof old.webhook.urlEnv === 'string' || typeof old.webhook.authEnv === 'string')) {
      suggestion.webhook = {
        ...(typeof old.webhook.urlEnv === 'string' ? { urlEnv: old.webhook.urlEnv } : {}),
        ...(typeof old.webhook.authEnv === 'string' ? { authEnv: old.webhook.authEnv } : {}),
      };
    }
    if (suggestion.delivery === 'live') notes.push('旧配置是实际发送；新模块默认影子，核对 escalation.records 和 events.jsonl 后再在页面切到实际发送。');
    else notes.push('新模块默认影子模式。');
    notes.push('旧插件的 Keychain 服务名写在旧源码里，需要在 machine.json 的 escalation.webhook 中填 urlService、authService。');
  } catch { /* 没有旧配置或无法解析：不给建议 */ }
  return { report, suggestion, notes };
}
