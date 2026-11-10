# 开发自动化插件一期：待核实项实测结论（细化）

状态：细化会话产出，供主会话审核。依据雏形 `plans/1808-phase1-draft.md`（含「主会话审核意见」和「Yang 决定」两节）。
本文不改雏形，也不改任何代码。

证据来源说明：

- **客户端**：本工作树 `paseo-github-subscriptions/node_modules/@getpaseo/{client,protocol,plugin}`（`npm ci --ignore-scripts` 安装，版本 0.15.0）。下文写作 `client/dist/...`、`protocol/dist/...`、`plugin/dist/...`。
- **守护进程服务端**：`/Applications/Paseo.app/Contents/Resources/app.asar` 解包到 `/tmp/paseo-asar-1808/app`，只读。下文写作 `server/...`，指 `node_modules/@getpaseo/server/dist/server/server/...`。
- **桌面端前端**：`/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-c25f485e….js`（压缩包，按函数名引用）。
- **实测**：探测脚本在 `/tmp/1808-probe/`。连接参数与 `server/daemon.ts` 的 `connectDaemon` 相同（读 `paseo.pid` 的 `listen`、`local-credential`，`clientType: 'cli'`）。写操作只用于临时测试工作区 `wks_c3a284291d4fff3a`（标题「【开发自动化插件一期】测试-收尾探测」）和临时测试会话 `3ef1212d…`（claude-5 / claude-haiku-5-5，提示「回复 ok 后结束」）。两者都已归档，见第 11 节。

---

## 0. 结论摘要

| # | 待核实项 | 结论 |
|---|---|---|
| 1 | `detachAgent` 清哪些标签 | 只删 `paseo.parent-agent-id`，以及全部 `paseo.open-agent-tab.*`。**不删** `paseo.parent-server-id`。重复调用不报错 |
| 2 | `updateAgent` 标签语义 | **合并**写入：未提到的键保留，提到的键覆盖。值可以改写，也可以写成空串 `""`。**不能删除键**：传 `null` 在客户端就被协议校验拒绝；传 `{}` 被服务端拒绝（`Nothing to update`） |
| 3 | 不调 `agent open` 能否出现在桌面 | **能**。桌面端对工作区内未归档的「根会话」自动打开标签页：没有父会话标签，或者父会话在别的工作区。`agent open` 只是用 deep link 拉起桌面应用并定位到该会话，插件不需要它 |
| 4 | 置顶和工作区标签经插件连接调用 | 都成功，`fetchWorkspaces` 能读回 `pinnedAt` 和 `labels:["主会话"]`。**注意**：重复置顶会刷新 `pinnedAt` 时间，不是无副作用的空操作 |
| 5 | `listUsageReports` 真实返回 | 档次字符串：Max 档是 `Max 5x`，Pro 档是 `Pro ai`。窗口 id 为 `five_hour`、`weekly`，另有按模型计的 `weekly_model_fable`。守护进程缓存有效期 5 分钟；普通调用超时自动重取。连续 3 次强制刷新没有被限流 |
| 6 | 云端会话提问是否触发 `agent.permission.before` | **会**。源码链路完整，升级日志里有云端会话 `asked` 记录 |
| 7 | 每日任务会话是否带 `role=main` | **不带**。每日任务由 Paseo 定时任务创建，会话带 `paseo.schedule-id` 和 `paseo.schedule-run`。多数在 codex、glm 上运行。工作区标题经常不以「【每日】」开头 |
| 8 | 弹窗原文 | 找到本机确认、每日任务、复盘审阅三类原文（第 8 节）。**「来源主机」不是本机确认弹窗**，是插件问答模式的设置项，作为关键词会误判 |
| 9 | 更合适的「标签变化」事件 | 没有专门的标签变化钩子。会话列表订阅里的 `agent_update` 在标签变化时会推送（已实测）。`agent.open.before` 在会话创建时能读到标签，可作为补充 |

---

## 1. `detachAgent` 清除哪些标签

**结论**：只删除 `paseo.parent-agent-id` 和全部 `paseo.open-agent-tab.<clientId>`。`paseo.parent-server-id` 保留。

**源码证据**：

