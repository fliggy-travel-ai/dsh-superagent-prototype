# 开发自动化插件一期实施方案（雏形）

状态：雏形，等 Paseo session 补细节，再交主会话审核。本次只读代码，没有改任何文件，也没有运行会改状态的命令。

类型证据说明：本工作树没有安装依赖。Paseo 客户端和插件的类型来自 `/Volumes/data/Workspace/dsh-superagent-prototype/paseo-github-subscriptions/node_modules/@getpaseo/*`。那里的版本是 0.15.0，和本仓库 `package-lock.json` 锁定的版本相同。下文 `client/dist/...` 和 `protocol/dist/...` 都指那个目录。

---

## 0. 结论摘要

1. **去掉自动代答**：把 `recommendedAnswers` 和 `answer(..., true)` 的调用点删掉。问答模式的「离线」改为：不播语音，问题照常进入人工待办，并升级给总控。「已读」按钮和「代答未读」整套逻辑一起删除。浏览器扩展的网页提问现在**不进**升级通道，要补上。云端会话（`cloud-session` Provider）在置顶工作区里提问时，已经走 Paseo 原生提问钩子，会进升级通道（会不会触发钩子待核实）。
2. **通知负载**：`schemaVersion` 保持 1，只追加字段：`serverId`、`needId`、`workspaceTitle`、`prompts`（规范化后的问题和选项，带推荐标记和作答键）、`answerVia`、`audience`（`ownerOnly`、分类、原因）、`presence`。
3. **本机派发收尾**：现有 daemon 连接已经有这五个方法：`updateAgent`（会话标签）、`detachAgent`、`setWorkspacePinned`、`setWorkspaceLabel`、`fetchWorkspaces`（读回）。不需要新接口，也不用改 `workspaces.json`。触发方式推荐用标签：会话出现 `role=main` 和 `need=<单号>` 标签时自动收尾。
4. **容量模型**：新建模块 `capacity.mainSessions`。实时额度用 `listUsageReports` 中 `status=available` 且新鲜的报告，把五小时窗口和周窗口分开读。历史值（`lastSuccessful`）只显示，不参与决策。档次写在 `machine.json`，未核实档次的账号不参与分配。负载按「置顶工作区里的活动会话」计数。保留 pace 收紧。
5. **换号迁移**：同一模块里实现，默认关闭，先跑影子模式。用会话租约标签和负载均衡 bot 互斥。迁移成功只通知总控，不通知 Yang。
6. **余量反馈**：同一个 Grok webhook，新增 `capacity` 事件。余量变化时推送，至少间隔 5 分钟，另加 6 小时心跳。

---

## A. 去掉自动代答

### A1. 要删或改的代码

| 位置 | 现状 | 改法 |
|---|---|---|
| `server/presence.ts:548-549` | `process()` 在离线且有推荐项时调用 `this.answer({...}, true)` | 删除这两行。离线时只更新原因字段 |
| `server/presence.ts:380-384` | `pendingReasonIfNotAutoAnswered` 离线且有推荐项时返回 null | 删掉离线分支，统一返回原因；方法改名为 `pendingReason` |
| `server/presence.ts:550` | 原因文案「没有唯一明确的推荐项，请人工选择」 | 离线改为「离线：已通知总控，等待回答」。在线和未知的文案不变 |
| `server/presence.ts:61-62` | 手动离线的原因「选择明确推荐项」 | 改为「手动离线：不播语音，通知总控」 |
| `server/presence.ts:832-846、890、898` | `answer(input, automatic)` 和 automatic 分支 | 删除 `automatic` 参数和全部 automatic 判断，只保留人工回答 |
| `server/presence.ts:737`、`decisions` 中的 `automatic` 字段（第 136 行） | 网页决定的 automatic 有效性检查 | 删除 `automatic` 字段，`valid()` 只检查代次和暂停 |
| `server/presence.ts:296-305` `markRead` | 只服务「代答已读」 | 删除方法 |
| `server/questions.ts:79-88` `recommendedAnswers` | 自动代答选项 | 删除。`automaticAnswerBlockReason`（第 66-77 行）改名为 `ownerOnlyReason`，供 B 节分类复用 |
| `shared/presence.ts:39` `answer.source` 枚举中的 `'automatic'` | 持久化字段 | 枚举保留，用来兼容读取旧状态；新代码不再写入 |
| `shared/presence.ts:81-82`、`:86` | `isUnreadAutomaticAnswer`、`presenceRead` RPC | 删除。`isQuestionTodo` 改为 `!delegatedTo && state !== 'resolved'` |
| `server/modules/answer-presence/index.ts:21`、`server/modules/todo/index.ts:71` | 已读 RPC 处理 | 删除 |
| `server/todo.ts:153、168-195` | 「离线代答」日志和「代答未读」待办 | 删除这两类条目 |
| `client/dashboard.tsx:683-796`（已读按钮）、`:909`（「代答未读」筛选）、`:319、361` 文案 | 已读界面 | 删除按钮和筛选，改写文案 |
| `client/drawers.tsx:238、485-513`、`client/control-store.ts:158、357`、`client/sidebar-state.ts:47` | 离线代答说明和计数 | 改写文案，删除 `markQuestionRead` 和 `unreadAuto` |
| `server/web-request/executor.ts:461` | `source === 'automatic'` 映射 | 保留。台账来源 `automatic` 已经不会再出现，这里不用动 |

