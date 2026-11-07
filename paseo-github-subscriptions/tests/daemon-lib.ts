import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createPaseoApi, type PaseoApi } from '@getpaseo/client';
import { createHostClient } from '@getpaseo/client/node';
import { createFixture, newWorld, repository, type Fixture } from './github-fixture.ts';

const exec = promisify(execFile);

export const PASEO_CLI = '/Applications/Paseo.app/Contents/Resources/bin/paseo';
export const PLUGIN_ID = 'github-subscriptions';
export const TEST_TOKEN = 'ghp_daemonintegrationtesttoken0000000000';
export const TEMP_PREFIX = 'ghsub-daemon-it-';
export const pluginRoot = resolve(import.meta.dirname, '..');

export const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));

export async function waitFor<Value>(check: () => Promise<Value | false | null | undefined> | Value | false | null | undefined, message: string, timeout = 30_000, step = 200): Promise<Value> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await sleep(step);
  }
  throw new Error(`等待超时：${message}${last instanceof Error ? `（最后错误：${last.message}）` : ''}`);
}

export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

export interface GithubFixtureServer {
  url: string;
  fixture: Fixture;
  authorizations: Set<string>;
  hosts: Set<string>;
  close(): Promise<void>;
}

export async function startGithubFixture(): Promise<GithubFixtureServer> {
  const world = newWorld();
  world.organization = [repository('app')];
  const fixture = createFixture(world);
  const authorizations = new Set<string>();
  const hosts = new Set<string>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers[name] = value;
      if (headers.authorization) authorizations.add(headers.authorization);
      if (headers.host) hosts.add(headers.host);
      const result = await fixture.fetch(`https://api.github.com${request.url ?? '/'}`, { headers });
      const outgoing: Record<string, string> = {};
      result.headers.forEach((value, name) => { outgoing[name] = value; });
      response.writeHead(result.status, outgoing);
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, fixture, authorizations, hosts,
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}

export interface HarnessOptions { fixtureUrl: string }

export class Harness {
  readonly base: string;
  readonly home: string;
  readonly port: number;
  readonly stage: string;
  readonly fixtureUrl: string;
  readonly commands: Array<{ args: string[]; ok: boolean }> = [];
  private ownsDaemon = false;

  private constructor(base: string, port: number, fixtureUrl: string) {
    this.base = base;
    this.home = join(base, 'home');
    this.stage = join(base, 'plugin-stage');
    this.port = port;
    this.fixtureUrl = fixtureUrl;
  }

  static async create(options: HarnessOptions): Promise<Harness> {
    const base = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    const harness = new Harness(base, await freePort(), options.fixtureUrl);
    await mkdir(harness.home, { recursive: true, mode: 0o700 });
    await mkdir(join(base, 'work'));
    await writeFile(join(harness.home, 'config.json'), JSON.stringify({
      daemon: { listen: `127.0.0.1:${harness.port}`, relay: { enabled: false }, mcp: { injectIntoAgents: true } }, pluginsEnabled: true,
    }));
    return harness;
  }

  private guard(): void {
    if (!basename(this.base).startsWith(TEMP_PREFIX) || !resolve(this.base).startsWith(`${resolve(tmpdir())}/`) || resolve(this.home) === join(process.env.HOME ?? '', '.paseo')) {
      throw new Error('拒绝操作非临时目录');
    }
  }

