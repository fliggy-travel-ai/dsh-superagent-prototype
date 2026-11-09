import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyLegacyFiles } from '../server/core/legacy-copy.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-'));
  const from = join(root, 'old'); const to = join(root, 'new');
  mkdirSync(from);
  return { root, from, to, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('只复制不移动：旧文件保持原样，新文件权限 0600', () => {
  const { from, to, done } = setup();
  try {
    writeFileSync(join(from, 'jobs.json'), '[1]', { mode: 0o644 });
    const report = copyLegacyFiles(from, to, [{ from: 'jobs.json' }]);
    assert.deepEqual(report.copied, ['jobs.json']);
    assert.equal(readFileSync(join(from, 'jobs.json'), 'utf8'), '[1]');
    assert.equal(readFileSync(join(to, 'jobs.json'), 'utf8'), '[1]');
    assert.equal(statSync(join(to, 'jobs.json')).mode & 0o777, 0o600);
  } finally { done(); }
});

test('目标已有文件时不覆盖；源不存在时记为缺失；可以改名', () => {
  const { from, to, done } = setup();
  try {
    writeFileSync(join(from, 'a.json'), 'old');
    writeFileSync(join(from, 'b.json'), 'bee');
    mkdirSync(to);
    writeFileSync(join(to, 'a.json'), 'mine');
    const report = copyLegacyFiles(from, to, [{ from: 'a.json' }, { from: 'missing.json' }, { from: 'b.json', to: 'renamed.json' }]);
    assert.equal(readFileSync(join(to, 'a.json'), 'utf8'), 'mine');
    assert.deepEqual(report.skipped, [{ path: 'a.json', reason: '目标已存在' }]);
    assert.deepEqual(report.missing, ['missing.json']);
    assert.deepEqual(report.copied, ['b.json → renamed.json']);
  } finally { done(); }
});

test('目录整个复制（含子目录），可重复运行', () => {
  const { from, to, done } = setup();
  try {
    mkdirSync(join(from, 'renewal', 'deep'), { recursive: true });
    writeFileSync(join(from, 'renewal', 'deep', 'x.txt'), 'x');
    copyLegacyFiles(from, to, [{ from: 'renewal', directory: true }]);
    assert.equal(readFileSync(join(to, 'renewal', 'deep', 'x.txt'), 'utf8'), 'x');
    const again = copyLegacyFiles(from, to, [{ from: 'renewal', directory: true }]);
    assert.deepEqual(again.copied, []);
    assert.equal(existsSync(join(from, 'renewal', 'deep', 'x.txt')), true);
  } finally { done(); }
});

test('旧目录不存在时不报错；拒绝越出目录的路径', () => {
  const { root, to, done } = setup();
  try {
    assert.deepEqual(copyLegacyFiles(join(root, 'nope'), to, [{ from: 'a.json' }]).missing, ['a.json']);
    assert.throws(() => copyLegacyFiles(root, to, [{ from: '../x' }]), /越出/);
  } finally { done(); }
});
