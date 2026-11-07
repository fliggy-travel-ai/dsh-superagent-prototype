const fixtureBase = process.env.GHSUB_FIXTURE_URL ?? '';
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
  if (input instanceof Request) throw new Error('测试网络夹具只接受 URL 或字符串');
  const url = new URL(String(input));
  if (url.hostname === 'api.github.com' && url.protocol === 'https:' && fixtureBase) {
    return originalFetch(new URL(`${url.pathname}${url.search}`, fixtureBase).href, init);
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
  throw new Error(`测试网络夹具拒绝访问 ${url.hostname}`);
}) as typeof fetch;