- `server/agent/agent-manager.js:277-285` `detachedAgentLabelPatch()`：补丁只包含 `{[PARENT_AGENT_ID_LABEL]: null}`，以及以 `paseo.open-agent-tab.` 开头的键。
- `server/agent/agent-manager.js:1517-1549` `detachAgentUnlocked()`：没有父会话 ID 时直接返回 `previousParentAgentId: null`，不报错，所以可以重复调用。
- 常量在 `protocol/dist/agent-labels.js:1-3`：`paseo.parent-server-id`、`paseo.parent-agent-id`、`paseo.open-agent-tab.`。

**实测**（测试会话创建时带两个父标签）：

```
创建后：{"paseo.parent-agent-id":"644c3b28-…","paseo.parent-server-id":"<本机serverId>","probe.need":"t1808",…}
detach 后：{"paseo.parent-server-id":"<本机serverId>","probe.need":"t1808",…}
再次 detach：成功（幂等）
```

**线上已有佐证**：会话 `03946194`（1233 主会话）和 `a19bf456` 都只剩 `paseo.parent-server-id`，没有 `paseo.parent-agent-id`。

**影响**：残留的 `paseo.parent-server-id` 没有副作用。原因：

- 协议的 `getParentAddressFromLabels()` 只在有父会话 ID 时才读父主机 ID（`protocol/dist/agent-labels.js:22-32`）。
- 插件的 `parentLink()` 也是先判断父会话 ID（`server/core/session-roles.ts:46-51`）。
- `stalled.ts:57-58` 先比较父会话 ID。

所以 C3 第 6 步的读回条件应改为「没有 `paseo.parent-agent-id`」，不要求 `paseo.parent-server-id` 也消失。

## 2. `updateAgent` 标签语义（用于插件内部防重入）

**结论**：合并写入。可以改写值，也可以写空串。不能删除键。

**源码证据**：

- 客户端 `client/dist/daemon-client.js:2040-2066`：`labels` 为空对象时不发送该字段。
- 协议 `protocol/dist/messages.js:767-773`：`labels: z.record(z.string(), z.string())`，值必须是字符串。
- 服务端 `server/agent/lifecycle-command.js:62-79`：没有标题也没有标签时返回 `Nothing to update`。
- 服务端 `server/agent/agent-manager.js:208-219` `applyLabelPatch()`：逐键覆盖；值为 `null` 才删除。但 `null` 过不了协议校验，所以客户端无法删除。

**实测**：

```
写 probe.lease=plugin:…:abc      → 原有键全部保留，新增 probe.lease
写 probe.lease=released:…        → 只改这个键的值
写 probe.lease=""                → 值变成空串，键仍在
updateAgent(id,{labels:{}})      → 拒绝：Nothing to update (provide name and/or labels)
updateAgent(id,{labels:{k:null}})→ 客户端校验拒绝：expected string
```

**对防重入的建议**：

- 迁移锁标签 `dsh.migration-lease=<owner>:<到期时间>:<nonce>`，释放时写 `released:<时间>`。不要依赖删除键。
- 「写入后 2 秒读回、比较 nonce」可以保留。这一步现在只防插件自身的重入，例如插件重启或两条触发路径并发。
- 守护进程对同一会话的标签写入串行执行（`agent-manager.js:1680-1693` `runLifecycleMutation`），所以读回结果可信。

## 3. 插件建的会话不调 `agent open` 能否出现在桌面

**结论**：能。插件不需要调用 `agent open`。

**证据**：

- `agent open` 的实现（`@getpaseo/cli/dist/commands/agent/open.js`，`commands/open.js:88-90`）只做一件事：`launchDesktop([buildAgentDeepLink(target)])`。它用 deep link 拉起桌面应用，并定位到该会话，不写任何守护进程状态。
- 桌面端的 `deriveWorkspaceAgentVisibility()`：工作区内未归档的会话都算「活动」。其中 `isWorkspaceRootAgent(a, parent)` 为真的会话进入 `autoOpenAgentIds`，由 `reconcileWorkspaceTabs()` 自动开标签页。
- `isWorkspaceRootAgent(n,t)`：`if(!n.parentAgentId) return true;` 否则只在父会话所在工作区和本会话不同时为真。
- `paseo.open-agent-tab.<clientId>` 标签只用于子会话（`getAgentTabsNeedingOpenLabel` 要求 `o?.parentAgentId`）。这解释了为什么现有主会话都没有这个标签。

**推论**：

