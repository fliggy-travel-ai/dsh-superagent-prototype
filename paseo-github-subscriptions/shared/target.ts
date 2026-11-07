export function parseTarget(value: string) {
  const trimmed = value.trim();
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:(?:#|\/(?:issues|pull)\/)([1-9]\d*))?\/?$/.exec(trimmed);
  if (!match) throw new Error('请输入 owner/repo、owner/repo#123 或 GitHub Issue/PR 网址');
  const owner = match[1].toLowerCase();
  const repo = match[2].toLowerCase();
  const number = match[3] ? Number(match[3]) : null;
  if (number !== null && !Number.isSafeInteger(number)) throw new Error('Issue/PR 编号无效');
  return { owner, repo, number, key: `${owner}/${repo}${number ? `#${number}` : ''}`, scope: number ? 'thread' as const : 'repo' as const };
}
