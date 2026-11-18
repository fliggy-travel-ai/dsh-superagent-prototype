import assert from 'node:assert/strict';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Harness, pluginRoot } from './daemon-lib.ts';

const harness = await Harness.create({ fixtureUrl: 'http://127.0.0.1:1' });
let connection: Awaited<ReturnType<Harness['connect']>> | undefined;
try {
  await harness.stagePlugin();
  const fixture = join(harness.base, 'quota-fixture');
  await cp(join(pluginRoot, 'tests/fixtures/provider'), fixture, { recursive: true });
  await symlink(join(pluginRoot, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const manifestPath = join(fixture, 'paseo-plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.requirements.paseo = JSON.parse(await readFile(join(pluginRoot, 'paseo-plugin.json'), 'utf8')).requirements.paseo;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(fixture, 'index.server.ts'), `import { z } from 'zod';
import { fixtureProvider } from './server/provider.ts';
export default function(server) {
  server.registerProvider({ ...fixtureProvider(), id: 'fixture-empty' });
  server.registerProvider({ ...fixtureProvider(), id: 'fixture-ready' });
  server.registerUsageSource({
    id: 'codex-multi', label: 'Quota fixture', input: z.object({ remainingPct: z.number() }),
    discover: async () => [
      { key: 'fixture-empty', input: { remainingPct: 0 } },
      { key: 'fixture-ready', input: { remainingPct: 42 } },
    ],
    fetch: async ({ remainingPct }) => ({ status: 'available', windows: [{ id: 'weekly', label: 'Weekly', remainingPct }] }),
  });
  return () => {};
}`);
  await harness.startDaemon();
  assert.equal((await harness.cli<{ status: string }>(['plugin', 'install', fixture]))?.status, 'running');
  assert.equal((await harness.cli<{ status: string }>(['plugin', 'install', harness.stage]))?.status, 'running');
  connection = await harness.connect();
  const cwd = join(harness.base, 'work');
  await assert.rejects(connection.paseo.agents.create({ config: { provider: 'fixture-empty/deterministic' }, cwd, title: 'Quota fixture rejected' }),
    /fixture-empty.*0%.*本机额度可用账号：.*fixture-ready/);
  const allowed = await connection.paseo.agents.create({ config: { provider: 'fixture-ready/deterministic' }, cwd, title: 'Quota fixture accepted' });
  assert.ok(allowed.id);
  console.log('隔离 Paseo 守护进程拒绝 0% 会话，列出通过的备选账号，并允许创建 42% 会话。');
} finally {
  await connection?.client.close();
  await harness.cleanup();
}