### A2. 状态迁移

已经持久化的 `answer.source === 'automatic'` 记录可能停在「已解决、未读」状态。改动后的 `isQuestionTodo` 不再显示这类记录，现有的保留逻辑（`presence.ts:204`）也要同步改为只保留未解决的记录，下次写盘时自然清掉。不需要单独的迁移脚本。

### A3. 新的问答模式语义

- **在线**：在所选主机播语音，进人工待办，同时升级给总控（升级受时段规则控制，和问答模式无关，见 `docs/answer-usage-modules.md` 中 answer.escalation 一节）。
- **离线**：不播语音，进人工待办，升级给总控。插件**不作答**。
- **自动**：按蓝牙在场判定切换在线或离线。判定未知时按在线处理（播语音）。
- 界面统一文案：「插件不代答。代答由总控按你的选择画像决定。」

### A4. 网页提问和云端会话提问

- **原生 Paseo 提问**：只有置顶工作区里的会话进入升级通道（`runtime.ts:168-170`、`session-roles.ts:38-40`）。
- **云端会话**：导入时会建工作区并置顶（`cloud-session/index.ts:335-337`），所以会作为原生提问进入升级通道。前提是 `cloud-session` Provider 的提问会触发 `agent.permission.before` 钩子，这一点**待核实**，要在真实 daemon 上验证一次。
- **浏览器扩展的网页提问**（`source: 'browser'`，并且没有 `delegatedTo` 指向原生提问）：升级通道只订阅 Paseo 钩子和会话列表（`runtime.ts:172-230`），所以这类提问**不会升级**。
  - 补法：在 `EscalationRuntime` 上加 `enqueueExternal(question)`。问答服务登记网页提问时，通过 `services.main.escalation` 调用（引用位置在 `core/services.ts:30`）。去重键用 `browser:<question.id>:<fingerprint>`；`agentId` 为空；带上 `instanceId`、`sessionId`、`url`、`title`；`answerVia='browser-only'`。
  - 总控无法远程替这类提问作答，只能提醒 Yang。问题结束时由问答服务调用 `escalation.closeExternal(id)`，结束对应的待办记录。

### A5. 测试改动

- `tests/presence.test.ts` 有 47 处相关用例。离线代答用例改为断言「不作答、原因为已通知总控、不播语音」。删除已读用例。
- 同步更新 `tests/control-store.test.ts`、`tests/todo.test.ts`、`tests/browser-questions.test.ts`、`tests/web-request-executor.test.ts`、`tests/presence-panel.test.ts`。
- 新增：网页提问进入升级通道并能结束；离线模式在 `answer` 入口拒绝任何非人工调用（防回归）。

---

## B. 给 Grok webhook 的 asked 事件加字段

### B1. 现有负载

`webhook.ts:25-36` 把整个 Notice 展开发出：`id`、`event`、`agentId`、`hostId`、`machine`、`workspaceId`、`title`、`provider`、`permissionId`、`questionSummary{text,questions,options,recommended}`、`needsUser`、`wake`、`data`（原始请求）（`engine.ts:12-36、205-235`）。

### B2. 追加字段（全部可选，`schemaVersion` 保持 1）

