import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { registerMachineSettingsRpcs } from '../server/core/machine-settings-rpc.ts';

test('模块开关保存后返回，再发起插件重载；非法配置不写入也不重载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'module-switch-'));
  try {
    const path = join(dir, 'machine.json');
    await writeFile(path, JSON.stringify({ version: 1, modules: { 'answer.presence': true, github: false } }));
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = { handle: (contract: { name: string }, handler: (input: any) => Promise<any>) => handlers.set(contract.name, handler) };
    const host = { status: () => ({ modules: [] }) };
    let calls = 0;
    registerMachineSettingsRpcs({ server: server as never, machine: loadMachineConfig(path, {}), host: host as never,
      services: { main: null, daemon: { ready: async () => ({ client: { reloadPlugin: async (id: string) => {
        assert.equal(id, 'github-subscriptions');
        calls++; assert.equal(JSON.parse(await readFile(path, 'utf8')).modules['answer.presence'], false);
      } } }) } } as never, stateDirectory: dir, baseDirectory: dir });
    const result = await handlers.get('machine.settings.toggle-module')!({ id: 'answer.presence', enabled: false });
    assert.equal(result.modules.find((m: any) => m.id === 'answer.presence').enabled, false);
    assert.equal(calls, 0);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).modules.github, false);
    await writeFile(path, '{invalid');
    await assert.rejects(handlers.get('machine.settings.toggle-module')!({ id: 'answer.presence', enabled: true }));
    assert.equal(await readFile(path, 'utf8'), '{invalid');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('浏览器模块关闭时更新内部开关，不提前启动桥接；损坏的状态文件不会被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'module-browser-'));
  try {
    const path = join(dir, 'machine.json');
    const browserPath = join(dir, 'browser-state.json');
    await writeFile(path, JSON.stringify({ version: 1, modules: { 'answer.browser': false } }));
    await writeFile(browserPath, JSON.stringify({ settings: { enabled: false, port: 17373 }, bindings: [], approvals: [] }));
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = { handle: (contract: { name: string }, handler: (input: any) => Promise<any>) => handlers.set(contract.name, handler) };
    const host = { status: () => ({ modules: [{ id: 'answer.browser', state: 'off' }] }) };
    let started = false;
    registerMachineSettingsRpcs({ server: server as never, machine: loadMachineConfig(path, {}), host: host as never,
      services: { main: { readyBrowser: () => { started = true; throw new Error('不应启动'); } }, daemon: {} } as never,
      stateDirectory: dir, baseDirectory: dir, reload: async () => {} });
    await handlers.get('machine.settings.toggle-module')!({ id: 'answer.browser', enabled: true });
    assert.equal(started, false);
    assert.equal(JSON.parse(await readFile(browserPath, 'utf8')).settings.enabled, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).modules['answer.browser'], true);
    await writeFile(browserPath, '[]');
    await assert.rejects(handlers.get('machine.settings.toggle-module')!({ id: 'answer.browser', enabled: false }));
    assert.equal(await readFile(browserPath, 'utf8'), '[]');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).modules['answer.browser'], true);
    await new Promise(resolve => setTimeout(resolve, 600));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
