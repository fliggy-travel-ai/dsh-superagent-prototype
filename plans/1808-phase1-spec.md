# 开发自动化插件一期：定稿（主会话审核，2026-11-10）

本文是开发依据。细节见 `1808-phase1-draft.md`（雏形，含主会话审核意见与 Yang 决定）和 `1808-phase1-refine.md`（实测核实）。三者冲突时，按本文 → 雏形末尾「Yang 决定」→ 细化文件 → 雏形正文的顺序取。

## 范围（不加范围）

要做：
1. 插件不再自动代答，只发现提问、在场时语音提醒、通知总控。
2. 派发主会话时本机收尾：标签、解绑、置顶、「主会话」工作区标签。
3. 按实时额度和 Max/Pro 容量自动换号。
4. 把可承接会话数反馈给总控。

不做：改工作区标题或阶段；需求完成后的归档收尾；「需求未完成但主会话没了」告警；磁盘、内存、僵尸会话、每日任务监控。

## 定稿决定

### 问答与通知（工作包 A）
- 按雏形 A 节删除自动代答全链路（含「已读」「代答未读」）。离线 = 不播语音、进人工待办、照常升级。界面写明「插件不代答，代答由总控决定」。
- 网页（浏览器扩展）提问补进升级通道（雏形 A4 `enqueueExternal` / `closeExternal`），`answerVia='browser-only'`。云端会话提问已在升级通道内（细化第 6 节已核实）。
- webhook asked 负载按雏形 B2 追加字段，`schemaVersion` 保持 1。`prompts` 覆盖 `AskUserQuestion`、`request_user_input`、`request_user_input_async`。`questionSummary.text` 改为第一个问题的正文（不再用请求 title「Question」）。
- `audience.ownerOnly` 分类：
  - `daily_task`：会话带 `paseo.schedule-id`；或父会话带 `paseo.schedule-id`；或工作区标题以「【每日」开头。不按「标题含每日」判断。
  - `retro_review`：工作区阶段【复盘待审】；或问题同时含「复盘」和「审阅/审核/通过/意见/去留」。
  - `local_confirm`：关键词「仍要运行」「Open Anyway」「软件阻断提醒」「隐私与安全性」「Touch ID」「认证窗口」「在 MacBook 前」「在 Mac Mini 前」「本人完成」。不含「来源主机」。关键词放 `machine.json` 的 `ownerOnly.localKeywords`，代码带默认值。
  - `final_acceptance`：最终验收结论。
  - `login_verification`、`payment`、`destructive_cleanup`：复用原 `automaticAnswerBlockReason` 规则（改名 `ownerOnlyReason`）。
  - 合并、发布类提问**不**标 ownerOnly（常设授权）。
- 工作包 A 拥有：`server/presence.ts`、`server/questions.ts`、`shared/presence.ts`、`server/todo.ts`、`client/*`、`server/modules/answer-*`、`server/modules/answer-escalation/webhook.ts` 与 `runtime.ts` 的 asked 富化、相关测试。

### 收尾、容量、迁移、余量（工作包 B）
- **本机收尾**（雏形 C + 细化第 10 节 C 部分）：
  - 触发：会话有 `role=main`，并有 `need` 或 `issue` 单号标签；会话创建钩子即时触发 + 会话列表订阅 + 5 分钟兜底扫描。每个会话只收尾一次，状态持久化；Yang 手动取消置顶后不再置顶回去。
  - 步骤：校验 → 解绑（`detachAgent`）→ 未置顶才 `setWorkspacePinned(true)` → 没有「主会话」标签才 `setWorkspaceLabel` → 读回（只要求 `paseo.parent-agent-id` 消失）→ 记录 `finalize/events.jsonl` → 发 `main_finalized`。不调 `agent open`。不碰 `workspaces.json`。
  - RPC `dispatch.finalize {agentId}` 供手动重试。
- **容量模型**（雏形 D + 细化 D 部分）：
  - 实时额度：`listUsageReports().reports`，`status=available` 且 `fetchedAt` ≤ 10 分钟才算实时；不用 `forceRefresh`。历史值只显示，不参与决策。五小时窗口 `resetsAt` 为空 = 窗口未开始，pace=0。只看 `five_hour` 和 `weekly`。
  - **档次以实时 `planLabel` 为准**：`/^Max\b/` → max（基础容量 4），`/^Pro\b/` → pro（基础容量 2）。`machine.json` 的 `capacity.accounts` 只用来确认或钉住；配置与 planLabel 冲突、planLabel 缺失、或出现 Max 5x 以外的 Max 档（如 Max 20x）时记为 unknown，不参与分配，并在快照 `excluded` 中给出原因。
  - 负载：置顶未归档工作区中、未归档、未关闭、属于该账号的会话。快照同时给出 `active_sessions` 对账数。
  - pace 收紧、预热减半照 `claude-capacity.py`。