```jsonc
{
  "serverId": "<daemon serverId>",            // client.getLastServerInfoMessage()?.serverId（参考 cloud-session/index.ts:114）
  "needId": "1737",                           // 会话标签 need
  "workspaceTitle": "1737【开发中】…",          // 从工作区快照读取
  "requestId": "<= permissionId>",            // 别名，便于总控调用 respond_to_permission
  "answerVia": "paseo-permission | cloud-session | browser-only",
  "prompts": [{ "question": "...", "header": "...", "multiSelect": false, "allowOther": true,
               "answerKey": "<AskUserQuestion 用问题原文，request_user_input 用 header>",
               "options": [{ "label": "...", "description": "...", "recommended": true }] }],
  "audience": { "ownerOnly": true, "category": "daily_task", "reason": "每日任务弹窗须 Yang 本人查看" },
  "presence": { "mode": "online|offline|unknown", "source": "bluetooth|manual|unavailable" },
  "features": ["prompts", "audience", "serverId"]
}
```

- `prompts` 复用 `nativePrompts()`（`questions.ts:34-50`）。`answerKey` 规则来自 `nativeResponse()`（`questions.ts:114-117`）：AskUserQuestion 用问题原文，request_user_input 用 header。云端会话的作答格式不同（`questions.ts:98-112`），所以要单独标注 `answerVia`。
- 实现位置：`engine.enqueue` 只拿得到 `AgentInfo`（`protocol.ts:14-21`）。建议在 `runtime.ts` 的 `asked()` 中算出 `enrich` 对象，挂到 `notice.extra` 上；`webhookPayload` 展开它。`Notice` 接口加一个可选的 `extra` 字段。
- 工作区标题：现在只有开启 `newObjects` 时才维护工作区表（`runtime.ts:232、265-300`）。要改为始终维护这张表。

### B3. 「仅限 Yang 本人」分类（`audience`，按顺序匹配，命中即停）

| 分类 | 识别规则 | 依据 |
|---|---|---|
| `daily_task` | 工作区标题以 `【每日】` 开头；或会话或工作区标题命中 `machine.json` 中 `ownerOnly.dailyTaskKeywords`（默认：屎山代码清理、反馈分析、上游同步、Nightly） | super-agent 技能第 4 节「每日定时任务工作区标题 =【每日】任务名」；CURRENT-RULES 代答一节 |
| `retro_review` | 工作区标题阶段是 `【复盘待审】`；或问题文字同时含「复盘」和「审阅、审核、通过、意见」 | CURRENT-RULES「复盘待审 → 复盘意见实施必须 Yang 本人」；`needsUser()` 已能匹配「复盘」（`protocol.ts:28-31`） |
| `local_confirm` | 问题或选项含 `ownerOnly.localKeywords`（默认：来源主机、仍要运行、在本机点、本机确认、Open Anyway） | Yang 口径。**待核实**：需要真实弹窗原文样本，确认关键词 |
| `login_verification`、`payment`、`destructive_cleanup` | 复用 `ownerOnlyReason`（原 `automaticAnswerBlockReason`，`questions.ts:70-74`） | user-preferences 第二节 |
| `acceptance_merge` | `questions.ts:69` 的验收、合并规则 | 合并已有常设授权，见 H1 |

`ownerOnly=true` 只是给总控的硬性提示。插件自己不作答，所以分类误判不会让插件代点。

---

## C. 本机派发收尾

### C1. 接口证据（现有 daemon 连接可以直接调用）

`server/daemon.ts:40` 返回的 `client` 是 `createHostClient` 生成的 DaemonClient。`cloud-session/index.ts:112-113` 已经在用它的 `setWorkspacePinned` 和 `updateAgent`。

| 步骤 | 方法 | 类型位置 | 对应的线上消息 |
|---|---|---|---|
| 会话标签 | `client.updateAgent(id, { labels })` | `client/dist/daemon-client.d.ts:952` | `update_agent_request`（`daemon-client.js:2040-2066`） |
| 解开父子绑定 | `client.detachAgent(id)`，或 `paseo.agents.ref(id).detach()` | `daemon-client.d.ts:951`；`index.d.ts`（PaseoAgentHandle.detach） | `agent.detach.request`（`daemon-client.js:2029-2038`） |
| 置顶 | `client.setWorkspacePinned(wsId, true)` | `daemon-client.d.ts:966` | 即 pin-and-label.py 里的 `workspace.pin.set.request` |
| 工作区标签 | `client.setWorkspaceLabel({ workspaceId, label:{name:'主会话',color:'emerald'}, assigned:true })` | `daemon-client.d.ts:878-885` | `workspace.label.assignment.set.request` |
| 读回 | `client.fetchAgent(id)` 读 labels；`client.fetchWorkspaces()` 读 `pinnedAt` 和 `labels` | `daemon-client.d.ts:862-867`；工作区描述含 `pinnedAt`（`protocol/dist/messages.d.ts:9394`） | — |