- 主会话在 C3 中解绑后就是根会话，桌面打开该工作区时会自动显示。
- E3 新建的接班会话不带父会话标签，也会自动显示。
- 原会话归档后，桌面会按 `shouldPruneWorkspaceAgentTab` 移除它的标签页。
- `agent open` 只有「把用户的桌面切到这个会话」的作用。是否需要，由总控决定，不属于插件职责。

**未做的部分**：没有截图验证。原因：实测时桌面应用不在前台，不应操作用户的屏幕。结论依据是桌面端源码。

## 4. 置顶和工作区标签经插件现有连接调用

**结论**：两个调用都成功，能读回。

**实测**（用与 `connectDaemon` 相同的连接参数）：

```
setWorkspacePinned(ws,true)        → {"pinnedAt":"2026-11-10T09:46:30.267Z"}
setWorkspaceLabel({name:'主会话',color:'emerald'},assigned:true) → 返回 requestId、label、workspaceLabels
1.5 秒后 fetchWorkspaces            → {"pinnedAt":"2026-11-10T09:46:30.267Z","labels":["主会话"],"background":false}
再次 setWorkspacePinned(ws,true)   → {"pinnedAt":"2026-11-10T09:46:31.778Z"}   ← 时间被刷新
取消置顶并移除标签后读回           → {"pinnedAt":null}（labels 字段消失）
```

**要点**：

- 重复置顶会改 `pinnedAt`，可能改变侧边栏顺序，也可能再次触发置顶通知。所以 C3 第 4 步「`pinnedAt` 为空时才调」必须保留，不能为了省事无条件调用。
- `fetchWorkspaces` 的条目字段是 `id`（不是 `workspaceId`）、`title`、`pinnedAt`、`labels: string[]`、`background`、`archivingAt`、`status`。插件要按这些字段读。
- 置顶变化会通过 `workspaces.list({subscribe:{}})` 推送 `workspace_update`（upsert），已实测（第 9 节）。

## 5. `listUsageReports` 真实返回

**调用结果结构**：`{ requestId, reports: UsageReportEntry[] }`。注意是 `reports`，不是 `entries`。

**条目字段**（`protocol/dist/messages.js:5665-5691`）：`id = "<sourceId>:<accountKey>"`、`sourceId`、`account.label`（含邮箱，不能打印）、`fetchedAt`、`successfulAt`、`report.status`、`report.planLabel`、`report.windows[]`、`report.details[]`、`lastSuccessful`。

**Claude 账号实测**（`sourceId=claude-accounts`，按插件的 `discover()` 映射到 Provider；时间为 UTC 月-日 时:分）：

| Provider | planLabel | 五小时剩余 | 五小时重置 | 周剩余 | 周重置 |
|---|---|---|---|---|---|
| claude | `Pro ai` | 100% | 11-10 11:09 | 0% | 11-13 09:59 |
| claude-2 | `Pro ai` | 66% | 11-10 12:20 | 50% | 11-14 20:00 |
| claude-3 | `Max 5x` | 33% | 11-10 11:19 | 16% | 11-14 12:59 |
| claude-4 | `Pro ai` | 16% | 11-10 12:19 | 47% | 11-15 09:59 |
| claude-5 | `Pro ai` | 76% | 11-10 13:30 | 72% | 11-16 07:00 |
| claude-8 | `Max 5x` | 93% | 11-10 14:19 | 99% | 11-17 07:59 |
| claude-10 | `Pro ai` | 100% | **无**（`resetsAt` 为空） | 1% | 11-12 07:59 |

其他来源：`codex`（planLabel `promax`）、`claude-browser`（网页额度，没有 planLabel，不映射到 Provider）、`glm`（`Coding Plan (MAX)`，窗口 id 不同）。

**档次字符串的来源**：`server/vendor/paseo-0.15.0/claude-usage-source/server/usage.ts:86-94` `buildClaudePlan()` = 首字母大写的 `subscriptionType` + 空格 + `rateLimitTier` 最后一个 `_` 之后的部分。所以 `Max 5x` 来自 `…_max_5x`，`Pro ai` 来自 `…_claude_ai`。如果以后出现 Max 20x，会是 `Max 20x`。

**其他发现**：

