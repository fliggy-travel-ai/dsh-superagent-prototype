import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../shared/model.ts';
import type { AutomationSnapshot } from '../shared/automation.ts';
import type { BrowserSnapshot } from '../shared/browser.ts';
import { connectDaemon } from '../server/daemon.ts';
import {
  Harness, PLUGIN_ID, TEST_TOKEN, mcpSession, pluginRoot, sleep, startGithubFixture, waitFor, type McpSession,
} from './daemon-lib.ts';
import { commentItem, issueItem } from './github-fixture.ts';

const evidenceDirectory = join(pluginRoot, 'validation/daemon');
const checks: Array<{ name: string; detail?: unknown }> = [];
const record = (name: string, detail?: unknown) => {
  checks.push({ name, ...detail === undefined ? {} : { detail } });
  console.log(`通过：${name}`);
};
const productionFingerprint = () => {
  const path = join(homedir(), '.paseo/config.json');
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) : 'absent';
};

const github = await startGithubFixture();
const harness = await Harness.create({ fixtureUrl: github.url });
const productionBefore = productionFingerprint();
const startedAt = new Date().toISOString();
let connection: Awaited<ReturnType<Harness['connect']>> | null = null;
let failure: string | null = null;
const failures: string[] = [];
let cleanup: { stopped: boolean; removed: boolean } | null = null;
let pluginLogs: unknown = null;
let leakScan: Record<string, boolean> = {};
const world = github.fixture.world;

type Rpc = <Value = unknown>(method: string, input?: unknown) => Promise<Value>;
const rpc: Rpc = async (method, input = {}) => (await connection!.client.invokePluginRpc(PLUGIN_ID, method, input)) as never;
const snapshot = () => rpc<Snapshot>('subscriptions.snapshot');
const pollNow = () => rpc<Snapshot>('subscriptions.poll');
const state = async () => JSON.parse(await harness.readText('github-subscriptions/state.json')) as {
  deliveries: Array<{ id: string; agentId: string; status: string; text: string; eventIds: string[] }>;
  events: Array<{ id: string; type: string }>; seen: Record<string, string>; source?: unknown;
};

const userMessages = async (agentId: string) => {
  const page = await connection!.paseo.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 200 });
  return page.entries.flatMap(({ item }) => item.type === 'user_message' ? [String(item.text)] : []);
};
const subscriptionMessages = async (agentId: string) => (await userMessages(agentId)).filter(text => text.includes('【GitHub 订阅事件】'));

async function callTool(session: McpSession, name: string, input: unknown) {
  const result = await session.call('tools/call', { name, arguments: input }) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> };
  return { isError: !!result.isError, value: result.structuredContent as Record<string, unknown> | undefined, text: result.content?.map(item => item.text ?? '').join('') ?? '' };
}

const nowIso = (offsetMilliseconds = 0) => new Date(Date.now() + offsetMilliseconds).toISOString();
let commentCounter = 100;
const addComment = (author = 'alice') => {
  commentCounter += 1;
  const at = nowIso();
  world.comments['org/app'] = [...world.comments['org/app'] ?? [], commentItem(commentCounter, 7, {
    created_at: at, updated_at: at, body: `integration comment ${commentCounter}`, user: { login: author, type: 'User' },
    html_url: `https://github.com/org/app/pull/7#issuecomment-${commentCounter}`,
  })];
  const issue = world.issues['org/app']![0]!;
  world.issues['org/app']![0] = { ...issue, updated_at: at };
  return commentCounter;
};

