import { execFile } from 'node:child_process';

export interface PrefilterConfig { command: string; script: string }

/** 只在脚本成功退出且明确输出 suppress 时过滤。缺失、超时和无效输出都放行。 */
export function prefilter(config: PrefilterConfig | undefined, payload: unknown): Promise<boolean> {
  if (!config) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = execFile(config.command, [config.script], { timeout: 4000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) { resolve(false); return; }
      try { resolve(JSON.parse(stdout).action === 'suppress'); } catch { resolve(false); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}
