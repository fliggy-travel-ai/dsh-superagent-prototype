import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { describeCron, parseScheduleInput } from '../shared/schedule-input.ts';
import { createHeartbeatService } from '../server/modules/heartbeats/heartbeats.ts';
import { createHeartbeatStore } from '../client/heartbeats/store.ts';
import { createHeartbeatPills } from '../client/heartbeats/pills.ts';

function satisfiesRange(version: string, range: string): boolean {
  // 按标准 npm semver 规则核验我们的联合区间表达式（含预发布标签比较）。
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!m) throw new Error(`bad version: ${v}`);
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      prerelease: m[4] ? m[4].split('.') : [],
    };
  };
  const compareIdentifiers = (a: string, b: string) => {
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1;
    if (bn) return 1;
    return a.localeCompare(b);
  };
  const compare = (left: string, right: string) => {
    const a = parse(left);
    const b = parse(right);
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
    if (a.prerelease.length === 0) return 1;
    if (b.prerelease.length === 0) return -1;
    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
      if (i >= a.prerelease.length) return -1;
      if (i >= b.prerelease.length) return 1;
      const diff = compareIdentifiers(a.prerelease[i]!, b.prerelease[i]!);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  const v = parse(version);
  return range.split('||').some(branch => {
    const comparators = branch.trim().split(/\s+/);
    if (v.prerelease.length > 0) {
      const hasMatchingTuplePrerelease = comparators.some(comp => {
        const target = comp.replace(/^(>=|<=|>|<|=)/, '');
        const t = parse(target);
        return (
          t.prerelease.length > 0 &&
          t.major === v.major &&
          t.minor === v.minor &&
          t.patch === v.patch
        );
      });
      if (!hasMatchingTuplePrerelease) return false;
    }
    return comparators.every(comp => {
      if (comp.startsWith('>=')) return compare(version, comp.slice(2)) >= 0;
      if (comp.startsWith('<=')) return compare(version, comp.slice(2)) <= 0;
      if (comp.startsWith('>')) return compare(version, comp.slice(1)) > 0;
      if (comp.startsWith('<')) return compare(version, comp.slice(1)) < 0;
      return compare(version, comp) === 0;
    });
  });
}

test('paseo-plugin.json 版本范围同时兼容 Paseo 0.15.x、0.16.0-beta.x 与 0.16.x 正式版', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../paseo-plugin.json', import.meta.url), 'utf8'),
  ) as { requirements?: { paseo?: string } };
  const range = manifest.requirements?.paseo ?? '';
  assert.equal(range, '>=0.15.0 <0.16.0 || >=0.16.0-0 <0.17.0');
  for (const ok of ['0.15.0', '0.15.4', '0.16.0-0', '0.16.0-beta.1', '0.16.0-rc.2', '0.16.0', '0.16.3']) {
    assert.equal(satisfiesRange(ok, range), true, `应当兼容 ${ok}`);
  }
  for (const bad of ['0.14.9', '0.15.0-beta.1', '0.17.0-beta.1', '0.17.0']) {
    assert.equal(satisfiesRange(bad, range), false, `不应当匹配 ${bad}`);
  }
});

test('parseScheduleInput：支持中英文短语、单次延迟、五段式 Cron，并拒绝 Paseo 0.16 禁止的单数字步长', () => {
  const now = new Date('2026-11-11T08:00:10.000Z');
  const once = parseScheduleInput('15m', now);
  assert.equal(once.oneShot, true);
  assert.equal(once.timezone, 'UTC');
  assert.equal(once.cron, '16 8 11 11 *');

  const onceZh = parseScheduleInput('15 分钟后', now);
  assert.equal(onceZh.oneShot, true);
  assert.equal(onceZh.cron, '16 8 11 11 *');

  const recurringEn = parseScheduleInput('every 15 minutes', now);
  assert.equal(recurringEn.oneShot, false);
  assert.equal(recurringEn.cron, '*/15 * * * *');
  assert.equal(recurringEn.description, '每 15 分钟');

  const recurringZh = parseScheduleInput('每 30 分钟', now);
  assert.equal(recurringZh.cron, '*/30 * * * *');
  assert.equal(describeCron(recurringZh.cron), '每 30 分钟');

  const rangeStep = parseScheduleInput('0-45/15 * * * *', now);
  assert.equal(rangeStep.cron, '0-45/15 * * * *');

  assert.throws(
    () => parseScheduleInput('0/15 * * * *', now),
    /不支持单数字步长/,
  );
});