  environment(): Record<string, string> {
    return {
      HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8',
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.HOME}/.local/bin:/opt/homebrew/bin`,
      PASEO_HOME: this.home, GHSUB_FIXTURE_URL: this.fixtureUrl,
    };
  }

  async cli<Result = unknown>(args: string[], timeout = 60_000): Promise<Result | null> {
    this.guard();
    const record = { args, ok: false };
    this.commands.push(record);
    const { stdout } = await exec(PASEO_CLI, [...args, '--home', this.home, '--json'], {
      env: this.environment(), timeout, maxBuffer: 4 * 1024 * 1024,
    });
    record.ok = true;
    const text = stdout.trim();
    if (!text) return null;
    return JSON.parse(text.slice(text.search(/[[{]/))) as Result;
  }

  async stagePlugin(): Promise<void> {
    await rm(this.stage, { recursive: true, force: true });
    await mkdir(this.stage, { recursive: true });
    for (const entry of ['paseo-plugin.json', 'package.json', 'index.client.tsx', 'client', 'server', 'shared']) {
      await cp(join(pluginRoot, entry), join(this.stage, entry), { recursive: true });
    }
    await symlink(join(pluginRoot, 'node_modules'), join(this.stage, 'node_modules'), 'dir');
    await cp(join(pluginRoot, 'tests/fixtures/network/fixture-network.ts'), join(this.stage, 'server/fixture-network.ts'));
    const entry = await readFile(join(pluginRoot, 'index.server.ts'), 'utf8');
    await writeFile(join(this.stage, 'index.server.ts'), `import './server/fixture-network.ts';\n${entry}`);
  }

  async writeToken(): Promise<void> {
    const directory = join(this.home, 'github-subscriptions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'github-token'), TEST_TOKEN, { mode: 0o600 });
  }

  async mergeConfig(change: (config: Record<string, unknown>) => void): Promise<void> {
    const path = join(this.home, 'config.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    change(config);
    await writeFile(path, JSON.stringify(config));
  }

  async startDaemon(): Promise<void> {
    this.ownsDaemon = true;
    await this.cli(['daemon', 'start', '--timeout', '40']);
  }

  async restartDaemon(): Promise<void> {
    await this.cli(['daemon', 'stop']);
    await sleep(500);
    await this.cli(['daemon', 'start', '--timeout', '40']);
  }

  async connect(): Promise<{ client: ReturnType<typeof createHostClient>; paseo: PaseoApi; mcp: { url: string; token: string } }> {
    const lock = JSON.parse(await readFile(join(this.home, 'paseo.pid'), 'utf8')) as { listen: string };
    const credential = (await readFile(join(this.home, 'local-credential'), 'utf8')).trim();
    const client = createHostClient(lock.listen, {
      clientId: `ghsub-it-${randomUUID()}`, clientType: 'cli', localCredential: () => credential || undefined, reconnect: { enabled: true },
    });
    await client.connect();
    return { client, paseo: createPaseoApi(client), mcp: { url: `http://${lock.listen}/mcp/agents`, token: credential } };
  }

  async readText(path: string): Promise<string> {
    return readFile(join(this.home, path), 'utf8');
  }

  async cleanup(): Promise<{ stopped: boolean; removed: boolean }> {
    this.guard();
    let stopped = false;
    if (this.ownsDaemon) {
      try { await this.cli(['daemon', 'stop'], 40_000); stopped = true; } catch { stopped = false; }
    }
    await rm(this.base, { recursive: true, force: true });
    return { stopped, removed: true };
  }
}

export interface McpSession { call(method: string, params?: unknown): Promise<unknown> }

export function mcpSession(endpoint: { url: string; token: string }, agentId: string): McpSession {
  let session: string | null = null;
  let counter = 0;
  const post = async (body: unknown, expectResult: boolean): Promise<unknown> => {
    const response = await fetch(`${endpoint.url}?callerAgentId=${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}`,
        ...session ? { 'mcp-session-id': session } : {},
      },
      body: JSON.stringify(body),
    });
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
    if (!expectResult || !text) return null;
    const data = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).at(-1) ?? '{}'
      : text;
    const message = JSON.parse(data) as { result?: unknown; error?: { message?: string } };
    if (message.error) throw new Error(`MCP 错误：${message.error.message}`);
    return message.result;
  };
  const ready = (async () => {
    await post({ jsonrpc: '2.0', id: ++counter, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ghsub-it', version: '1' } } }, true);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  })();
  return {
    async call(method, params) {
      await ready;
      return post({ jsonrpc: '2.0', id: ++counter, method, params: params ?? {} }, true);
    },
  };
}
