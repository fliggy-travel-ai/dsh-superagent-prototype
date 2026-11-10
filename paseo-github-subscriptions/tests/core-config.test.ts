import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { resolveInstance } from '../shared/instances.ts';

const sections = { agentDefaults: { schema: z.array(z.strictObject({ provider: z.string() })), fallback: [] as { provider: string }[] } };
const reader = (text: string | Error) => () => { if (text instanceof Error) throw text; return text; };
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

test('没有 machine.json 时使用默认值，没有错误', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader(missing));
  assert.equal(loaded.source, 'default');
  assert.deepEqual(loaded.modules, {});
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.section('agentDefaults'), { ok: true, value: [] });
});

test('合法配置按区块解析，模块开关生效', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader(JSON.stringify({ version: 1, machine: 'macmini', modules: { 'providers.defaults': true }, agentDefaults: [{ provider: 'codex' }] })));
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.machine, 'macmini');
  assert.deepEqual(loaded.modules, { 'providers.defaults': true });
  assert.deepEqual(loaded.section('agentDefaults'), { ok: true, value: [{ provider: 'codex' }] });
  assert.deepEqual(loaded.errors, []);
});

test('JSON 无法解析时所有区块报错，模块开关回到默认', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader('{ broken'));
  assert.equal(loaded.source, 'file');
  assert.deepEqual(loaded.modules, {});
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0]!, /无法解析/);
  const section = loaded.section('agentDefaults');
  assert.equal(section.ok, false);
});

test('版本不对时整体报错', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader(JSON.stringify({ version: 2 })));
  assert.match(loaded.errors[0]!, /version/);
  assert.equal(loaded.section('agentDefaults').ok, false);
});

test('一个区块不合法只影响这个区块', () => {
  const loaded = loadMachineConfig('/x/machine.json', { ...sections, other: { schema: z.strictObject({ a: z.number() }), fallback: { a: 1 } } },
    reader(JSON.stringify({ version: 1, agentDefaults: [{ provider: 3 }], other: { a: 2 } })));
  assert.equal(loaded.section('agentDefaults').ok, false);
  assert.deepEqual(loaded.section('other'), { ok: true, value: { a: 2 } });
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0]!, /agentDefaults/);
});

test('modules 不合法时报错并回到默认开关', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader(JSON.stringify({ version: 1, modules: { a: 'yes' } })));
  assert.deepEqual(loaded.modules, {});
  assert.match(loaded.errors[0]!, /modules/);
  assert.deepEqual(loaded.section('agentDefaults'), { ok: true, value: [] });
});

test('未登记的区块不报错，留给后续模块扩展；旧 machine.json 里的 answer.automation 兼容忽略', () => {
  const loaded = loadMachineConfig(
    '/x/machine.json',
    sections,
    reader(
      JSON.stringify({
        version: 1,
        modules: { 'answer.automation': true, 'providers.defaults': true },
        automation: { paused: false, policies: [] },
        future: { x: 1 },
      }),
    ),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.modules['providers.defaults'], true);
});

test('读取失败（非缺失）时报错且不泄露文件内容', () => {
  const loaded = loadMachineConfig('/x/machine.json', sections, reader(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })));
  assert.match(loaded.errors[0]!, /无法读取/);
  assert.equal(loaded.section('agentDefaults').ok, false);
});

test('角色解析：缺角色文件按 main 处理并保留 Provider', () => {
  assert.deepEqual(resolveInstance(null), { role: 'main', legacy: true, hostsProviders: true, hostsUi: true, stateSubdirectory: null });
  assert.deepEqual(resolveInstance('main'), { role: 'main', legacy: false, hostsProviders: false, hostsUi: true, stateSubdirectory: null });
  assert.deepEqual(resolveInstance('provider'), { role: 'provider', legacy: false, hostsProviders: true, hostsUi: false, stateSubdirectory: 'providers' });
});