- 当前 Provider 只有 `claude`、`claude-2`、`claude-3`、`claude-4`、`claude-5`、`claude-8`、`claude-10`。雏形 D2 示例里的 `claude-11` 不在 `paseo provider ls` 中。另外 `claude-3` 是 Max，`claude-2`、`claude-4`、`claude` 是 Pro，雏形示例里没有列出。
- 五小时窗口没有用量时，`resetsAt` 为空（claude-10）。pace 计算要把这种情况当作「窗口未开始，pace=0」。
- 每个窗口都有 `usedPct` 和 `remainingPct`，两者都可能为 `null`（协议 `nullable().optional()`）。
- `report.details` 里有 `active_sessions`（插件自己的 `ActiveSessions` 计数，标签「未关闭会话（不含空闲子会话）」）和 `extra_usage`。
- 有 `weekly_model_fable` 窗口（Fable 模型单独的周额度）。主会话用 Opus 时不受它限制；以后如果主会话改用 Fable，要把它也算进去。

**刷新和限流**：

- 守护进程缓存有效期 5 分钟（`server/plugins/usage-sources/index.js:6` `ttlMs = 300000`）。不带 `forceRefresh` 的调用：缓存未满 5 分钟就直接返回，超过就当场重取（`index.js:218-224`）。同一账号的并发请求会合并成一次（`pending`）。
- 实测 `fetchedAt` 离当前时间都在 0.2 分钟以内，说明有其他调用方（插件每分钟的 `paseo usage ls`）在持续刷新。
- 对 claude-5 连续 3 次 `forceRefresh + reportIds`：耗时 1623、356、369 毫秒，全部 `available`，没有限流。
- 上游返回 429 时，带 `Retry-After`（注释写「几十分钟」）。在此期间，即使强制刷新，也只返回错误「额度接口暂时限流，将按服务要求等待后自动重试」，同时保留 `lastSuccessful`（`usage.ts:526-549、615-617`；`continuous-usage.ts:148-151`）。

**结论**：容量模型**不需要** `forceRefresh`。普通调用就能拿到不超过 5 分钟的数据。

## 6. 云端会话提问是否触发 `agent.permission.before`

**结论**：会触发。

**源码链路**：

1. 插件的 cloud-session Provider 发出 `session.permission` 事件（`paseo-github-subscriptions/server/cloud-session/index.ts:173-184`）。
2. 守护进程 `server/agent/plugin-provider.js:1234-1243` `translatePermission()` 把它转成 `permission_requested`。
3. `server/agent/agent-manager.js:3833-3835`：非内部会话的非时间线事件都经过 `publishAgentStream()`。
4. `server/plugins/lifecycle/index.js:139-140`：`permission_requested` → `lifecycle.emit("agent.permission.before", …)`。

**日志证据**（`~/.paseo/github-subscriptions/escalation/events.jsonl`）：

- 云端会话 `38530eb6`（provider `cloud-session`）在 2026-11-09 08:59 到 13:03 之间有 4 次 `asked`，每次都经过 `pending → queued → delivery-attempt → recorded-shadow`，另有 9 次 `recorded-only` 和 2 次 `record-closed`。当时升级通道处于影子模式。
- 日志不能区分来源是钩子还是会话列表的 `pendingPermissions` 扫描（`runtime.ts:203-221` 两条路径都会调用 `asked()`）。但两条路径都能覆盖云端会话，所以结论不变。

**附带发现**：这个云端会话的工作区 `wks_82938bd10d142c9f` 不在 `fetchWorkspaces({})` 的默认结果中。它可能是 background 工作区。B 节「工作区标题」和 D3「置顶读 `fetchWorkspaces`」如果要覆盖云端会话，要确认是否需要传入包含 background 工作区的选项。这一点没有继续核实。

## 7. 每日任务会话是否带 `role=main`

**结论**：不带。每日任务由 Paseo 定时任务创建，用 `paseo.schedule-id` 识别最可靠。

**证据**：扫描 `~/.paseo/agents/*/*.json`，找出标题含「每日」的工作区（`~/.paseo/projects/workspaces.json` 中有 25 个，都已归档）里的 50 个会话：