**待核实（真实 daemon 上各验一次）**：
- `detachAgent` 是否同时清除 `paseo.parent-agent-id` 和 `paseo.parent-server-id`。命令行帮助只写了「Make a subagent independent」。
- `updateAgent` 的标签是合并写入还是整体覆盖。用户说明写的是「只增改，不清除」。
- 插件建的会话不调 `agent open` 能否出现在桌面列表。

### C2. 触发方式（推荐：标签驱动）

- 生命周期钩子 `agent.create.after` 的载荷不带标签（`plugin/dist/server/lifecycle.d.ts:60-67`），无法判断谁是主会话。
- 改为订阅会话列表（做法同 `runtime.ts:195-230`）。会话快照或更新中出现 `role=main` 和 `need=<单号>`，并且 `finalize/state.json` 里没有这个会话的完成记录时，执行收尾。
- 这样能覆盖两类派发：总控在本机用 MCP `create_agent` 传入标签；Grok bot 远程用 `paseo agent update --label` 打标签。
- 另外提供 RPC `dispatch.finalize {agentId, needId}`，给界面手动重试用。命令行没有 `plugin rpc` 子命令（已核对 `paseo plugin --help`），所以 Grok bot 只能走标签触发。

**误判风险和对策**：
- 只认 `role=main`，不按标题猜。
- 每个会话只收尾一次，状态持久化。Yang 之后手动取消置顶，插件不会再置顶回去。
- 会话已归档或没有 `workspaceId` 时跳过。
- 同一工作区已有另一个活动的 `role=main` 会话、且它不是本插件迁移产生的：仍然收尾，但在报告里标「工作区内有两个主会话」，交总控判断。

### C3. 步骤顺序（每步先读现状，已满足就跳过，所以可以重复执行）

1. 读取会话：存在、未归档、有工作区；读取工作区：未归档。
2. 补齐标签 `need`、`role=main`（RPC 触发时才需要写）。
3. 会话带父会话标签时，调用 `detachAgent`。
4. `pinnedAt` 为空时，调用 `setWorkspacePinned(true)`。
5. 工作区标签不含「主会话」时，调用 `setWorkspaceLabel(...)`。
6. 等 2 秒后读回：没有父会话标签，`need` 和 `role` 正确，`pinnedAt` 非空，标签含「主会话」。
7. 结果写入 `finalize/events.jsonl`，并发 webhook 事件 `main_finalized {ok, steps:[{name, status, detail}]}` 给总控。

失败处理：单步失败按 30 秒、2 分钟、10 分钟退避，最多重试 3 次。仍然失败就发 `main_finalized{ok:false}`，界面显示原因。不回滚已成功的步骤，因为每步都是正向且可以重复的。`agent open` 不在本期范围，仍由总控处理（待核实是否需要）。

---

## D. 容量模型

### D1. 实时额度来源

- 用 `client.listUsageReports()`（`daemon-client.d.ts:1319`）。条目有 `fetchedAt`、`successfulAt`、`report.status`、`report.windows[]`（id 为 `five_hour` 和 `weekly`）、`report.planLabel`、`lastSuccessful`（`protocol/dist/messages.js:5666-5691`；窗口 id 见 `vendor/.../usage.ts:123-124`）。
- **判为实时**：`report.status === 'available'` 且 `now - fetchedAt ≤ capacity.liveMaxAgeMinutes`（默认 10 分钟）。
- **判为历史**：其余情况，包括 `lastSuccessful`。历史值只显示，标「历史，不用于决策」。账号状态记为 `quota_unknown`，不分配新会话，也不触发迁出。
- 现有 `accountQuota()` 把两个窗口合成一个最小值，还会用最长 24 小时的历史值（`labels.ts:43-65`），**不能**直接复用。要新写 `liveWindows(reports, accountKey)`，分别返回 `fiveHour` 和 `weekly` 的 `{remainingPct, resetsAt}`。
- Provider 到账号的映射复用 `QuotaLabelService` 的做法：`providerEnvs()` → `discover()` → `account.key` → 报告 id `${sourceId}:${key}`（`quota-labels.ts:62-104`）。建议把这段抽成 `usage-claude-accounts/account-map.ts` 导出共用。
- 刷新：默认读 daemon 缓存；超过时限时，对单个账号用 `forceRefresh` 和 `reportIds` 刷新，每个账号至少间隔 5 分钟。原因是上游会限流（`continuous-usage.ts:148`）。

