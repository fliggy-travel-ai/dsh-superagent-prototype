/**
 * 提交前扫描：邮箱、Apple 隐藏邮箱、webhook 地址、令牌格式。命中时退出码为 1。
 * 用法：npm run scan（扫描本目录中 Git 跟踪和未忽略的新文件）。
 * 放行：示例域名（example.*、*.invalid、*.test、localhost）、测试占位令牌（含 test、secret、fake 等词），
 * 或在同一行写 `scan-allow`。命中结果只给文件、行号和类别，不打印原文。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Finding { file: string; line: number; kind: string }

const RELAY = 'private' + 'relay';
const SAFE_DOMAIN = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost|users\.noreply\.github\.com)$/i;
const PLACEHOLDER = /(test|secret|fake|dummy|example|placeholder|not_?real|sample|redacted|abcdefgh|0{6,}|x{6,})/i;
const LOCK_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

const TOKEN_RULES: { kind: string; pattern: RegExp }[] = [
  { kind: 'GitHub 令牌', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'API 密钥', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'Slack 令牌', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'AWS 密钥', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const URL_PATTERN = /https?:\/\/([^/\s"'`)<>]+)([^\s"'`)<>]*)/g;
const WEBHOOK = /hook|open-apis\/bot|\/robot\/send|discord(app)?\.com\/api\/webhooks/i;
const SAFE_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((content, index) => {
    if (content.includes('scan-allow')) return;
    const add = (kind: string) => findings.push({ file, line: index + 1, kind });
    if (content.toLowerCase().includes(RELAY)) add('Apple 隐藏邮箱');
    if (!LOCK_FILES.test(file)) {
      for (const match of content.matchAll(EMAIL)) if (!SAFE_DOMAIN.test(match[1]!)) { add('邮箱'); break; }
    }
    for (const rule of TOKEN_RULES) {
      for (const match of content.matchAll(rule.pattern)) if (!PLACEHOLDER.test(match[0])) { add(rule.kind); break; }
    }
    for (const match of content.matchAll(URL_PATTERN)) {
      const host = match[1]!.toLowerCase();
      if (SAFE_HOST.test(host) || SAFE_DOMAIN.test(host.replace(/:\d+$/, ''))) continue;
      if (WEBHOOK.test(host + match[2])) { add('webhook 地址'); break; }
    }
  });
  return findings;
}

function listFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter(Boolean).filter(file => !file.startsWith('node_modules/'));
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const findings: Finding[] = [];
  for (const file of listFiles(root)) {
    const path = `${root}${file}`;
    let buffer: Buffer;
    try { if (statSync(path).size > 5_000_000) continue; buffer = readFileSync(path); } catch { continue; }
    if (buffer.includes(0)) continue;
    findings.push(...scanText(file, buffer.toString('utf8')));
  }
  if (findings.length === 0) { console.log('扫描通过：没有发现邮箱、Apple 隐藏邮箱、webhook 地址或令牌。'); return; }
  for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.kind}`);
  console.error(`扫描失败：${findings.length} 处命中。确认是测试数据时在该行写 scan-allow。`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
