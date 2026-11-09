import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumeService } from '../server/modules/usage-claude-accounts/resume.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'resume-default-'));
  // 启动时会通过 paseo 命令行扫描已有会话：给一个什么都不返回的假命令。
  const cli = join(dir, 'paseo-cli'); writeFileSync(cli, '#!/bin/sh\necho "[]"\n'); chmodSync(cli, 0o755);
  const previous = process.env.PASEO_CLI; process.env.PASEO_CLI = cli;
  return { dir, done: () => { rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = previous; } };
}

test('默认关：没选择过的会话不自动继续，选择开启后才会', () => {
  const { dir, done } = setup();
  try {
    const service = new ResumeService({ directory: dir });
    assert.equal(service.isEnabled('a'), false);
    service.setEnabled('a', true);
    assert.equal(service.isEnabled('a'), true);
    assert.equal(service.isEnabled('b'), false);
  } finally { done(); }
});

test('默认开：没选择过的会话（含新会话）自动继续，单独关闭的会话保持关闭', () => {
  const { dir, done } = setup();
  try {
    const service = new ResumeService({ directory: dir, autoResumeDefault: () => true });
    assert.equal(service.isEnabled('new-session'), true);
    service.setEnabled('a', false);
    assert.equal(service.isEnabled('a'), false);
    assert.equal(service.isEnabled('new-session'), true);
  } finally { done(); }
});

test('选择在默认值变化后保留：默认开时明确开启的会话，默认改成关后仍开启', () => {
  const { dir, done } = setup();
  try {
    let fallback = true;
    const service = new ResumeService({ directory: dir, autoResumeDefault: () => fallback });
    service.setEnabled('keep-on', true);
    service.setEnabled('keep-off', false);
    fallback = false;
    assert.equal(service.isEnabled('keep-on'), true);
    assert.equal(service.isEnabled('other'), false);
    fallback = true;
    assert.equal(service.isEnabled('keep-off'), false);
  } finally { done(); }
});

test('选择写入开启和关闭两个文件，重启后读回；归档会话清掉它的选择', async () => {
  const { dir, done } = setup();
  try {
    const first = new ResumeService({ directory: dir, autoResumeDefault: () => true });
    first.setEnabled('on', true); first.setEnabled('off', false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'enabled-agents.json'), 'utf8')), ['on']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'disabled-agents.json'), 'utf8')), ['off']);
    const second = new ResumeService({ directory: dir, autoResumeDefault: () => true });
    await second.start(); second.stop();
    assert.equal(second.isEnabled('on'), true);
    assert.equal(second.isEnabled('off'), false);
    assert.deepEqual(second.explicitCounts(), { enabled: 1, disabled: 1 });
    await second.forget('off');
    assert.equal(second.isEnabled('off'), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'disabled-agents.json'), 'utf8')), []);
  } finally { done(); }
});