### D2. 档次配置（`machine.json`）

```jsonc
"capacity": {
  "baseCap": { "max": 4, "pro": 2 },
  "accounts": { "claude-8": { "tier": "max" }, "claude-5": { "tier": "pro" },
                "claude-10": { "tier": "pro" }, "claude-11": { "tier": "pro" } },
  "warmup": [],                 // 预热中的 Provider，基础容量减半（claude-capacity.py:5、56-57）
  "liveMaxAgeMinutes": 10,
  "pace": true
}
```

- 不在 `accounts` 里的 Claude Provider 记为 `tier: unknown`，不参与自动分配，只显示。
- `planLabel` 和配置的档次不一致时（例如配置写 max、报告写 Pro），按 unknown 处理并报警。`planLabel` 由 `subscriptionType` 和 `rateLimitTier` 生成（`vendor/.../usage.ts:578、608`）。它的具体取值**待核实**。

### D3. 负载计数

- **计入负载**：置顶且未归档的工作区里的会话，Provider 属于该账号，会话未归档、状态不是 `closed`。不区分空闲还是运行中，因为空闲会话之后还会继续消耗额度；现行脚本也按全部会话计数（`claude-capacity.py:46-50`）。
- **为什么用置顶规则，不用 `role=main` 标签**：
  1. 插件里停滞、免提醒、升级三处已经统一用置顶规则判定主会话（`session-roles.ts:4-8、38-40`）。
  2. 每日任务也在置顶工作区里，同样消耗额度，但不一定有 `role=main` 标签（待核实）。
  3. 按会话名「【主会话】」计数的旧做法会受改名影响（`claude-capacity.py:47`）。
- **`role=main` 和 `need` 标签只用来判定能否自动迁移**：没有这两个标签的置顶会话（例如每日任务）只计入负载，不自动迁走。
- 置顶状态读 `workspaces.json`（`session-roles.ts:81-98`，只读），或者读 `fetchWorkspaces` 里的 `pinnedAt`。推荐读后者，不依赖文件。

### D4. 计算规则

- 照搬 `claude-capacity.py:61-76`（Yang 2026-11-06 定）。
- pace 只算五小时窗口：`pace = 已用% / 窗口已过时间%`。`pace ≤ 1` 时保持基础容量；否则 `floor(基础容量 / pace)`。
- 五小时窗口的 `resetsAt` 改为从实时报告读，不再需要手工传 `--reset`。
- 五小时剩余为 0 时，有效容量为 0。
- 周额度剩余 ≤ 5% 时，有效容量为 0，并且触发迁出（E 节）。

### D5. 输出结构（RPC `capacity.snapshot`，webhook 事件也用这个结构）

```jsonc
{ "generatedAt": "...", "host": "macmini", "totalCanAdd": 3, "recommendedProvider": "claude-8",
  "accounts": [{ "provider": "claude-8", "tier": "max", "baseCap": 4, "warmup": false,
     "fiveHour": { "remainingPct": 62, "resetsAt": "..." }, "weekly": { "remainingPct": 40, "resetsAt": "..." },
     "live": true, "fetchedAt": "...", "load": { "total": 2, "running": 1, "agentIds": ["..."] },
     "pace": 0.8, "effectiveCap": 4, "canAdd": 2, "reason": "on/under pace" }],
  "excluded": [{ "provider": "claude-12", "reason": "tier unknown" }] }
```

---

## E. 换号迁移

### E1. 触发条件（只看实时值）

- (a) 五小时窗口剩余为 0；或者主会话某轮失败，报错命中 `isQuotaError`（`resume.ts:16-17`），且实时报告确认五小时窗口为 0。
- (b) 周窗口剩余 ≤ 5%。
- (c) 跳过以下会话：带 `dsh.lb=manual`（Yang 点名、指定账号）；没有 `role=main` 或 `need` 标签；工作区未置顶；已有未过期的租约（E5）。
- 五小时窗口即将重置时是等待还是换号，见 H2。

### E2. 目标账号