- 定时任务创建的根会话：标签只有 `paseo.schedule-id` 和 `paseo.schedule-run`。Provider 是 `codex` 或 `glm-acp-agent`，不是 Claude。共 34 个会话带 `paseo.schedule-id`。
- 这些根会话派出的 Claude 子会话（claude-2/3/4/5/9/10）带 `paseo.parent-agent-id`，再加上各种自定义标签：`role=research-probe|probe|smoke|architecture-audit|knowledge-analysis`、`task`、`review-date`、`demand`、`scope`、`approval`。没有一个是 `role=main`。
- 50 个会话里只有 1 个 `role=main`。它在工作区「1585【复盘待审】主干每日CI失败」里，是普通需求的主会话，不是每日任务。
- 每日任务工作区标题实测值：「【每日】屎山代码清理」「【每日】上游同步分析」「【每日】Desktop Nightly 打包守卫」「【每日架构巡检】三仓库 · 11月9日」「每日上游 GAP 分析报告（fliggy-travel-ai）」「生成每日上游 GAP 分析 HTML 报告」「每日巡检 product 与孪生仓库架构治理」。**很多不以「【每日】」开头**。
- 每日任务工作区创建后会被置顶（`pinnedAt` 非空），所以按「置顶工作区」判定时会被当作主会话。

**另一个发现：单号标签有两种写法**：

| 会话 | 标签 |
|---|---|
| 64eb4b07（1808 主会话） | `need=1808`、`role=main` |
| 03946194（1233 主会话） | `issue=1233`、`issue-repo=…`、`role=main` |
| 其他 4 个置顶工作区里的会话 | 没有任何标签 |

所以只认 `need` 会漏掉一部分主会话。

## 8. 弹窗原文样例（校准「仅限 Yang 本人」分类）

来源：`~/.claude*/projects/**/*.jsonl` 中的 `AskUserQuestion` 调用，以及 `escalation/events.jsonl` 中定时任务会话的提问。邮箱已打码，正文按需截断。

### 8.1 本机确认（`local_confirm`）

1. （2026-11-10 05:13）「界面统一的桌面端复测已准备好。…启动时云壳会弹 1 次“软件阻断提醒”，要在约 12 秒内点“仍要运行”。…你现在在 MacBook 前吗？」选项：「在，现在启动：我在 MacBook 前，看到提醒就点“仍要运行”。」「稍后：…」
2. （2026-11-09 21:43）「界面统一的桌面端验收需要你在 MacBook 前点几次“仍要运行”。云壳会拦截新打包的验收程序…每个只在第一次运行时弹“软件阻断提醒”，约 12 秒内要点“仍要运行”，否则程序会被终止。你现在在 MacBook 前吗？」
3. （2026-11-05 01:03）「执行会话没有代输密码…请到 MacBook 上，在系统设置“隐私与安全性”已弹出的认证窗口里本人完成 Touch ID 或密码。…」
4. （2026-11-05 01:09）「请在 MacBook 打开录屏开关：系统设置 → 隐私与安全性 → “录屏与系统录音”…」

**反例（不是本机确认）**：（2026-11-09 17:36）「Mac Mini 问答模式的“来源主机”在 17:14 到 17:35 之间，从 MacBook 变成了“自动”。…来源主机怎么处理？」这是插件设置的决策题。（2026-11-08 14:44）「…要在本机点“恢复云端接待”…」这是方案决策题，只是提到了这个按钮。

**关键词建议**：

- 删除「来源主机」「在本机点」。
- 保留「仍要运行」「Open Anyway」。
- 新增「软件阻断提醒」「隐私与安全性」「Touch ID」「认证窗口」「在 MacBook 前」「在 Mac Mini 前」「本人完成」。

### 8.2 每日任务（`daily_task`）

（2026-11-10 03:04，codex 定时任务会话「屎山代码清理」，工作区「【每日架构巡检】三仓库 · 11月9日」，工具 `request_user_input_async`）：

> 请你本人亲自打开并审阅11月9日（美国西岸）的[OSS架构巡检报告](…)。是否批准为“运维台集中维护请求传输与通用失败解析”建立治理 Issue？…按你的要求，必须有本人对当日报告和具体候选的明确决定；请回复批准的候选名称与范围，或继续调查、不处理。建单批准不包含代码实施、发布或部署。

这条记录的通知负载有两个问题：

- `questionSummary.text` 是「Question」，取的是请求的 `title`，不是问题正文（`notify/protocol.ts:39`）。
- `needsUser=false`：正文里没有「复盘」或「合并 master」，所以没有命中 `needsUser()`（`notify/protocol.ts:28-31`）。

