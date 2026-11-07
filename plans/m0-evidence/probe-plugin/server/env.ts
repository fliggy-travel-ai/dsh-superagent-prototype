// 只返回是否存在和长度，绝不返回令牌内容。
export function envFacts() {
  const t = process.env.GH_TOKEN ?? "";
  return {
    hasGhToken: t.length > 0,
    ghTokenLength: t.length,
    hasGithubToken: (process.env.GITHUB_TOKEN ?? "").length > 0,
    pasteoHome: process.env.PASEO_HOME ?? null,
    node: process.version,
    pid: process.pid,
  };
}