- 候选条件：档次已核实；`canAdd ≥ 1`；实时值显示周剩余 ≥ 20%、五小时剩余 ≥ 30%。比触发阈值高一截，用来防止来回迁。
- 排序：`canAdd` 降序 → 周剩余降序 → Max 优先。
- 没有候选账号时不迁移，发 `lb_exception {reason:'no_target'}`。改用 Codex 兜底属于例外，由负载均衡 bot 处理。

### E3. 步骤

1. **加租约**：在原会话上 `updateAgent(labels:{'dsh.migration-lease':'plugin:<到期时间>:<随机串>'})`，2 秒后读回；如果被对方覆盖，就退出。
2. **停住原会话**：
   - 周额度 ≤ 5%（原会话还能回复）：`sendAgentMessage` 发停止消息（`daemon-client.d.ts:994`）。订阅原会话时间线，最多等 10 分钟，等它回复确认。超时就记录「未确认停止」并中止，交给 bot。
   - 五小时额度耗尽（原会话无法回复）：先 `cancelAgent`（`daemon-client.d.ts:1001`），再关掉该会话的到期自动继续。自动继续服务 `ResumeService.setEnabled(id,false)` 在 `resume.ts:115`，现在由 RPC `quotaSetAutoResume` 调用（`usage-claude-accounts/index.ts:83`），要给迁移模块暴露一个服务接口。
3. **新建会话**：在同一工作区调用 `client.createAgent({ workspaceId, provider:'claude-N/<model>', modeId:'bypassPermissions', title, labels:{need, role:'main'}, initialPrompt })`。参数支持见 `daemon-client.d.ts:198-221`。不传 `env`。
4. **交接词**：模板文件路径写在 `machine.json` 的 `capacity.migration.handoffTemplate`，内容按 `migration-template.md`。插件只自动填事实：需求单号、工作区、原会话 id、原会话最后一条用户消息原文（时间线取 `user_message`）、原会话待答提问原文和状态（`pendingPermissions`）、现行常设授权说明。其余（读 issue 全部评论、`paseo logs <原会话> --tail 150`）要求新会话自己做。禁止写入已作废的审批禁令（super-agent 技能第 8 节）。
5. **收尾**：复用 C3。
6. **验证新会话**：20 到 40 秒后读首条输出。出现限额或付款提示就归档新会话，换下一个候选账号，最多试 2 个（super-agent 技能第 4 节）。
7. **处理原会话**：新会话确认运行后，归档原会话（`archiveAgent`，`daemon-client.d.ts:948`）。原因是置顶工作区里的会话都按主会话判定，不归档会出现两个主会话。本机子会话的父会话标签可以改指新会话（`updateAgent`），也可以让新会话自己接管，见 H5。
8. **报告**：发 `main_migrated {oldAgentId, newAgentId, fromProvider, toProvider, reason, needId}` 给总控，由总控更新 issue 和巡检名单。不通知 Yang。只有失败（`lb_exception`）才由总控决定要不要升级给 Yang。

### E4. 失败回退

- 第 3 到 6 步失败：原会话没有归档，恢复它的自动继续设置，释放租约，发 `lb_exception`。
- 每个会话最多迁移一次；30 分钟内同一个会话不再触发。
- 审计写入 `capacity/migrations.jsonl`，记录每一步的输入、结果和耗时。不记录邮箱、host 或密钥。

### E5. 和负载均衡 bot 的互斥

- 租约标签 `dsh.migration-lease=<owner>:<到期时间>:<nonce>`，有效期 30 分钟。标签不能删除，所以释放时写成 `released:<时间>`（不能删的原因是 `updateAgent` 会丢掉空标签对象，见 `daemon-client.js:2046`）。
- 插件处理不了的情况，在原会话上写 `dsh.lb=exception:<原因>`，再发 `lb_exception`。
- 插件发给负载均衡 bot 专用 webhook 的额度报警（`quota.ts:1-2、374-384`）：对插件正在处理的会话，加字段 `handledBy:'plugin'`，避免 bot 重复迁移。
- **对 bot 的要求清单**：
  1. 迁移前读 `dsh.migration-lease`：未过期且 owner 不是 bot，就不动。
  2. bot 自己迁移时同样写租约并读回，结束后写 `released`。
  3. 只处理带 `dsh.lb=exception` 的会话、`lb_exception` 事件、非 Claude 主会话和 Codex 兜底。
  4. 收到带 `handledBy:'plugin'` 的额度报警时，只记录。
  5. bot 改走插件的 `capacity` 事件或 RPC 后，可以停掉自己的 `watch.py` 告警分支（由 Yang 决定）。