这正是 B 节要补 `prompts` 和 `audience` 字段的原因。

### 8.3 复盘审阅（`retro_review`）

1. （2026-11-10 01:47）「复盘页已发布，并已在 MacBook 浏览器打开：<链接>。请在页面上给 5 条提案各选保留、暂缓或拒绝，然后点复制，把复制出的决定文本粘贴回来（选 Other 粘贴）。合并交付 PR 要等这份决定。」
2. （2026-11-09 12:06）「“对商家隐藏运维入口”的完整复盘审阅页已在 MacBook 浏览器打开：<链接>。页面列出 9 条改进提案和已落地改动的效果评估…请在页面选择每条的去留，点复制，把决定文本粘贴到“其他”。」
3. （2026-11-10 07:26，边界例子）「反馈巡检漏报的修复已通过全部检查和三轮独立评审。按交付流程，合入前要先做复盘并请你审阅复盘提案。怎么安排？」这是流程安排题，不是审阅本身。雏形的规则（「复盘」+「审阅/审核/通过/意见」）会把它标为 ownerOnly。按 H1 口径，这样标偏保守，可以接受。

## 9. 有没有比订阅会话列表更合适的「标签变化」事件

**结论**：没有专门的标签变化钩子。继续用会话列表订阅，并补一个定时兜底扫描。

**证据**：

- 插件生命周期钩子（`plugin/dist/server/lifecycle.d.ts:93-131`）只有：`agent.turn.before/after`、`agent.permission.before/after`、`agent.archive.after`、`agent.create.after`、`agent.close.after`、`workspace.create.after`、`workspace.archive.after`。`PluginHookAgent` 只有 `id`、`workspaceId`、`parentAgentId`、`provider`、`cwd`、`title`，不含标签。
- 可拦截的请求钩子 `agent.open.before`（`PluginSessionOpenRequest`，`lifecycle.d.ts:68-80`）带只读的 `labels`。`reason` 为 `create|resume|refresh|import`。会话**创建时**已带 `role=main` 的情况（总控用 MCP `create_agent` 传标签）可以在这里立即识别。但创建之后再打标签（Grok bot 用 `paseo agent update --label`）不会触发它。
- 连接事件订阅 `observeEvents()` 的枚举（`protocol/dist/messages.js:2709-2727`）没有会话标签相关事件。
- **实测**：用 `paseo.agents.list({subscribe:{}})` 订阅后，对测试会话 `updateAgent(labels)`，收到一次 `agent_update`（`kind=upsert`），载荷里的 `labels` 已是新值。置顶和取消置顶各收到一次 `workspace_update`（upsert）。
- **风险**：服务端只在会话已加载到内存时广播标签变化（`agent-manager.js:1486-1497` `writeLabels()` 中只有 live 分支调用 `emitState`；非 live 分支走 `writeStoredMetadata()`，没有广播）。`session.js:2549-2575` 处理请求后也没有额外广播。所以给未加载的历史会话打标签时，订阅可能收不到。

**建议**：

- 触发主路径：会话列表订阅（与 `runtime.ts:195-230` 相同）。
- 补充：`agent.open.before`（reason=create）里看到 `role=main` 时直接排队。
- 兜底：每 5 分钟 `fetchAgents` 全量扫描一次。

---

## 10. 据此对雏形需要改的具体点

### C 节（本机派发收尾）

1. **C1 待核实项删掉，换成本文结论**：解绑只清父会话 ID（第 1 节）；标签是合并写入（第 2 节）；不需要 `agent open`（第 3 节）。
2. **C2 触发条件**：
   - 改成 `role=main` 加上（`need` 或 `issue`）任一单号标签。原因是现有主会话两种写法都有（第 7 节）。
   - `finalize/state.json` 的完成记录按「会话 id + 单号」记。
3. **C2 触发方式**：
   - 增加 `agent.open.before`（reason=create）作为即时触发。
   - 增加每 5 分钟一次的 `fetchAgents` 兜底扫描（第 9 节风险）。
   - 「命令行没有 `plugin rpc`，Grok bot 只能走标签」的说法不变。
