import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadMachineConfig, type SectionSpec } from '../server/core/machine-config.ts';
import { MODULES } from '../server/modules/index.ts';

test('仓库中的 machine.example.json 能通过全部模块的校验', () => {
  const sections: Record<string, SectionSpec> = {};
  for (const definition of MODULES) if (definition.config) sections[definition.config.section] = definition.config.spec;
  const loaded = loadMachineConfig(fileURLToPath(new URL('../config/machine.example.json', import.meta.url)), sections);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.source, 'file');
  for (const name of Object.keys(sections)) assert.equal(loaded.section(name).ok, true, name);
  for (const id of Object.keys(loaded.modules)) assert.ok(MODULES.some(definition => definition.id === id), `未知模块 ${id}`);
});