### E6. 开关

- `capacity.migration.mode`：`off`（默认）、`shadow`、`live`。
- 影子模式：完整计算触发条件和目标账号，写 `migrations.jsonl`，发 `main_migrated{shadow:true}` 给总控，**不做任何写操作**（不加租约、不停会话、不建会话）。
- 建议影子模式跑满 3 天，和 bot 的实际迁移逐条比对后，再切 `live`。

---

## F. 余量反馈给总控

- **通道**：同一个 Grok webhook（`escalation.webhook`），新事件 `capacity`，负载用 D5 的结构。要在 `EventName` 联合类型（`protocol.ts:1-12`）里加上 `capacity`、`main_finalized`、`main_migrated`、`lb_exception`，并在 `deliveryClass`（`routing.ts:5-11`）里把这四个事件路由到 grok。这几个事件和主会话判定无关，要绕过 `deliver.ts:44` 的主会话检查（`agentId` 为空，现在已经不会被这条检查拦下，需要测试确认）。
- **推送时机**：用 `{provider: canAdd}` 计算签名，签名变化且距上次推送 ≥ 5 分钟时推送；另外每 6 小时发一次心跳。迁移和收尾完成后立即重算一次。
- **去重**：`Idempotency-Key` 用 `capacity:<签名>:<小时桶>`。签名不变时不重发。
- **总控侧要求**：收到 `capacity` 后只更新自己的数据。要派发新主会话时，先按 `totalCanAdd` 和 `recommendedProvider` 向 Yang 请示，请示前不派发。这要改 Grok 侧 routine（`popup-wakeup.md` 现在只处理 A 到 F 六类事件），见 H6。
- **预筛脚本**：如果配置了 `escalation.prefilter`，它可能拦掉不认识的事件（**待核实**脚本行为）。

---

## G. 模块划分、文件、开关、测试和分期

### G1. 文件清单

| 文件 | 内容 |
|---|---|
| `server/presence.ts`、`server/questions.ts`、`shared/presence.ts`、`server/todo.ts`、`client/*` | A 节删除和改文案 |
| `server/modules/answer-escalation/{runtime,webhook,deliver}.ts`、`server/notify/{engine,protocol,routing}.ts` | B 节追加字段、外部提问入口、新事件类型 |
| `server/core/main-session-finalize.ts`（新） | C3 的纯步骤函数，输入 DaemonClient 的五个方法，可以单测 |
| `server/modules/dispatch-finalize/index.ts`（新，模块 id `dispatch.finalize`） | 订阅会话列表，触发收尾；RPC `dispatch.finalize`、`dispatch.snapshot` |
| `server/modules/usage-claude-accounts/account-map.ts`（新，从 `quota-labels.ts` 抽出） | Provider 到账号的映射 |
| `server/modules/capacity/{model,live-quota,migrate,lease,index}.ts`（新，模块 id `capacity.mainSessions`） | D、E、F 节 |
| `shared/capacity.ts`、`shared/dispatch.ts`（新） | RPC 契约 |
| `server/modules/index.ts:20-34` | 注册两个新模块 |
| `config/machine.example.json`、`docs/answer-usage-modules.md`、`OVERVIEW.md` | 配置示例和说明（只改现有文档） |

不改 `server/vendor/`。不改 `~/.paseo/projects/workspaces.json`。

### G2. 开关默认值

- 两个新模块都在代码里默认关闭，和现有模块的约定一致（`docs/answer-usage-modules.md` 开头一节）。
- Mac mini 的 `machine.json` 打开：`dispatch.finalize: true`、`capacity.mainSessions: true`，`capacity.migration.mode: shadow`。
- MacBook 保持关闭，因为 Claude 主会话只建在 Mac mini。

### G3. 分阶段交付（四个 PR，前两个可以并行）

