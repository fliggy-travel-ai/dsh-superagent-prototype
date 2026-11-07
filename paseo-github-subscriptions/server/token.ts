import { chmod, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TokenStatus } from '../shared/model.ts';
import { atomicWrite } from './storage.ts';

export class TokenVault {
  private value: string | null = null;
  status: TokenStatus = { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null };
  private directory: string;
  private request: typeof fetch;
  constructor(directory: string, request: typeof fetch = fetch) { this.directory = directory; this.request = request; }

  async load() {
    try {
      this.value = (await readFile(join(this.directory, 'github-token'), 'utf8')).trim();
      await chmod(join(this.directory, 'github-token'), 0o600);
      this.status = { ...this.status, configured: !!this.value, prefix: this.value ? `${this.value.slice(0, 5)}…` : null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 GitHub 令牌文件');
    }
  }

  read = async () => this.value;

  redact(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return (this.value ? text.replaceAll(this.value, '[令牌已隐藏]') : text).replace(/(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+/g, '[令牌已隐藏]').slice(0, 500);
  }

  async save(input: string) {
    const token = input.trim();
    if (!/^[\x21-\x7e]{1,512}$/.test(token)) throw new Error('令牌格式无效');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.request('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub 验证失败，HTTP ${response.status}`);
      const user = await response.json() as { login?: unknown };
      if (typeof user.login !== 'string') throw new Error('GitHub 账号信息无效');
      await atomicWrite(join(this.directory, 'github-token'), token);
      this.value = token;
      this.status = {
        configured: true, prefix: `${token.slice(0, 5)}…`, login: user.login,
        remaining: response.headers.has('x-ratelimit-remaining') ? Number(response.headers.get('x-ratelimit-remaining')) : null,
        resetAt: response.headers.has('x-ratelimit-reset') ? new Date(Number(response.headers.get('x-ratelimit-reset')) * 1000).toISOString() : null,
        error: null,
      };
      return this.status;
    } catch {
      throw new Error('GitHub 令牌验证或保存失败，请检查令牌权限和网络');
    } finally { clearTimeout(timeout); }
  }

  async remove() {
    try { await unlink(join(this.directory, 'github-token')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.value = null;
    this.status = { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null };
    return this.status;
  }
}