4. **C3 第 3 步**：判断条件写成「有 `paseo.parent-agent-id` 时调用 `detachAgent`」。
5. **C3 第 4 步**：保留「`pinnedAt` 为空才调用」，并注明原因：重复置顶会刷新 `pinnedAt`，可能再次触发通知（第 4 节）。
6. **C3 第 5 步**：读回用 `fetchWorkspaces().entries[].id` 和 `labels: string[]`。`setWorkspaceLabel` 的 `color` 只在新建标签时有意义；「主会话」标签已存在，传 `emerald` 即可。
7. **C3 第 6 步读回条件**：
   - 改为「没有 `paseo.parent-agent-id`」，不要求 `paseo.parent-server-id` 消失。
   - `need`/`issue` 和 `role` 正确，`pinnedAt` 非空，`labels` 含「主会话」。
8. **C3 末尾**：删除「`agent open` 待核实是否需要」。改为：插件不调用，桌面会自动显示根会话。是否把用户桌面切到新会话，由总控决定。
9. **C2 误判对策**：补一条。置顶工作区里所有会话都被 `session-roles.ts` 当作主会话，包括主会话自己在同一工作区派出的子会话（例如本细化会话就在 1808 的置顶工作区里）。所以「工作区内有两个主会话」的告警要排除带 `paseo.parent-agent-id` 的会话，只比较根会话。

### D 节（容量模型）

1. **D1 档次核对**：`planLabel` 用前缀匹配。`/^Max\b/` 对应 max，`/^Pro\b/` 对应 pro。完整取值是 `Max 5x`、`Pro ai`。如果出现 `Max 20x`，按 max 处理，同时报警「档次需要确认」，因为基础容量可能不同。
2. **D1 实时判定**：
   - 保留 `status==='available'` 且 `now - fetchedAt ≤ 10 分钟`。
   - 改为**不用** `forceRefresh`：守护进程缓存 5 分钟，普通调用会自动重取（第 5 节）。
   - 只有当报告 `status=error` 且原因是限流时，才把账号记为 `quota_unknown`，并在下一个 5 分钟周期重试。
   - 删除「每个账号至少间隔 5 分钟强制刷新」的设计。
3. **D1 字段名**：返回字段是 `reports`，不是 `entries`。
4. **D2 配置示例**：
   - 删除 `claude-11`。
   - 补上 `claude-3: max`、`claude-2: pro`、`claude-4: pro`、`claude: pro`。
   - 加注释：档次以 `planLabel` 为准，配置只用来确认。
   - 建议：配置缺失但 `planLabel` 能明确识别时，仍然记为 unknown（按雏形口径），但在 `excluded` 里给出 `planLabel`，方便 Yang 一次补齐。
5. **D3 负载计数**：
   - 补一个可选的数据源：报告 `details` 里的 `active_sessions`（插件已有的 `ActiveSessions`，口径是「未关闭且不含空闲子会话」，`active-sessions.ts:5-14`）。它按登录目录计数，与置顶无关。
   - 建议 `capacity.snapshot` 同时输出两个数：置顶口径的 `load.total`，和 `active_sessions`。决策仍按雏形的置顶口径，另一个数只用于对账。
6. **D3 第 2 条理由**：「每日任务不一定有 `role=main`（待核实）」改为已核实：每日任务没有 `role=main`，并且根会话多数不是 Claude。真正占 Claude 额度的是每日任务派出的 Claude 子会话，它们也在置顶工作区里，按置顶口径会计入负载。
7. **D4 pace**：五小时窗口 `resetsAt` 为空时，记为「窗口未开始」，pace=0，有效容量取基础容量。
8. **D4 周额度**：只看 `weekly`，不看 `weekly_model_fable`。如果主会话模型以后改为 Fable，要把模型周窗口一起算进去（加配置项 `capacity.modelWindows`，默认空）。

### E 节（换号迁移）

已按「Yang 决定」作废 E5 的双方互斥。以下只列与核实结果有关的改动：

1. **E3 第 1 步（租约）**：
   - 租约只用于插件内部防重入。
   - 释放写 `released:<时间>`，或写空串。不能删除键（第 2 节）。
   - 读回比较 nonce 的做法保留。