| PR | 内容 | 依赖 | 验收方法 |
|---|---|---|---|
| 1. 停止代答，补网页提问升级 | A 节，加 B4 的 `enqueueExternal` | 无 | `npm run check` 通过；手动离线时，有推荐项的测试提问不被作答、不播语音、出现在待办、webhook 收到 asked；网页提问能升级，也能结束 |
| 2. 通知负载扩展 | B 节字段、`audience` 分类、新事件类型骨架 | 无（和 PR 1 只在 `questions.ts` 改名处冲突，后合并的一方变基） | `escalation-webhook.test.ts` 快照新增字段，旧字段不变；用 `escalation.test-webhook` 和一条真实提问核对负载；`audience` 分类的正反用例都覆盖 |
| 3. 本机派发收尾 | C 节 | PR 2 的事件骨架 | 单测：每步跳过和执行、读回失败、重试。`npm run test:daemon`：在测试工作区上给会话打 `role=main` 标签后，自动完成解绑、置顶和打标签，并逐项读回；重启插件不重复执行。同时验 C1 的三个待核实项 |
| 4. 容量模型、余量反馈、迁移（影子） | D、E、F 节 | PR 2、PR 3 | 单测：实时和历史判定、pace、未知档次排除、目标排序、租约冲突、各步失败回退。上线后 `capacity.snapshot` 和 `claude-capacity.py` 逐账号对比；影子模式 3 天的记录和 bot 实际迁移对比，由 Yang 决定是否切 live |

---

## H. 需要 Yang 或总控决定的问题

1. **验收和合并类提问是否仍标「仅限 Yang 本人」**。现行规则：合并和发布有常设授权（CURRENT-RULES）；`questions.ts:69` 仍然把它们当作人工确认。
   - 推荐：合并和发布**不标**；「最终验收」和「复盘审阅」**标**。
2. **五小时额度耗尽、恢复点很近时，是等待还是换号**。super-agent 技能第 8 节写「1 小时内留守等待」，本期口径写「用尽即换号」。
   - 推荐：恢复点 ≤ 30 分钟时等待（交给现有自动继续），其余情况换号。
3. **「Yang 点名的主会话」怎么处理**。
   - 推荐：可以在 Mac mini 的 Claude 账号之间均衡，但不降到非 Claude。Yang 点名到具体账号时，打 `dsh.lb=manual`，不自动迁移；耗尽时发 `lb_exception`。
4. **迁移后原会话的处理**。
   - 推荐：新会话确认运行后归档原会话。原因是置顶工作区里的会话都会被当作主会话，不归档会重复升级，停滞判定也会受影响。
5. **本机子会话的父会话标签由谁改指新主会话**。
   - 推荐：插件直接改，用 `updateAgent` 并读回，比交给新主会话可靠。
6. **总控（Grok 侧）routine 的修改**：识别新字段和四个新事件；收到 `ownerOnly` 的提问时不代答；按 `capacity` 请示后才派发。这些需要 Yang 授权由总控修改自己的 routine。
   - 推荐：PR 2 合并后同步修改。
7. **负载均衡 bot 的修改**：E5 的要求清单，需要 bot 侧配合。在 bot 改完之前，插件迁移**只能停在影子模式**。
   - 推荐：先改 bot，再把插件切到 live。
8. **「本机确认」的关键词**（来源主机、仍要运行）需要 Yang 提供一两条真实弹窗原文，用来校准规则。

### 待核实汇总

- `detachAgent` 是否清除两个父会话标签。
- `updateAgent` 的合并语义。
- 插件建的会话不调 `agent open` 是否可见。
- `cloud-session` 提问是否触发 `agent.permission.before` 钩子。
- `planLabel` 对 Max 和 Pro 的具体取值。
- 每日任务会话是否带 `role=main` 标签。
- 预筛脚本和 Grok 侧是否接受新字段和新事件。
- `listUsageReports` 中 `forceRefresh` 的限流阈值。

---

## 主会话审核意见（2026-11-10，第一轮）

- H1 采纳推荐：合并、发布不标「仅限 Yang 本人」；最终验收、复盘审阅、每日任务、本机确认、登录验证、资金、清理删除标。
- H2 不采纳推荐，按一期口径：五小时额度用尽即换号，不加「恢复点很近时等待」。被迁出的会话关闭到期自动继续。
- H3、H5 采纳推荐。
- H4 采纳：新会话确认运行后归档原会话（归档可恢复，不属于删除；与“插件不做需求完成后的归档收尾”不冲突，后者指需求做完后的工作区收尾）。
- H6、H7（改总控 routine 和负载均衡 bot）属于提示词修改，须 Yang 授权，已提问。授权前迁移只跑影子模式。
- H8 由细化会话从本机历史会话日志里找「来源主机」「仍要运行」弹窗原文。
- F 节预筛待核实项已核实：`Macmini/dsh-webhook-filter/prefilter.py` 只会 suppress 已登记项目的 `new_workspace`，其他事件一律 push，新事件不会被拦。