test('createHeartbeatService：读取计数与列表，并通过 CLI 创建、修改、替换及删除代理心跳', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hb-service-'));
  const schedulesDir = join(home, 'schedules');
  await mkdir(schedulesDir, { recursive: true });

  const calls: Array<{ agentId: string; args: string[] }> = [];
  let seq = 1;

  const writeSchedule = async (id: string, record: Record<string, unknown>) => {
    await writeFile(join(schedulesDir, `${id}.json`), JSON.stringify(record, null, 2));
  };

  await writeSchedule('done-1', {
    id: 'done-1',
    name: null,
    prompt: '已完成任务',
    cadence: { type: 'cron', expression: '*/5 * * * *' },
    target: { type: 'agent', agentId: 'agent-a' },
    status: 'completed',
    createdAt: '2026-11-11T01:00:00.000Z',
    updatedAt: '2026-11-11T01:05:00.000Z',
    nextRunAt: null,
    lastRunAt: '2026-11-11T01:05:00.000Z',
    expiresAt: null,
    maxRuns: 1,
    runs: [{ id: 'r1' }],
  });

  await writeSchedule('new-agent-1', {
    id: 'new-agent-1',
    name: '独立计划',
    prompt: '新建代理运行',
    cadence: { type: 'cron', expression: '0 9 * * *' },
    target: { type: 'new-agent', config: {} },
    status: 'active',
    createdAt: '2026-11-11T01:00:00.000Z',
    updatedAt: '2026-11-11T01:00:00.000Z',
    nextRunAt: '2026-11-12T09:00:00.000Z',
    lastRunAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
  });

  const service = createHeartbeatService({
    home,
    async runPaseo(agentId, args) {
      calls.push({ agentId, args });
      const sub = args[1];
      if (sub === 'create') {
        const id = `hb-${seq++}`;
        const cronIdx = args.indexOf('--cron');
        const tzIdx = args.indexOf('--timezone');
        const maxIdx = args.indexOf('--max-runs');
        const nameIdx = args.indexOf('--name');
        const sepIdx = args.indexOf('--');
        await writeSchedule(id, {
          id,
          name: nameIdx >= 0 ? args[nameIdx + 1]! : null,
          prompt: args[sepIdx + 1]!,
          cadence: {
            type: 'cron',
            expression: args[cronIdx + 1]!,
            ...(tzIdx >= 0 ? { timezone: args[tzIdx + 1]! } : {}),
          },
          target: { type: 'agent', agentId },
          status: 'active',
          createdAt: `2026-11-11T02:00:0${seq}.000Z`,
          updatedAt: `2026-11-11T02:00:0${seq}.000Z`,
          nextRunAt: '2026-11-11T02:15:00.000Z',
          lastRunAt: null,
          expiresAt: null,
          maxRuns: maxIdx >= 0 ? Number(args[maxIdx + 1]!) : null,
          runs: [],
        });
        return JSON.stringify({ id });
      }
      if (sub === 'update') {
        const id = args[2]!;
        const raw = JSON.parse(await readFile(join(schedulesDir, `${id}.json`), 'utf8'));
        const cronIdx = args.indexOf('--cron');
        const tzIdx = args.indexOf('--timezone');
        raw.cadence = {
          type: 'cron',
          expression: args[cronIdx + 1]!,
          ...(tzIdx >= 0 ? { timezone: args[tzIdx + 1]! } : {}),
        };
        await writeSchedule(id, raw);
        return JSON.stringify({ id });
      }
      if (sub === 'delete') {
        const id = args[2]!;
        await unlink(join(schedulesDir, `${id}.json`));
        return JSON.stringify({ deleted: true });
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });

  try {
    // 初始只有已完成计划和 new-agent 计划：有效代理心跳数为 0
    assert.deepEqual(await service.readHeartbeatCounts(), { counts: [] });

    // 创建心跳
    const created = await service.addHeartbeat({
      agentId: 'agent-a',
      prompt: '检查 CI 状态',
      cron: '*/15 * * * *',
      timezone: null,
      maxRuns: null,
    });
    assert.equal(created.heartbeats.length, 1);
    assert.equal(created.heartbeats[0]!.id, 'hb-1');
    assert.deepEqual(await service.readHeartbeatCounts(), {
      counts: [{ agentId: 'agent-a', count: 1 }],
    });

    // 只改频率：原地调用 heartbeat update
    const updatedCadence = await service.editHeartbeat({
      id: 'hb-1',
      agentId: 'agent-a',
      prompt: '检查 CI 状态',
      cron: '*/30 * * * *',
      timezone: 'Asia/Shanghai',
      maxRuns: null,
    });
    assert.equal(updatedCadence.heartbeats[0]!.id, 'hb-1');
    assert.equal(updatedCadence.heartbeats[0]!.cron, '*/30 * * * *');
    assert.equal(updatedCadence.heartbeats[0]!.timezone, 'Asia/Shanghai');

    // 修改提示词：新建替换并删除旧心跳
    const replaced = await service.editHeartbeat({
      id: 'hb-1',
      agentId: 'agent-a',
      prompt: '检查 PR 评审与 CI 状态',
      cron: '*/30 * * * *',
      timezone: 'Asia/Shanghai',
      maxRuns: 3,
    });
    assert.equal(replaced.heartbeats.length, 1);
    assert.equal(replaced.heartbeats[0]!.id, 'hb-2');
    assert.equal(replaced.heartbeats[0]!.prompt, '检查 PR 评审与 CI 状态');
    assert.equal(replaced.heartbeats[0]!.maxRuns, 3);

    // 跨代理删除被拒绝
    await assert.rejects(
      service.removeHeartbeat({ id: 'hb-2', agentId: 'agent-other' }),
      /不属于当前代理/,
    );

    // 删除心跳后计数清空
    const afterDelete = await service.removeHeartbeat({ id: 'hb-2', agentId: 'agent-a' });
    assert.deepEqual(afterDelete.heartbeats, []);
    assert.deepEqual(await service.readHeartbeatCounts(), { counts: [] });
    assert.ok(calls.length >= 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('客户端心跳气泡、代理范围命令与心跳面板：数量为 0 不显示气泡，>=1 显示并可增删改', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const { createPreview } = await import('./ui/host.tsx');

  const { handle } = createPreview({
    scene: 'shadow',
    layout: 'wide',
    theme: 'dark',
    route: 'agent:agent-main',
  });
  handle.daemon.latencyMs = 0;

  try {
    await new Promise(resolve => setTimeout(resolve, 60));

    // 1. 面板与代理范围命令已注册
    assert.ok(handle.registry.agentPanels.has('heartbeats'));
    const cmd = handle.registry.commands.get('open-heartbeats');
    assert.ok(cmd, '应注册打开心跳面板命令');
    assert.equal(cmd.title, '打开心跳面板');
    assert.equal(cmd.context, 'agent');

    let openedByCommand: string | null = null;
    await cmd.onSelect({ openPanel: (id: string) => { openedByCommand = id; } });
    assert.equal(openedByCommand, 'heartbeats');

    // 2. 初始心跳数量为 0 时，不注册 heartbeats 气泡
    const heartbeatPillsBefore = [...handle.registry.pills.values()].filter(p => p.id === 'heartbeats');
    assert.equal(heartbeatPillsBefore.length, 0, '心跳数量为 0 时不应显示心跳气泡');

    // 3. 通过独立 store + pills 验证数量变化时气泡的动态增删与点击打开面板
    const store = createHeartbeatStore({
      rpc: (contract, input) => handle.daemon.rpc(contract, input) as never,
    });
    const opened: Array<{ id: string; workspaceId?: string; agentId?: string }> = [];
    const pills = createHeartbeatPills(
      {
        paseo: {
          agents: {
            ref: (agentId: string) => ({
              id: agentId,
              workspaceId: 'ws-main',
              refresh: async () => undefined,
            }),
          },
        } as never,
        addComposerPill: entry => handle.registry.addPill(entry as never) as never,
        openPanel: (id, opts) => opened.push({ id, ...opts }),
      },
      store,
    );

    try {
      await store.refreshCounts();
      assert.equal(
        [...handle.registry.pills.values()].filter(p => p.id === 'heartbeats').length,
        0,
      );

      // 新建第 1 个心跳后气泡立即出现，label 为 "1"
      const created = await store.create({
        agentId: 'agent-main',
        prompt: '每 15 分钟巡检构建结果',
        cron: '*/15 * * * *',
        timezone: null,
        maxRuns: null,
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      const activePills = [...handle.registry.pills.values()].filter(p => p.id === 'heartbeats');
      assert.equal(activePills.length, 1);
      assert.equal(activePills[0]!.button.label, '1');
      assert.equal(activePills[0]!.button.behavior.kind, 'action');
      if (activePills[0]!.button.behavior.kind === 'action') {
        await activePills[0]!.button.behavior.onPress();
      }
      assert.deepEqual(opened, [{ id: 'heartbeats', workspaceId: 'ws-main', agentId: 'agent-main' }]);

      // 新建第 2 个心跳后气泡数字更新为 "2"
      const second = await store.create({
        agentId: 'agent-main',
        prompt: '每小时汇总一次进度',
        cron: '0 * * * *',
        timezone: null,
        maxRuns: 5,
      });
      assert.equal(
        [...handle.registry.pills.values()].find(p => p.id === 'heartbeats')?.button.label,
        '2',
      );

      // 修改第 1 个心跳
      await store.update({
        id: created.heartbeats[0]!.id,
        agentId: 'agent-main',
        prompt: '每 30 分钟巡检构建结果',
        cron: '*/30 * * * *',
        timezone: null,
        maxRuns: null,
      });
      assert.equal(store.getAgentView('agent-main').heartbeats[0]!.cron, '*/30 * * * *');

      // 渲染面板组件校验中文标题与卡片内容不会抛错
      const { createHeartbeatsPanel } = await import('../client/heartbeats/panel.tsx');
      const PanelComponent = createHeartbeatsPanel(store);
      const element = React.createElement(PanelComponent, {
        theme: {
          colors: {
            surface0: '#151517',
            surface1: '#1c1c1f',
            surface2: '#2b2b2f',
            border: '#303035',
            foreground: '#ececef',
            foregroundMuted: '#8e8e95',
            accent: '#5b8cff',
            accentForeground: '#ffffff',
            statusSuccess: '#4cc274',
            statusWarning: '#e3a33b',
            statusDanger: '#ff6b66',
          },
        } as never,
        host: { id: 'fixture', label: '预览主机' },
        layout: { compact: false, platform: 'web' },
        workspaceId: 'ws-main',
        agentId: 'agent-main',
        params: { agentId: 'agent-main' },
        context: 'agent',
        revision: 1,
        tab: { state: undefined, setModified: () => {}, setState: () => {} },
      });
      assert.ok(element);

      // 删除全部心跳后气泡立即移除
      for (const item of second.heartbeats) {
        await store.remove({ id: item.id, agentId: 'agent-main' });
      }
      assert.equal(
        [...handle.registry.pills.values()].filter(p => p.id === 'heartbeats').length,
        0,
        '心跳全部删除后气泡应立即消失',
      );
    } finally {
      pills.dispose();
      store.dispose();
    }
  } finally {
    handle.dispose();
  }
});