- **换号迁移**（雏形 E + Yang 决定 + 细化 E 部分）：
  - 触发：五小时剩余为 0（用尽即换，不等恢复）；或周剩余 ≤ 5%。只迁 `role=main` 且有 `need`/`issue` 的会话。被点名到具体账号的会话带 `dsh.lb=manual`，不迁，耗尽时发 `lb_exception`。
  - 目标：档次已核实、`canAdd ≥ 1`、实时五小时 ≥ 30%、周 ≥ 20%；排序 canAdd → 周剩余 → Max 优先。目标只在 Mac mini 的 Claude 账号里选。无目标时（Yang 2026-11-10 改）：不发 `lb_exception`、不请示总控，默认等原账号额度恢复——五小时用尽时打开原会话自动继续，窗口重置后续跑；之后每轮照常重试换号，有账号腾出容量就换。审计记 `result=no_target, action=wait_for_reset`。
  - 步骤：内部迁移锁标签 `dsh.migration-lease`（释放写 `released:<时间>`）→ 停原会话（周额度场景发停止消息等确认，最多 10 分钟；五小时用尽场景 `cancelAgent` 并关自动继续）→ `createAgent` 同时传 `cwd`（原会话 cwd）与 `workspaceId`，沿用原单号标签键并加 `role=main`，不传父会话标签，不传 env → 交接词（模板见雏形 E3 第 4 步，禁止写作废审批禁令）→ 收尾复用上面的本机收尾 → 20–40 秒看首条输出（正文、工具调用、思考、任务列表任一项都算开工；只要出现额度或付款报错就判限额），出现限额或付款提示就归档新会话、换下一个候选，最多 2 个 → 新会话正常后，本机子会话改挂新会话（同时写 `paseo.parent-agent-id` 和 `paseo.parent-server-id`），再归档原会话 → 发 `main_migrated`。
  - 失败回退：原会话不归档，恢复自动继续，释放锁，发 `lb_exception`。同一会话 30 分钟内不重复触发。审计 `capacity/migrations.jsonl`，不记邮箱、host、密钥。
  - 开关 `capacity.migration.mode`：`off`（代码默认）/ `shadow` / `live`。部署后 Mac mini 先用 `shadow`；负载均衡 bot 的换号职责移除后切 `live`。
- **余量反馈**（雏形 F + 细化 F 部分）：webhook 新事件 `capacity`，签名含每账号 `canAdd` 与 `live`，变化且距上次 ≥ 5 分钟推送，6 小时心跳；附每账号 `fetchedAt`。
- 新事件 `capacity`、`main_finalized`、`main_migrated`、`lb_exception` 都走 Grok webhook，不受主会话判定拦截。成功的收尾和迁移只通知总控。
- 工作包 B 拥有：`server/notify/protocol.ts` 与 `routing.ts` 的新事件、`server/modules/dispatch-finalize/`、`server/modules/capacity/`、`shared/capacity.ts`、`shared/dispatch.ts`、`server/modules/usage-claude-accounts/account-map.ts`（从 `quota-labels.ts` 抽出）、`server/modules/index.ts` 注册、`config/machine.example.json`、相关测试。

### 两个工作包的交界
- `server/notify/engine.ts` 的 `Notice.extra` 可选字段由 A 加；B 的新事件需要时也可用。双方都改 `docs/answer-usage-modules.md` 和 `OVERVIEW.md` 时只改各自章节。后合并的一方变基解决冲突。
- 两个新模块代码默认关闭；Mac mini `machine.json` 开 `dispatch.finalize`、`capacity.mainSessions`。MacBook 不开。

## 交付与验收
- 每个工作包一个 PR，目标分支 `main`，PR 正文引用 deepseek-harness#1808。合并前 `npm run check`（插件目录）通过，PR 需要独立审阅。
- A 验收：手动离线时，有推荐项的测试提问不被作答、不播语音、出现在待办、webhook 收到含 `prompts` 和 `audience` 的 asked；网页提问能升级也能结束；每日任务提问 `audience.category=daily_task`。界面改动附截图或 GIF。
- B 验收：单测覆盖收尾各步跳过/执行/读回失败、实时与历史判定、planLabel 档次、pace、目标排序、迁移锁、各步失败回退。真实 Mac mini daemon 上：给测试会话打 `role=main`+`need` 后自动解绑、置顶、打标签并读回；`capacity.snapshot` 与 `claude-capacity.py` 逐账号对比；影子模式迁移记录合理。
- 部署到 Mac mini 由主会话安排。切 `live` 前通知总控移除负载均衡 bot 的换号职责，并交给总控 routine 配套修改说明。