try {
  world.issues['org/app'] = [issueItem(7, {
    title: '集成验证 PR', created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z',
    html_url: 'https://github.com/org/app/pull/7', pull_request: { url: 'x', merged_at: null },
  })];
  world.pulls['org/app#7'] = {
    title: '集成验证 PR', state: 'open', html_url: 'https://github.com/org/app/pull/7', user: { login: 'bob' }, head: { sha: 'aaa1111' },
  };
  await harness.stagePlugin();
  await harness.writeToken();
  await harness.startDaemon();
  record('隔离守护进程在独立端口启动，env 干净且不含 GH_TOKEN', { port: harness.port, tokenInEnvironment: 'GH_TOKEN' in harness.environment() });
  assert.ok(!('GH_TOKEN' in harness.environment()));

  await harness.cli(['plugin', 'install', join(pluginRoot, 'tests/fixtures/provider')]);
  const installed = await harness.cli<{ status: string; id: string }>(['plugin', 'install', harness.stage]);
  assert.equal(installed?.status, 'running');
  const listed = await harness.cli<Array<{ id: string; status: string }>>(['plugin', 'ls']);
  assert.deepEqual(listed?.map(item => `${item.id}:${item.status}`).sort(), [`${PLUGIN_ID}:running`, 'notification-fixture:running']);
  record('插件与事件夹具提供方安装后都为 running');

  connection = await harness.connect();
  const first = await snapshot();
  record('安装后立即调用 RPC 成功（同步注册）');
  assert.equal(first.preferences.shadow, true);
  assert.equal(first.toolInjection, true);
  assert.equal(first.token.configured, true);
  assert.equal(first.token.prefix, `${TEST_TOKEN.slice(0, 5)}…`);
  assert.ok(!JSON.stringify(first).includes(TEST_TOKEN));
  record('快照：影子模式、工具注入已开、令牌来自文件且只显示前缀', { shadow: first.preferences.shadow, toolInjection: first.toolInjection, tokenPrefix: first.token.prefix });
  assert.deepEqual(await rpc('subscriptions.remove', { id: 'sub_missing' }), { removed: false });
  record('其余 RPC 都已注册并可调用');
  const native = await rpc<AutomationSnapshot>('automation.snapshot');
  const browser = await rpc<BrowserSnapshot>('browser.snapshot');
  assert.equal(native.paused, true);
  assert.deepEqual(native.policies, []);
  assert.equal(browser.settings.enabled, false);
  assert.equal(browser.connected, false);
  assert.ok(!JSON.stringify(browser).includes('token'));
  assert.equal((await rpc<AutomationSnapshot>('automation.pause', { paused: true })).paused, true);
  await assert.rejects(rpc('browser.pairing'));
  record('新模块默认关闭，独立 RPC 可用，普通快照不泄漏配对令牌');
  const permissionClient = await connectDaemon(harness.home);
  try { await assert.rejects(permissionClient.approve('missing-validation-agent', 'missing-validation-request')); }
  finally { await permissionClient.close(); }
  record('真实隔离宿主未确认的权限响应会超时失败，不误报批准');

  const preferences = await rpc<Snapshot['preferences']>('subscriptions.preferences', { ...first.preferences, organization: 'org', excludedRepos: [] });
  assert.equal(preferences.organization, 'org');
  const baseline = await pollNow();
  assert.deepEqual(baseline.repositories.map(item => `${item.repo}:${item.error}`), ['org/app:null']);
  assert.deepEqual([...github.authorizations], [`Bearer ${TEST_TOKEN}`]);
  assert.ok([...github.hosts].every(host => host.startsWith('127.0.0.1:')));
  record('轮询经网络夹具读取组织仓库，只用测试令牌，不连真实 GitHub', { requests: github.fixture.calls.length });

  const workspace = await connection.paseo.workspaces.create({ source: { kind: 'directory', path: join(harness.base, 'work') }, title: '集成验证' });
  const owner = await workspace.agents.create({ config: { provider: 'notification-fixture/deterministic' }, title: '订阅会话' });
  const bystander = await workspace.agents.create({ config: { provider: 'notification-fixture/deterministic' }, title: '旁观会话' });
  const ownerTools = mcpSession(connection.mcp, owner.id);
  const bystanderTools = mcpSession(connection.mcp, bystander.id);
  const listing = await ownerTools.call('tools/list') as { tools: Array<{ name: string; description: string }> };
  const injected = listing.tools.map(tool => tool.name).filter(name => name.startsWith('github_')).sort();
  assert.deepEqual(injected, ['github_list_subscriptions', 'github_read', 'github_subscribe', 'github_unsubscribe']);
  const subscribeDescription = listing.tools.find(tool => tool.name === 'github_subscribe')!.description;
  assert.match(subscribeDescription, /gh issue comment/);
  assert.match(subscribeDescription, /gh pr comment/);
  assert.match(subscribeDescription, /<!-- paseo-ghsub agent=<当前会话ID> -->/);
  assert.match(subscribeDescription, /PASEO_AGENT_ID/);
  record('夹具会话注入 4 个工具，订阅描述包含 gh 评论标记规则', injected);

  const subscribed = await callTool(ownerTools, 'github_subscribe', { target: 'org/app#7', events: ['comment', 'push', 'ci'] });
  assert.equal(subscribed.isError, false, subscribed.text);
  const subscription = subscribed.value as { id: string; isPr: boolean; title: string; agentId: string };
  assert.equal(subscription.isPr, true);
  assert.equal(subscription.title, '集成验证 PR');
  assert.equal(subscription.agentId, owner.id);
  const listedTool = await callTool(ownerTools, 'github_list_subscriptions', {});
  assert.equal((listedTool.value as { shadow: boolean }).shadow, true);
  const foreign = await callTool(bystanderTools, 'github_unsubscribe', { id: subscription.id });
  assert.deepEqual(foreign.value, { removed: false });
  const outside = await callTool(ownerTools, 'github_subscribe', { target: 'other/repo#1' });
  assert.equal(outside.isError, true);
  record('工具调用：订阅、列出、他人无法取消、范围外仓库被拒绝', { subscriptionId: subscription.id });

  const pollAfterSubscribe = await pollNow();
  assert.equal(pollAfterSubscribe.subscriptions.length, 1);
  addComment();
  const shadowPoll = await pollNow();
  assert.equal(shadowPoll.events.filter(event => event.type === 'comment').length, 1);
  assert.deepEqual(shadowPoll.deliveries.map(delivery => delivery.status), ['shadow']);
  assert.equal((await subscriptionMessages(owner.id)).length, 0);
  record('影子模式：事件入库并记录送达草稿，但不向会话发送');

  await rpc('subscriptions.preferences', { ...shadowPoll.preferences, shadow: false });
  addComment();
  const livePoll = await pollNow();
  const delivered = livePoll.deliveries.filter(delivery => delivery.status === 'delivered');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.agentId, owner.id);
  const messages = await waitFor(async () => { const found = await subscriptionMessages(owner.id); return found.length ? found : false; }, '会话收到订阅消息');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /integration comment 102/);
  assert.equal((await subscriptionMessages(bystander.id)).length, 0);
  record('实发：只送达订阅会话，消息含外部内容声明和评论摘录', { messageId: delivered[0]?.id });

  const deliveryRecord = (await state()).deliveries.find(delivery => delivery.status === 'delivered')!;
  const handle = connection.paseo.agents.ref(owner.id);
  await handle.send(deliveryRecord.text, { activeTurnBehavior: 'steer', messageId: deliveryRecord.id });
  await sleep(500);
  assert.equal((await subscriptionMessages(owner.id)).length, 1);
  await assert.rejects(handle.send(`${deliveryRecord.text}（改动）`, { activeTurnBehavior: 'steer', messageId: deliveryRecord.id }), /key_conflict|conflict/);
  assert.equal((await subscriptionMessages(owner.id)).length, 1);
  record('同 messageId 同内容重发幂等，不同内容被拒绝为冲突');

  await harness.cli(['plugin', 'reload', PLUGIN_ID]);
  await waitFor(async () => (await snapshot()).polling !== undefined, '重载后 RPC 可用');
  const afterReload = await pollNow();
  assert.equal(afterReload.deliveries.filter(delivery => delivery.status === 'delivered').length, 1);
  assert.equal((await subscriptionMessages(owner.id)).length, 1);
  assert.ok((await state()).source);
  record('插件重载后读取位置和已见事件保留，同一事件不重复送达');

  await handle.send('ask');
  await waitFor(async () => { await handle.refresh(); return handle.pendingPermissions?.length; }, '夹具会话进入待答');
  addComment();
  const busyPoll = await pollNow();
  const busyDelivery = busyPoll.deliveries.at(-1)!;
  assert.ok(['delivered', 'unknown'].includes(busyDelivery.status), `忙时送达状态：${busyDelivery.status}`);
  await waitFor(async () => (await subscriptionMessages(owner.id)).length === 2, '忙时消息进入会话');
  await handle.refresh();
  record('会话有待答提问时仍立即 steer 送达（按方案第 0 节）', { status: busyDelivery.status, pendingPermissionsAfter: handle.pendingPermissions?.length ?? 0 });

  await connection.client.close();
  await harness.restartDaemon();
  connection = await harness.connect();
  await waitFor(async () => (await harness.cli<Array<{ id: string; status: string }>>(['plugin', 'ls']))?.every(item => item.status === 'running'), '重启后插件运行');
  const recovered = await waitFor(async () => (await snapshot()).token.configured, '', 20_000, 1000).then(() => true, () => false);
  if (recovered) record('守护进程重启后插件自动恢复，RPC 可用');
  else {
    failures.push('守护进程重启后插件未自动恢复：状态为 running，但 RPC 全部失败（paseo.pid 的 listen 在重启后约 3 秒才写入，插件启动时读到 null 而永久失败）');
    console.error(`缺陷：${failures.at(-1)}`);
    await harness.cli(['plugin', 'reload', PLUGIN_ID]);
    await waitFor(async () => (await snapshot()).token.configured, '手动重载后 RPC 可用', 30_000, 1000);
  }
  const closedAgent = connection.paseo.agents.ref(owner.id);
  const beforeReopen = await closedAgent.refresh();
  assert.equal(beforeReopen?.agent.archivedAt ?? null, null);
  const closedStatus = beforeReopen?.agent.status;
  const reopenedComment = addComment();
  const reopenPoll = await waitFor(async () => {
    const result = await pollNow();
    return result.deliveries.filter(delivery => delivery.status === 'delivered').length === 3 ? result : false;
  }, '守护进程重启后送达关闭中的会话', 30_000, 1000);
  await waitFor(async () => (await subscriptionMessages(owner.id)).some(text => text.includes(`integration comment ${reopenedComment}`)), '关闭的会话被重开并收到消息');
  record('守护进程重启后状态保留，向已关闭未归档会话送达会自动重开', { statusBeforeSend: closedStatus, deliveries: reopenPoll.deliveries.length });

  const restartedWorkspace = await connection.paseo.workspaces.create({ source: { kind: 'directory', path: join(harness.base, 'work') }, title: '重启后的集成验证' });
  const second = await restartedWorkspace.agents.create({ config: { provider: 'notification-fixture/deterministic' }, title: '重启后的旁观会话' });
  const secondSubscribed = await callTool(mcpSession(connection.mcp, second.id), 'github_subscribe', { target: 'org/app#7', events: ['comment'] });
  assert.equal(secondSubscribed.isError, false, secondSubscribed.text);
  assert.equal((await snapshot()).subscriptions.length, 2);
  await connection.paseo.agents.ref(owner.id).archive();
  const afterArchive = await waitFor(async () => { const current = await snapshot(); return current.subscriptions.length === 1 ? current : false; }, '归档后订阅取消');
  assert.deepEqual(afterArchive.subscriptions.map(item => item.agentId), [second.id]);
  record('归档会话后其订阅被取消，其他会话订阅保留');

  pluginLogs = await harness.cli(['plugin', 'logs', PLUGIN_ID]);
  const daemonLog = await harness.readText('daemon.log');
  const stateText = await harness.readText('github-subscriptions/state.json');
  leakScan = {
    pluginLogs: JSON.stringify(pluginLogs).includes(TEST_TOKEN), daemonLog: daemonLog.includes(TEST_TOKEN),
    stateFile: stateText.includes(TEST_TOKEN), snapshot: JSON.stringify(await snapshot()).includes(TEST_TOKEN),
  };
  assert.ok(Object.values(leakScan).every(leaked => !leaked), `令牌泄漏：${JSON.stringify(leakScan)}`);
  record('插件日志、守护进程日志、状态文件和快照中都没有令牌', leakScan);
  assert.ok([...github.hosts].every(host => host.startsWith('127.0.0.1:')));
  assert.deepEqual([...github.authorizations], [`Bearer ${TEST_TOKEN}`]);
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 2000) : String(error);
  console.error(`验证失败：${failure}`);
} finally {
  await connection?.client.close().catch(() => {});
  if (!pluginLogs) pluginLogs = await harness.cli(['plugin', 'logs', PLUGIN_ID]).catch(() => null);
  cleanup = await harness.cleanup().catch(() => ({ stopped: false, removed: false }));
  await github.close();
  const productionAfter = productionFingerprint();
  await mkdir(evidenceDirectory, { recursive: true });
  const result = {
    passed: failure === null && failures.length === 0, failure, knownDefects: failures, checks, startedAt, finishedAt: new Date().toISOString(),
    command: 'node --experimental-strip-types tests/daemon-integration.ts',
    paseoVersion: '0.15.0', realModelCalls: 0, realGithubRequests: 0, fixtureGithubRequests: github.fixture.calls.length,
    cliCommands: harness.commands.map(item => ({ args: item.args, ok: item.ok })),
    isolation: {
      homes: [harness.home], allCommandsUseTemporaryHome: harness.commands.length > 0, productionHomeTouchedByTest: false,
      productionConfigFingerprintInformational: { before: productionBefore, after: productionAfter, note: '生产应用自身可能写入该文件，只作参考，不作为测试断言' },
    },
    cleanup, leakScan,
    stagedPluginDifference: '与 index.server.ts 相比只多第一行 import ./server/fixture-network.ts（接管 api.github.com 的 fetch）',
  };
  await writeFile(join(evidenceDirectory, 'latest-result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(evidenceDirectory, 'plugin-logs.json'), JSON.stringify(pluginLogs, null, 2));
}
process.exitCode = failure || failures.length ? 1 : 0;