2. **E3 第 3 步（新建会话）**：`createAgent` 必须同时传 `cwd` 和 `workspaceId`。只传 `workspaceId` 会在客户端报错「createAgent requires provider and cwd」（实测；`client/dist/daemon-client.js:5428`）。`cwd` 取原会话的 `cwd`。不传父会话标签，这样桌面会把它当根会话自动显示（第 3 节）。
3. **E3 第 3 步（标签）**：新会话的单号标签沿用原会话的键名（`need` 或 `issue`，第 7 节），并加 `role=main`。
4. **E3 第 7 步（原会话）**：本机子会话改指新主会话时，用 `updateAgent` 同时写 `paseo.parent-agent-id=<新会话>` 和 `paseo.parent-server-id=<本机 serverId>`。合并语义保证其他标签不受影响（第 2 节）。
5. **E3 第 7 步（读回）**：原会话归档后，桌面会自动移除它的标签页。不需要额外操作。
6. **E1 跳过条件**：「没有 `role=main` 或 `need` 标签」改为「没有 `role=main`，或者既没有 `need` 也没有 `issue`」。
7. **E6**：按「Yang 决定」，开发期 `shadow`，bot 停用后 `live`。本文无补充。

### F 节（余量反馈）

1. **签名计算**：在 `{provider: canAdd}` 之外，加入每个账号的 `live` 布尔值。否则账号从「实时」变成「不明」时，canAdd 可能不变，总控会收不到通知。
2. **心跳**：推送时附带每个账号的 `fetchedAt`。因为守护进程缓存是 5 分钟，总控可以据此判断数据新旧。
3. **事件和路由**：雏形写法不变。`lb_exception` 现在的接收方只有总控（bot 已移除），文字要同步改。

### 雏形其他节的附带发现（不在 C/D/E/F，供主会话参考）

1. **B3 `daily_task` 识别规则**，按顺序：
   - (a) 会话带 `paseo.schedule-id`；
   - (b) 会话的父会话带 `paseo.schedule-id`（每日任务派出的子会话）；
   - (c) 工作区标题以「【每日」开头（覆盖「【每日】」和「【每日架构巡检】」）。
   - 不要用「标题含“每日”」：「1585【复盘待审】主干每日CI失败」是普通需求（第 7 节）。
2. **B3 `local_confirm` 关键词**：按 8.1 修改。删除「来源主机」「在本机点」。
3. **B2 `prompts`**：要覆盖 `request_user_input_async`。现有 `nativePrompts()` 已支持（`questions.ts:35`），但 `questionSummary.text` 取的是 `title`，codex 提问时显示「Question」（第 8.2 节）。建议 `prompts` 上线后，`questionSummary.text` 改为第一个问题的正文。这一条属于 B 节，是否纳入 PR 2 由主会话决定。
4. **A4 云端会话**：第 6 节已核实，可以删除「待核实」。

---

## 11. 测试对象和临时文件清理记录

| 对象 | 处理 | 读回 |
|---|---|---|
| 测试工作区 `wks_c3a284291d4fff3a`「【开发自动化插件一期】测试-收尾探测」（directory 类型，指向本工作树目录，没有新建 Project 或 worktree） | 取消置顶，移除「主会话」标签，归档 | `workspaces.json`：`pinnedAt=null`，`archivedAt=2026-11-10T09:51:11Z`。工作树目录仍在，没有被删除 |
| 测试会话 `3ef1212d-6859-4c30-9d4e-1635dc59eb29`（claude-5 / haiku，回复了 ok） | 归档 | `archivedAt=2026-11-10T09:51:11Z` |
| 测试会话上的 `probe.*` 标签 | API 无法删除（第 2 节），会话已归档 | — |
| `/tmp/1808-probe/`（探测脚本）、`/tmp/paseo-asar-1808/`（解包的只读源码） | 保留在 /tmp，供复核 | 截图已删除 |
| 本工作树 `paseo-github-subscriptions/node_modules` | `npm ci --ignore-scripts` 安装，已被 gitignore | — |

没有对任何现有工作区或会话做写操作。实测期间测试工作区置顶了两次（约 1 秒和 1.5 秒），可能触发了置顶通知，属于预期。

## 12. 仍未核实

1. 给**未加载**的历史会话打标签时，会话列表订阅是否收得到 `agent_update`。源码显示不会广播，没有实测。C 节已用 5 分钟兜底扫描覆盖。
2. 云端会话的 background 工作区是否需要额外参数才能出现在 `fetchWorkspaces` 结果中（第 6 节附带发现）。
3. 桌面端自动显示根会话没有截图验证（第 3 节），结论依据源码。
