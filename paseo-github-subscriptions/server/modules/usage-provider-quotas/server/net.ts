import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

/**
 * 额度来源的网络请求。
 * - 代理优先级：账号显式配置 > 进程环境变量 > macOS 系统代理（scutil，带超时并缓存）。
 * - 系统代理读 HTTPS 键，遵守例外列表。
 * - 显式配置的代理，或携带令牌的请求（sensitive），代理失败时直接报错，不改直连。
 */

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const SCUTIL_TIMEOUT_MS = 2_000;
const SCUTIL_CACHE_MS = 60_000;

function exceptionMatches(pattern: string, host: string): boolean {
  const value = pattern.trim().toLowerCase();
  if (!value) return false;
  if (value.includes("/")) return host.startsWith(`${value.split("/")[0]}.`) || host === value.split("/")[0];
  if (value.includes("*")) {
    const escaped = value.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
    return new RegExp(`^${escaped}$`, "u").test(host);
  }
  return host === value;
}

/** 解析 `scutil --proxy` 的输出，返回访问 host 应使用的代理地址；没有启用或命中例外列表时返回 null。 */
export function parseScutilProxy(output: string, targetHost: string): string | null {
  const field = (name: string) => output.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)`, "mu"))?.[1];
  const host = targetHost.toLowerCase();
  const exceptions = output.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/u)?.[1] ?? "";
  for (const line of exceptions.split("\n")) {
    const pattern = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/u)?.[1];
    if (pattern && exceptionMatches(pattern, host)) return null;
  }
  for (const prefix of ["HTTPS", "HTTP"]) {
    const proxyHost = field(`${prefix}Proxy`);
    const port = field(`${prefix}Port`);
    if (field(`${prefix}Enable`) === "1" && proxyHost && port) return `http://${proxyHost}:${port}`;
  }
  return null;
}

const defaultScutil = () => execFileSync("scutil", ["--proxy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: SCUTIL_TIMEOUT_MS });
let scutilRunner: () => string = defaultScutil;
let scutilCache: { at: number; output: string } | null = null;

/** 测试用：替换 scutil 调用并清空缓存；传 null 恢复。 */
export function setScutilRunnerForTest(runner: (() => string) | null): void {
  scutilRunner = runner ?? defaultScutil;
  scutilCache = null;
}

function readScutil(): string {
  const now = Date.now();
  if (scutilCache && now - scutilCache.at < SCUTIL_CACHE_MS) return scutilCache.output;
  let output = "";
  // 非 macOS、超时或受限环境读不到时按“没有系统代理”处理，并同样缓存，避免每次请求都等超时。
  try { output = scutilRunner(); } catch { /* 没有系统代理 */ }
  scutilCache = { at: now, output };
  return output;
}

export function getSystemProxy(targetHost: string): string | null {
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) return process.env[key]!;
  }
  return parseScutilProxy(readScutil(), targetHost);
}

export interface SimpleResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  proxyUrl?: string;
  /** 请求带刷新令牌等凭据：代理失败时不改直连。 */
  sensitive?: boolean;
}

function collect(res: http.IncomingMessage, resolve: (value: SimpleResponse) => void, reject: (reason: unknown) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  res.on("error", reject);
  res.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    const status = res.statusCode ?? 0;
    resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    });
  });
}

function directFetch(urlString: string, options: FetchOptions = {}): Promise<SimpleResponse> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000 } = options;
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => collect(res, resolve, reject),
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function tunnelFetch(urlString: string, proxyUrl: string, options: FetchOptions = {}): Promise<SimpleResponse> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000 } = options;
  const target = new URL(urlString);
  if (target.protocol !== "https:") {
    return directFetch(urlString, options);
  }
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
    });
    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(new Error("proxy connect timeout"));
    });
    connectReq.on("error", reject);
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.on("error", reject);
      const req = https.request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers: {
            Host: target.host,
            ...headers,
            ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
          },
          createConnection: () => tlsSocket,
        },
        (response) => collect(response, resolve, reject),
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    connectReq.end();
  });
}

export async function smartFetch(urlString: string, options: FetchOptions = {}): Promise<SimpleResponse> {
  const explicit = options.proxyUrl || undefined;
  const proxyUrl = explicit || getSystemProxy(new URL(urlString).hostname);
  if (!proxyUrl) return await directFetch(urlString, options);
  try {
    return await tunnelFetch(urlString, proxyUrl, options);
  } catch (error) {
    // 显式配置的代理，或带凭据的请求：不能悄悄绕过代理直连。
    if (explicit || options.sensitive) throw error;
    return await directFetch(urlString, options);
  }
}
