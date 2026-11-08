import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createSettingsStore } from '../server/core/settings-store.ts';

const Schema = z.strictObject({ enabled: z.boolean(), delay: z.number().int().min(0) });
const base = { enabled: true, delay: 0 };

test('没有文件时用默认值；写入后与默认值合并，文件权限 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const path = join(dir, 'nested', 'settings.json');
    const store = createSettingsStore(path, Schema.partial(), base);
    assert.deepEqual(store.read(), base);
    assert.deepEqual(store.update({ delay: 5 }), { enabled: true, delay: 5 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { delay: 5 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(createSettingsStore(path, Schema.partial(), base).read(), { enabled: true, delay: 5 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('默认值变化时没写过的项跟着变；写过的项保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const path = join(dir, 'settings.json');
    createSettingsStore(path, Schema.partial(), base).update({ enabled: false });
    const store = createSettingsStore(path, Schema.partial(), { enabled: true, delay: 9 });
    assert.deepEqual(store.read(), { enabled: false, delay: 9 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('文件损坏或不合法时回到默认值并给出错误，不覆盖原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{坏');
    const store = createSettingsStore(path, Schema.partial(), base);
    assert.deepEqual(store.read(), base);
    assert.match(store.error() ?? '', /无法解析/);
    assert.equal(readFileSync(path, 'utf8'), '{坏');
    writeFileSync(path, JSON.stringify({ delay: -1 }));
    const invalid = createSettingsStore(path, Schema.partial(), base);
    assert.deepEqual(invalid.read(), base);
    assert.match(invalid.error() ?? '', /delay/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('写入不合法的值时抛错，内存和文件都不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const store = createSettingsStore(join(dir, 's.json'), Schema.partial(), base);
    assert.throws(() => store.update({ delay: -3 }));
    assert.deepEqual(store.read(), base);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
