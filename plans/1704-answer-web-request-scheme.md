# 网页作答（answerWebRequest）最终方案

需求：fliggy-travel-ai/deepseek-harness#1704 与 #1707 的交接部分。
基线：`origin/main` = `021ed85`（插件内容等于两台 Mac 部署的 `db43b07`）。分支 `1704-answer-web-request`。
输入：方案雏形（主会话本地 `plans/odd/scheme-draft.md`）；用户决定 #1704 评论 6720538414（分层）、6720692225（本方案第 7 节三个问题和测试会话）；商定接口 #1704 评论 6717458097、6717464101。
状态：主会话已审核同意（2026-11-08）。代码由 MacBook 的 Argon 会话从第 5 节步骤 1 开始写。第 6.2 节真实页面取证已完成，第 2.9 节已按样本修订。

---

## 0. 与雏形相比的主要变化

1. **按用户决定重新分层。** 同步层：云端钩子把请求同步到 Paseo。决策层：插件的在线离线问答（`PresenceRuntime`）对云端提问和其他 Paseo 提问一样处理：在线时语音提醒、等待回答；离线时只选明确推荐项。执行层：`answerWebRequest` 在 claude.ai 页面上点选。雏形里“云端人工请求排除所有自动路径”作废。
2. **权限请求不经 Paseo 执行。** 浏览器扩展继续在 claude.ai 上自动点“允许一次”。Paseo 里的权限请求只显示；在 Paseo 里作答不点击页面，时间线提示到 claude.ai 核对。云端记录到工具结果后关闭请求（现有 `resolve`）。雏形中的权限框定位、一次性按钮判定、拒绝按钮、自动允许排除（`gateApproval`、`managedSessions`）全部删除。
3. **复用现有网页提问通路，不新建扩展执行端。** 扩展已有完整通路：`questions.js` 读取页面提问 → 后台在 `POST /sync` 里上报 → `PresenceRuntime.browserSync` 建网页提问 → 同步响应下发 `decisions` → 后台 `dispatchDecisions` 在原标签页点选 → 下次同步上报 `results`。页面上有提问时，扩展每 2 秒同步一次（`background.js` 的 `questionPoll`）。网页作答只把云端提问的答案“转交”给对应的网页提问。雏形中的 `web-request-worker.js`、`web-request.js`、`webJobs`/`webResults` 报文、`nextSyncMs` 快速同步、同步插槽全部删除。
4. **不拦截云端会话回答自己的请求**（用户决定）。
5. **多标签页**：同一浏览器环境里的多个标签页由现有后台逻辑合并（同一提问编号只记第一个标签页），只点一次。多个浏览器环境同时打开同一会话时返回 `unknown`（用户默认值）。
6. **第一版支持“其他”自由文本、单选、多选、一次多个问题**（用户决定第 7.2 条）。Paseo 原生提问界面和插件人工待办都能输入自由文本；页面上写入“其他”输入框。
7. **人工回答不按关键词拦截**（用户决定第 7.3 条）。扩展 `questions.js` 的关键词拦截只对自动代答生效。

与 #1727 的接触面：`shared/browser.ts` 末尾一行、`server/browser-bridge.ts` 末尾两个方法、`index.server.ts` 注入行、`background.js` 的 `cleanQuestion`/`cleanDecision` 两个函数内部（#1727 只在消息入口追加，不碰这两个函数）。

---

## 1. 数据流

### 1.1 云端提问（AskUserQuestion）

```
claude.ai 页面显示提问
 ├─ 扩展 questions.js 读到 → 同步上报 → PresenceRuntime 建“网页提问”（来源 browser）
 │     该会话属于云端会话 → 永不自动作答；已有对应云端提问时隐藏（转交给云端提问）
 └─ 云端钩子 → cloud-session.request.notify → Provider 发原生请求（显示副本每题带 allowOther）
       → PresenceRuntime 建“原生提问”（来源 native，provider=cloud-session）
         在线：语音提醒，等待用户在插件人工待办或 Paseo 原生界面回答（都能填“其他”）
         离线：只选明确推荐项（沿用 automaticAnswerBlockReason 的拦截；自动代答不填“其他”）
       → port.respond → Paseo → Provider answer()
       → 规范化 → { answers: 问题原文 → 标签数组, otherAnswers: 问题原文 → 文本 }
       → answerWebRequest → 执行器
         → 找到对应网页提问（同一会话、问题结构完全相同、唯一）
         → PresenceRuntime 把答案作为该网页提问的 decision 下发（带 otherAnswers 和 source）
         → 扩展 dispatchDecisions + questions.js answer() 复核后点选、填写“其他”、提交
         → 下次同步回执 → 执行器返回 submitted / unknown
       → 云端工具结果 → cloud-session.request.resolve → 关闭 Paseo 请求，审计记“云端已确认”
```

### 1.2 云端权限请求

```
claude.ai 页面显示权限框
 ├─ 扩展 approval.js 自动点“允许一次”（现有行为，不改）
 └─ 云端钩子 → notify → Paseo 显示权限请求（只显示）
       Paseo 里作答 → Provider answer() → answerWebRequest 立即返回 unknown（tool_in_browser）
       → 时间线：“权限请求由 claude.ai 页面处理，Paseo 里的回答没有提交，请在 claude.ai 核对”
       → 云端工具结果 → resolve 关闭请求
```

原生权限自动审批（`server/automation.ts:23`）只处理 `provider === 'claude'`，不处理云端请求。不改，补一条测试。

---

## 2. 组件设计

### 2.1 共享类型（新文件 `shared/web-request.ts`）

- 商定接口原样：`WebRequestContext`、`WebRequestAnswer`、`WebRequestResult`、`AnswerWebRequest`。`answers` 的值统一规范为标签数组（接口允许 `string | string[]`，执行器入口再规范一次）。
- 审计记录 schema 和只读 RPC `web-request.audit`（输入空对象，输出最近 300 条）。
- `shared/browser.ts` 末尾追加一行重新导出这些类型，满足“类型放在 shared/browser.ts”。
- `server/cloud-session/index.ts` 删除本地类型，改为引用共享类型。

### 2.2 自由文本的模型（贯穿全部层）

每道题的答案是 `{ labels: string[], other?: string }`，在报文里拆成 `answers[问题原文] = labels` 和 `otherAnswers[问题原文] = other`。规则（`server/questions.ts` 的 `validateAnswers` 统一校验）：

- `other` 去掉首尾空白后非空，最长 2000 字符；只在该题 `allowOther` 为真时允许。
- 单选：`labels.length + (other ? 1 : 0) === 1`，即选一个选项或只填“其他”。
- 多选：至少一个标签或一段“其他”文本；可以同时有。
- 标签必须是原题选项，不能重复。
- 自动代答（离线推荐项）从不填写“其他”。

`allowOther` 的来源：

- 原生 `AskUserQuestion`（云端和 Claude Code 本地会话）：`nativePrompts` 设为真。Claude Code 的 `AskUserQuestion` 本来就接受自由文本答案。`request_user_input` 系列保持假。
- 网页提问：`questions.js` 在该题找到“其他”输入框时设为真（第 6.2 节样本确定识别规则）。

### 2.3 回答规范化（新文件 `server/web-request/normalize.ts`）

`toWebAnswer(expected, response)` 把 Paseo 交回的回答转为 `{ answers, otherAnswers }`。两种输入格式：

1. **结构化格式（插件人工待办和离线代答发出）。** `updatedInput.answers` 为“问题原文 → 标签数组”，`updatedInput.otherAnswers` 为“问题原文 → 文本”。原样校验后采用。插件给云端请求回答时只发这种格式（见 2.6）。
2. **Paseo 原生界面格式。** Paseo 0.15 前端 `buildQuestionFormAnswers` 交回 `answers`：键是 `header`，值是字符串；多选标签用 `", "` 连接；“其他”文本在单选时替换标签，在多选时接在标签后面。只有题目带 `allowOther` 时界面才显示“其他”输入框，所以 Provider 发给 Paseo 的显示副本给每题加 `allowOther: true`（2.7）。解析：
   - 键先按原文、再按唯一 `header` 对上一道题；对不上就拒绝。`header` 重复时不用它作键。
   - 单选：整串等于一个标签就取标签，否则整串作为“其他”文本。
   - 多选：从开头用已知标签集合做动态规划，取能匹配的最长标签序列（标签本身可能含 `", "`，不按逗号硬切）。整串都是标签时全部作为标签；剩余部分（去掉分隔的 `", "`）作为“其他”文本。最长序列不唯一时拒绝。
   - 已知限制：多选时用户在“其他”里输入的文字恰好等于某个选项标签，会被当作选中该选项。在插件人工待办里作答没有这个问题。
3. `response.behavior === 'deny'`（Paseo 里点“忽略”）：不点击页面，返回 `unknown`（`dismissed`），时间线提示到 claude.ai 处理。
4. 结果交给 `validateAnswers` 规则校验（2.2），不通过返回 `unknown`（`invalid_answer`）。

### 2.4 答案来源登记（新文件 `server/web-request/ledger.ts`，约 40 行）

- `PresenceRuntime.performAnswer` 对云端提问调用 `port.respond` 之前，登记 `(webSessionId, toolUseId, 规范化答案摘要) → source`，`source` 为 `user`（插件人工待办）或 `automatic`（离线代答）。
- 执行器按同一键取来源；取不到就记 `paseo`（经 Paseo 原生界面或其他会话的 `respond_to_permission` 收到，来源未确认）。审计里只有 `user` 才算确认来自人工。
- 下发给扩展的 decision 只区分 `automatic` 和 `manual`（`user`、`paseo` 都是 `manual`），用于关键词拦截（2.9）。理由：用户决定“遵循 Paseo 现有能力”，Paseo 本身不按关键词限制作答。
- 只存内存，最多 500 条，10 分钟过期。

### 2.5 执行器（新文件 `server/web-request/executor.ts`，约 200 行）

`BrowserBridge.answerWebRequest(request)` 只转调执行器。执行器依赖两个只读视图：桥接的各环境最近同步记录，在线离线运行时的网页提问清单。

1. **校验。** `webSessionId` 必须匹配 `^session_[A-Za-z0-9_-]+$`，去前缀得到扩展用的内部编号。`kind: 'tool'` 直接返回 `unknown`（`tool_in_browser`）。`expected.toolName` 不是 `AskUserQuestion` 返回 `unknown`（`unsupported_tool`）。答案按 `expected.input.questions`（`allowOther` 视为真）和 2.2 规则再校验一次。
2. **去重。** 键为 `内部编号 + toolUseId`，保存 `expected` 和答案摘要（含 `otherAnswers`）。同键同摘要返回同一个进行中的 Promise 或上次结果；`expected` 不同返回 `unknown`（`request_changed`）；答案不同返回 `unknown`（`answer_changed`）。任何结果都不重发。
3. **选浏览器环境。** 读取桥接记录的会话清单（含 `instanceId`、`lastSeenAt`）：
   - 70 秒内同步过的环境为“新鲜”（扩展闹钟 60 秒 + 10 秒余量）。
   - 没有环境在 150 秒内同步过：`unknown`（`bridge_not_connected`）。
   - 有环境在 70～150 秒之间同步过、且新鲜环境都没有这个会话：`unknown`（`scan_stale`）。
   - 新鲜环境都没有这个会话、没有陈旧环境：`page_not_open`。
   - 两个以上环境打开了这个会话：`unknown`（`multiple_instances`）。
   - 恰好一个新鲜环境打开了这个会话：选它。
4. **找网页提问。** 在该环境、该会话的网页提问里，先按 `toolUseId` 过滤（网页提问带编号时必须与请求相同，见第 6.2 节第 2 条），再找问题结构与 `expected.input.questions` 完全相同的一条：题数和顺序、每题原文（压缩空白后）、单选或多选、选项标签集合都相同（页面上的“其他”项不算选项；标签比较规则按第 6.2 节样本确定）。有“其他”文本的题，网页提问该题必须 `allowOther` 为真，否则 `unknown`（`other_not_on_page`）。网页提问必须在 10 秒内被扫描到过。
   - 没找到时最多等 10 秒（页面上有提问时扩展每 2 秒同步一次）。仍没找到：该会话本次扫描完整（`observedSessionIds` 含它）时返回 `unknown`（`not_found`），否则 `unknown`（`scan_incomplete`）。
   - 找到两条以上：`unknown`（`multiple_candidates`）。
5. **转交。** 调用 `PresenceRuntime.delegateBrowserAnswer(网页提问编号, answers, otherAnswers, source)`。它在现有 `decisions` 表里放入这条答案，不受在线离线模式限制（决策已在上游完成），但仍受“暂停”、模式切换代次、插件停止的约束。之后走现有通路：同步时下发（5 秒有效期）、扩展复核后点击、下次同步回执。
6. **等待结果。** 每 500 毫秒读一次该网页提问的状态：
   - 出现 `browserSubmittedAt`：返回 `submitted`。
   - 状态变为 `unknown`：返回 `unknown`（`page_unknown`：扩展复核失败、过期、提交按钮不唯一等）。
   - 20 秒内没有下发：撤销 decision，返回 `unknown`（`not_claimed`）。
   - 下发后 15 秒没有回执：返回 `unknown`（`no_receipt`）。迟到的回执只写审计。
7. **云端确认。** Provider 的 `resolve` 把 `outcome` 交给执行器，审计记“云端已确认”。

插件重启时执行器内存清空。这时 Provider 的待处理请求也已丢失（同为内存），`PresenceRuntime` 启动时把已提交的问题改为结果未知（现有逻辑）。扩展侧已有持久去重（`questionState.handled`），不会二次点击。

### 2.6 在线离线运行时和问答工具（改 `server/presence.ts`、`server/questions.ts`、`shared/presence.ts`）

1. **云端提问按普通提问处理。** 删除 `manualCloud` 判定（`presence.ts` 第 168、170、171 行的云端分支）和 `performAnswer` 第 268 行“自动回答跳过云端请求”。离线模式下云端提问可以自动选明确推荐项；`automaticAnswerBlockReason` 的验收、合并、登录、资金、清理拦截保持不变。
2. **云端提问答复后保持“已提交”。** `performAnswer` 对云端请求调用 `port.respond` 后，状态保持 `submitted`，原因“已交给浏览器执行，等待云端确认”（现在是直接 `resolved`）。云端关闭请求后，`scan()` 第 155 行把它改为 `resolved`，原因“云端已记录结果”。
3. **登记答案来源。** 调用 `port.respond` 前写入 2.4 的登记表。
4. **云端会话的网页提问永不自动作答**（用户决定第 7.1 条）。云端会话集合取自两处：会话清单里 `provider === 'cloud-session'` 的 agent 的 `cloud-session.id` 标签（`cse_<后缀>` → 内部编号 `<后缀>`）；待处理原生请求的 `metadata.webSessionId`。属于这个集合的网页提问：
   - 有结构相同的待处理云端提问时，设 `delegatedTo`（原生提问编号），不在人工待办里显示，不处理。
   - 没有对应云端提问时（钩子约 3 秒的通知延迟，或同步失败），仍显示在人工待办，原因“云端会话提问，等待同步到 Paseo；只接受人工回答”。离线也不代答。
   - 分页提问（`pages > 1`）在网页侧只能读到当前页，题目不完整：不在人工待办里接受作答，原因“多题提问，请在 Paseo 云端提问或 claude.ai 作答”；非云端会话的分页提问也不离线代答。
5. **自由文本。**
   - `QuestionPromptSchema` 加可选字段 `allowOther`；`QuestionAnswerSchema` 加可选字段 `otherAnswers`（问题原文 → 文本），`answers` 每题的数组允许为空（由 `validateAnswers` 按 2.2 校验）。`BrowserDecisionSchema` 加 `otherAnswers`（可选）和 `source`（`automatic` | `manual`）。`BrowserQuestionSchema` 加可选字段 `toolUseId` 和 `pages`（分页提问的总页数；这时 `prompts` 只有当前页的题目，执行器按 `toolUseId`、题数和第 1 页结构匹配，其余页由扩展逐页复核）。
   - `nativeResponse`：云端请求（`provider === 'cloud-session'`）发结构化格式 `{ answers: 问题原文 → 标签数组, otherAnswers }`；Claude Code 本地会话的 `AskUserQuestion` 按 Claude Code 约定转字符串：单选“其他”时值为文本，多选时为 `标签1, 标签2, 文本`；多选标签含逗号时仍拒绝（现有规则）。
   - 待核实（步骤 2 用守护进程集成测试或真机证明）：Paseo 把 `respond` 的 `updatedInput` 原样传给插件 Provider，包括额外字段 `otherAnswers`。如果 Paseo 丢掉额外字段，改为在 `answers` 值里放 `{ labels, other }` 对象；仍不行就退回字符串格式并接受 2.3 的已知限制。
6. **给执行器的三个方法**：`browserCandidates(instanceId, sessionId)`、`delegateBrowserAnswer(id, answers, otherAnswers, source)`、`browserState(id)`。
7. `QuestionAgent` 接口加可选字段 `provider`、`labels`；`QuestionSchema` 加可选字段 `delegatedTo`，`isQuestionTodo` 排除带 `delegatedTo` 的条目。

### 2.7 云端模块（改 `server/cloud-session/index.ts`）

1. `permissionEvent` 发给 Paseo 的 `input` 用显示副本：`AskUserQuestion` 的每题加 `allowOther: true`，让 Paseo 原生界面显示“其他”输入框。`expected` 和 `notify` 的重复比较仍用原始输入。待核实（真机场景 2）：Paseo 原生界面确实显示“其他”输入框；如果不显示，在 #1707 记为已知限制，自由文本改在插件人工待办里填写。
2. `answer()` 改用 `toWebAnswer`；`kind: 'tool'` 仍调用交接函数（执行器返回 `tool_in_browser`），接口保持商定形式。
3. 时间线按 `detail` 写中文说明，例如：
   - `page_not_open`：“claude.ai 页面没有打开，请在 claude.ai 作答”。
   - `tool_in_browser`：“权限请求由 claude.ai 页面处理，Paseo 里的回答没有提交，请在 claude.ai 核对”。
   - `multiple_instances`：“多个浏览器环境打开了此会话，没有提交，请在 claude.ai 作答”。
   - 其他 `unknown`：“结果不确定（<原因>），请在 claude.ai 核对”。
   - `submitted`：“已在 claude.ai 页面提交，等待云端确认”。
4. `resolve()` 把 `outcome` 交给执行器（构造参数增加可选回调）。
5. 删除本地类型，引用 `shared/web-request.ts`。

### 2.8 浏览器桥接、入口、人工待办界面

- `server/browser-bridge.ts`：末尾追加 `answerWebRequest(request)`（转调执行器）和只读方法 `freshSessions()`。
- `index.server.ts`：交接函数改为 `async request => (await readyBrowser()).answerWebRequest(request)`；把登记表和执行器传给云端模块和在线离线运行时；注册 `web-request.audit`。
- `client/presence-panel.tsx`：`allowOther` 为真的题显示“其他”输入框。单选时输入文字会清除已选选项，点选选项会清空文字；多选时可以同时有。完成判定和提交按 2.2 规则，提交时带 `otherAnswers`。已提交答案的回显也显示“其他”文本。

### 2.9 扩展（改 `background.js` 两个函数、`questions.js`、`approval.js`、`manifest.json` 版本）

第 6.2 节样本证明：现有 `questions.js` 读不出真实提问卡片（只读消息 `read-questions` 返回空数组）；现有 `approval.js` 点不到 MCP 工具权限卡片上的“允许一次”。两个脚本都要按样本改。

- `background.js`：`cleanQuestion` 保留每题的 `allowOther` 和每条提问的 `toolUseId`；`cleanDecision` 保留 `otherAnswers`（每题最长 2000 字符）和 `source`。消息入口和同步流程不改。
- `questions.js` 增加 claude.ai 提问卡片识别分支（保留现有表单识别分支）：
  1. **卡片。** `[role=group][data-approval-card-root]`，`aria-label` 等于题目原文（`aria-label` 不以 `Permission request:` 开头）。外层 `[data-tool-anchor]` 的值是工具调用编号（`toolu_…`），作为提问的 `toolUseId` 上报。卡片不在 `form` 或对话框里。
  2. **选项。** `button[data-question-answer]`，选中状态是 `aria-pressed="true"`。标签取按钮内第一个 `div > div` 的文字，说明取第二个；不用按钮的 `innerText`（里面有图标字体私用区字符，例如 U+E03B）。带 `aria-label="Other"` 的按钮是“其他”，不算选项，该题报 `allowOther: true`。
  3. **单选和多选。** 卡片里 `[role=status]` 的文字是 `N selected` 时为多选，否则为单选。单选题第一个选项默认已选中，所以执行时必须明确点击目标选项，不能假设初始状态为空。
  4. **“其他”文本。** 点击“其他”按钮后才出现 `textarea[data-cds=TextArea][aria-label="Other option"]`。单选时点“其他”会取消已选选项。写入方法已在真实页面验证：用 `HTMLTextAreaElement.prototype` 的 `value` 设置器写入，再派发冒泡的 `input` 事件。
  5. **分页。** 一次多题时每页一题，卡片标题区有 `N of M` 和 `Show previous question`、`Show next question` 图标按钮。主按钮文字：非最后一页是 `Next`，最后一页是 `Submit`；另有 `Skip`。页面一次只渲染当前页，所以读取时只能看到第 1 页：上报 `pages: M`、当前页题目；服务端按 `toolUseId` 和第 1 页结构匹配，其他页在执行时逐页复核。翻页后已选内容保留（已验证）。
  6. **执行。** 逐页：复核 `aria-label`、页码、选项标签与计划一致 → 点击目标选项使 `aria-pressed` 与计划一致 → 需要时点“其他”并写入文本 → 150 毫秒后核对 → 点主按钮（`Next` 或最后一页的 `Submit`）→ 等新页渲染再复核。任何一页不一致返回 `unknown`。最后一页的主按钮 `disabled` 时返回 `unknown`。不点 `Skip`。
  7. **关键词拦截只对自动代答生效。** `SENSITIVE` 命中时，`source === 'manual'` 的 decision 照常执行；`automatic` 或没有 `source` 时返回 `unknown`。读取时命中关键词仍不报推荐项。
  8. 程序化 `element.click()` 对选项、“其他”、`Next`、`Submit` 都有效（已验证），不需要模拟鼠标事件。
  9. 识别时排除顶部模式切换（`[data-cds=SegmentedControl]`）和权限卡片。
- `approval.js`（用户决定“权限由扩展自动点同意”的前提）：MCP 工具权限卡片 `[role=group][data-approval-card-root][aria-label^="Permission request:"]` 上可见按钮只有 `Deny` 和 `Always allow`（本会话有效），“允许一次”在 `button[aria-label="More allow options"]` 打开的菜单里（`[role=menu][data-cds=Menu]` 挂在 `body` 下，菜单项 `[role=menuitem]` 文字 `Allow once`）。现有脚本找不到可见的 `Allow once` 按钮，所以不点击（扩展记录里没有这次预约），云端会话一直等待。修改：在权限卡片上没有可见的一次性按钮、但有 `More allow options` 时，先预约，再点开菜单，只点文字完全等于 `Allow once` 的菜单项；菜单里没有它时按 `Escape` 关闭菜单并记 `skipped`。永不点 `Always allow`。程序化点击菜单项已在真实页面验证有效，云端继续执行、Paseo 待处理请求随之清除。
- `manifest.json` 版本升到 0.5.0。

---

## 3. 结果判定代码

| 代码 | 来源 | 含义 |
| --- | --- | --- |
| `tool_in_browser` | 执行器 | 权限请求由页面上的扩展处理，Paseo 不执行 |
| `unsupported_tool` | 执行器 | 不是 AskUserQuestion（例如 ExitPlanMode） |
| `dismissed` | 规范化 | Paseo 里点了“忽略” |
| `invalid_answer` | 规范化 | 答案对不上原问题 |
| `request_changed`、`answer_changed` | 执行器 | 同一请求再次调用时原请求或答案不同 |
| `bridge_not_connected`、`scan_stale` | 执行器 | 配对浏览器未连接或扫描不新鲜 |
| `multiple_instances` | 执行器 | 多个浏览器环境打开了此会话 |
| `not_found`、`scan_incomplete`、`multiple_candidates` | 执行器 | 页面上找不到唯一的对应提问 |
| `other_not_on_page` | 执行器 | 答案有“其他”文本，页面上该题没有“其他”输入框 |
| `not_claimed`、`no_receipt` | 执行器 | 浏览器未及时领取或没有回执 |
| `page_unknown` | 扩展回执 | 扩展复核失败、过期、提交按钮不唯一、自动代答命中关键词等 |

---

## 4. 审计

执行器持久化到 `<状态目录>/web-requests.json`，最多 300 条。每条：`webSessionId`、`toolUseId`、`kind`、答案摘要（不存“其他”文本原文，只存长度和哈希），以及三段事实：

- `answerReceived`：时间；`source` 为 `user`、`automatic` 或 `paseo`。
- `webSubmitted`：时间、环境编号、`submitted` 或 `unknown` 和代码、回执是否迟到。
- `cloudConfirmed`：时间、云端 `outcome`。

只读 RPC `web-request.audit` 供验收读取。第一版不做界面。

---

## 5. 分步计划（每步可独立验收）

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | 共享类型 `shared/web-request.ts`、`shared/browser.ts` 追加导出、规范化 `normalize.ts`（两种格式、自由文本）、云端模块改用共享类型和规范化函数、显示副本加 `allowOther`、时间线中文说明。交接函数仍返回 `page_not_open`。 | 新增规范化测试和云端模块测试通过；`npm run check` 通过（基线 197 项）。推送，#1704 交付回报。 |
| 2 | 在线离线运行时和问答工具：云端提问按普通提问处理、答复后保持“已提交”、登记答案来源、云端会话网页提问不自动作答和转交隐藏、自由文本 schema 和校验、`nativeResponse` 两种格式、三个给执行器的方法；核实 Paseo 是否原样传递 `updatedInput` 额外字段。 | `tests/presence.test.ts`、问答工具测试新增用例通过；`npm run check` 通过。推送、交付回报。 |
| 3 | 执行器、登记表、桥接方法、入口注入、审计 RPC。 | 执行器测试（假桥接、假运行时）覆盖第 2.5 节全部分支；`npm run check` 通过。推送、交付回报。 |
| 4 | 人工待办界面的“其他”输入框。 | UI 测试（`tests/ui/`）覆盖单选互斥、多选并存、完成判定；`npm run check` 通过。推送、交付回报。 |
| 5 | 扩展：`background.js` 两个函数、`questions.js` 的 claude.ai 卡片识别和逐页执行（含“其他”、关键词按来源）、`approval.js` 的“More allow options → Allow once”、版本 0.5.0。 | 基于 `tests/fixtures/claude-web/` 真实样本的测试通过；`npm run check` 通过。推送、交付回报。 |
| 6 | 真机验收（第 9 节）。部署和扩展更新由主会话协调窗口。 | 场景证据写入 #1704，主会话复核。 |

步骤 1～4 不依赖页面样本。步骤 5 依赖第 6.2 节。第 2 步的行为变化（离线时云端提问会被自动代答）只在第 3 步完成后一起部署，否则代答结果只会得到“请在 claude.ai 作答”。

---

## 6. 真实页面核实

### 6.1 业务页面只读取证（已完成，2026-11-08 约 10:50 UTC）

方式：本机 SunBrowser 进程（Mac Mini，用户数据目录 `k1iry23x_h28n2yd`，扩展 `hoickgpfemgkohbnflileklfjonjdicb` 0.4.0）的调试端口，CDP `Runtime.evaluate` 只读表达式。没有点击、刷新、输入。

1. 当时只开着一个 claude.ai 页面：#1707 业务会话 `session_01XKJ85kumsMsemTjaRUfwh7`（带 `?artifact=` 参数）。
2. 页面界面语言 `en-US`。记录区是虚拟列表（`data-testid="epitaxy-virtual-transcript"`、`transcript-rows`、`transcript-row`），只渲染可见的几行。历史提问卡片和权限卡片不在 DOM 里，所以不能从业务页面取得提问框和权限框的结构。
3. 页面没有 `form`、没有 `[role=dialog]`。唯一的单选组是顶部“Claude / Code”模式切换（`[role=radiogroup][data-cds=SegmentedControl][aria-label=Mode]`，内含 `span[role=radio]` 和隐藏的 `input[type=radio]`）。现有 `questions.js` 不会把它当作提问（不在 `form` 或对话框里，也没有提交按钮）。实现时仍在识别里排除它。
4. 页面上的 `data-testid` 锚点：`transcript-rows`、`transcript-after-rows`、`transcript-before-cards`、`transcript-trailing-slot`、`transcript-tail-slot`、`code-prompt-input`、`code-prompt-send` 等。
5. 扩展存储（打开扩展选项页只读读取后关闭该页）：已配对；环境名称没有设置（同步时显示“未命名浏览器环境”）；自动点同意记录只有 1 条：07:44:05 UTC 点击“Allow once”，1.5 秒后按钮仍可见（`still-visible`）；`questionState` 不存在，说明网页提问通路从没在真实页面上下发过答案。

### 6.2 测试会话取证（已完成，2026-11-08 11:05–11:20 UTC）

方式：在 29 号环境新开标签页，自建测试云端会话 `session_01XKJ85hZUQLht46hyFAk6Ec`（标题“网页作答验收测试”，Default 云环境，仓库 dsh-superagent-prototype，权限模式 Accept edits），Paseo agent `a289cb98-d2a7-4ba8-9d4a-347b18cd61f2`（provider `cloud-session`）。先装只读 DOM 记录器，再经 Paseo 给测试会话发指令触发请求。作答在测试页上用 CDP 执行与扩展相同的程序化方法（`element.click()`、`value` 设置器 + `input` 事件），同时验证执行方法。业务会话标签页没有操作。

样本（脱敏，工具调用编号和消息编号换成占位符）：`paseo-github-subscriptions/tests/fixtures/claude-web/`

| 文件 | 内容 |
| --- | --- |
| `question-single.json` | 单选题初始状态（第一个选项默认已选中） |
| `question-single-other.json` | 单选题点“其他”后（出现文本框） |
| `question-multi.json` | 多选题初始状态（标签含逗号，`0 selected`，Submit 不可用） |
| `question-paged-1.json`、`question-paged-2.json` | 一次两题，分页的第 1 页和第 2 页 |
| `permission-mcp.json`、`permission-mcp-menu.json` | MCP 工具权限卡片和“More allow options”菜单 |
| `answers-observed.json` | 三次作答后云端 Claude 收到的回答原文 |

核对结论：

1. **现有 `questions.js` 读不出真实提问卡片。** 提问在页面上显示时，经扩展只读消息 `read-questions` 读取测试标签页，返回 `{"questions": []}`。原因：卡片不在 `form` 或对话框里，选项是 `button[aria-pressed]`，不是单选框或复选框。第 2.9 节加识别分支。
2. **结构**：见第 2.9 节第 1～5 条。卡片外层 `[data-tool-anchor]` 带工具调用编号，和 Paseo 待处理请求的编号格式一致（`toolu_…`；权限请求已核对 Paseo `PendingPermissions[0].id` 与云端工具调用编号相同）。执行器第 4 步匹配时，提问带 `toolUseId` 就必须与请求的 `toolUseId` 相同，再核对结构；这比只按结构匹配更可靠，同一会话里结构相同的两次提问也能区分。
3. **执行方法已验证。** 单选只填“其他”、多选两项加“其他”、两题分页（第 1 页单选、第 2 页多选加“其他”）三次都提交成功，云端收到的回答与页面操作一致（`answers-observed.json`）。翻回上一页再翻回，已选内容和“其他”文本保留。提交后卡片从页面移除，记录里只留不可操作的问答摘要。
4. **云端收到的回答格式**：单选“其他”时值是文本本身；多选时是 `其他文本,标签1,标签2`（“其他”在前，英文逗号无空格连接）。这只影响云端会话自己解析，不影响插件。
5. **`approval.js` 不误点提问卡片。** 三次提问期间扩展点同意记录没有新增。
6. **权限框。** 在这个云环境里，Bash（包括 `dangerouslyDisableSandbox: true`）和 WebFetch 都没有弹权限框，直接执行；Paseo MCP 工具 `list_hosts` 弹了权限框。MCP 权限卡片的“允许一次”藏在下拉菜单里，现有 `approval.js` 没有点击，请求一直等待；用程序化点击菜单项 `Allow once` 后云端继续执行，Paseo 待处理请求清除。第 2.9 节修改 `approval.js`。卡片本身没有工具调用编号。
7. 07:44 UTC 业务会话那次“Allow once / still-visible”记录对应的卡片样式没有样本；可能是可见的一次性按钮样式（其他工具类型）。新的 `approval.js` 两种样式都支持。
8. 同一会话两个标签页的情况没有取证，留给真机验收场景 10。

---

## 7. 用户决定（2026-11-08，#1704 评论 6720692225）

1. **云端会话的网页提问在同步到 Paseo 之前或同步失败时，离线也不代答。** 原话：“不自动了，升级之后不再依赖插件自动作答，而是使用统一的作答管理体系”。落点：2.6 第 4 条。
2. **第一版支持“其他”自由文本，以及单选、多选、一次多个问题。** 原话：“支持，还要支持多选单选，多问题”。落点：2.2、2.3、2.6 第 5 条、2.7 第 1 条、2.8、2.9。
3. **人工回答不按关键词拦截；自动代答仍按插件原有离线规则拦截。** 原话：“遵循paseo现有的能力即可，现有规则是啥，不限制的吧”。落点：2.4、2.9。
4. **测试会话由实现会话自己建、自己测**，测试完归档测试会话（claude.ai 和 Paseo 两边），关闭打开的标签页。
5. **写代码改由 MacBook 的 Argon 会话做**（“方案用 Claude，代码用 Argon”）。
6. 雏形第 5 节的云端程序三项小修复由主会话另派，不在本方案范围。

仍待核实（不是用户决定）：

- Paseo 原生界面在题目带 `allowOther` 时显示“其他”输入框（真机场景 2）。
- Paseo 把 `respond` 的 `updatedInput` 额外字段原样传给 Provider（步骤 2）。
- 权限请求在 Paseo 里作答后，Paseo 是否立即移除待处理条目（真机场景 6）。若立即移除，在 #1707 记为已知限制。

---

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/web-request-normalize.test.ts`（新） | 结构化格式；原文键和 `header` 键；`header` 重复；多选逗号连接；标签含逗号的唯一和歧义切分；单选非标签文字作为“其他”；多选尾部文字作为“其他”；“其他”与标签相同的已知限制；单选同时有标签和文本拒绝；空文本和超长文本拒绝；漏答拒绝；数组形式；`deny` |
| `tests/web-request-executor.test.ts`（新） | 入参校验和前缀转换；`tool_in_browser`、`unsupported_tool`；同键同答案只转交一次；原请求或答案变化（含“其他”文本变化）；未连接、不新鲜、未打开、多个环境四种判定；找不到、扫描不完整、多个候选、`other_not_on_page`；10 秒内后到的网页提问；20 秒未领取撤销；15 秒无回执；迟到回执只写审计；`source` 三种取值和下发的 `manual`/`automatic`；审计不存“其他”原文；持久化上限 300 |
| `tests/presence.test.ts`（改） | 云端提问离线时自动选明确推荐项、在线时只提醒；拦截词对自动代答仍生效；答复后保持“已提交”并在云端关闭后改为已结束；答案来源登记；云端会话网页提问不自动作答（含同步前）；有对应云端提问时网页提问带 `delegatedTo` 且不进人工待办；`delegateBrowserAnswer` 在暂停、模式切换、停止时不下发；人工回答带“其他”文本 |
| 问答工具测试（`tests/presence.test.ts` 或新 `tests/questions.test.ts`） | `validateAnswers` 的单选、多选、`allowOther` 规则；`nativeResponse` 云端结构化格式和 Claude Code 字符串格式 |
| `tests/cloud-session.test.ts`（改） | 显示副本带 `allowOther`、`expected` 不变；`answer()` 用规范化函数；时间线中文说明；`resolve` 交出 `outcome` |
| `tests/automation.test.ts`（改） | 云端请求不被原生权限自动审批 |
| `tests/browser-bridge.test.ts`（改） | `answerWebRequest` 转调执行器；`freshSessions` 只返回新鲜记录 |
| `tests/browser-extension.test.ts`（改） | `cleanQuestion` 保留 `allowOther`；`cleanDecision` 保留 `otherAnswers`、`source`，超长文本拒绝 |
| `tests/browser-approval.test.ts`（改） | `permission-mcp.json` 样本：打开菜单只点 `Allow once`；菜单里没有时关闭菜单、记 `skipped`；永不点 `Always allow` |
| `tests/browser-questions.test.ts`（改） | 第 6.2 节真实样本夹具：卡片识别和 `toolUseId`；单选默认已选中时仍点击目标；分页逐页执行；单选、多选、多问题、“其他”输入框读取和写入；模式切换单选组不算提问；关键词提问在 `manual` 时执行、`automatic` 时拒绝；写入后核对失败返回 `unknown` |
| `tests/ui/`（改） | 人工待办“其他”输入框：单选互斥、多选并存、完成判定、回显 |

每步都跑 `npm run check`（类型检查 + 全部测试）。

---

## 9. 真机验收场景

前提：插件从已推送提交部署到 Mac Mini；29 号环境的扩展更新到 0.5.0。部署和更新由主会话协调窗口。全程不刷新、不点击业务会话页面。测试会话只开一个标签页（场景 10 除外），触发请求用 Paseo 给测试会话发消息。

| 编号 | 触发（发给测试会话的指令大意） | Paseo 里的操作 | 预期 |
| --- | --- | --- | --- |
| 1 | AskUserQuestion 单选题，A 标推荐、B 不推荐；回答后只输出所选标记 | 在线，在插件人工待办选 B | 页面点选 B 并提交；会话输出 B 的标记；Paseo 请求关闭；审计 `source=user`，三段事实齐全 |
| 2 | 同上 | 在 Paseo 原生界面的“其他”里填 `PASEO_OTHER_1704` | Paseo 原生界面显示“其他”输入框；页面“其他”框填入文本并提交；会话复述文本；审计 `source=paseo` |
| 3 | 多选题，三个选项 | 在人工待办选两个并填“其他” | 页面勾选一致、“其他”文本一致；会话复述答案 |
| 4 | 一次两个问题（一单选、一多选） | 在人工待办作答 | 两题都正确提交（同屏或分页按样本） |
| 5 | 单选题，题目含“权限”二字 | 在人工待办选非推荐项 | 扩展照常点选提交（人工回答不按关键词拦截） |
| 6 | 运行需要权限的命令 `echo PASEO_TOOL_1704_OK` | 不操作，再在 Paseo 里点允许 | 扩展自动点“允许一次”；Paseo 回答后时间线写“权限请求由 claude.ai 页面处理……”；云端记录结果后请求关闭 |
| 7 | 离线，单选题，A 标推荐 | 不操作 | 插件自动选 A，页面提交；审计 `source=automatic`；人工待办没有重复的网页提问条目 |
| 8 | 离线，题目含“合并 PR” | 不操作 | 不自动作答；人工待办显示“问题涉及验收或合并授权……” |
| 9 | 关闭测试标签页后触发提问 | 作答 | 时间线写“claude.ai 页面没有打开……” |
| 10 | 打开测试会话第二个标签页后触发提问 | 作答 | 只在一个标签页点击一次；扩展 `questionState.handled` 只有一条 |

证据：每个场景记 Paseo 请求编号、`web-request.audit` 记录、扩展回执、会话输出标记，必要时录屏交主会话复核。
清理：归档测试云端会话（claude.ai 和 Paseo 两边）和对应工作区；关闭测试标签页；删除 `/tmp/odd-1704-dom/`。

---

## 10. 改动文件

| 文件 | 改动 | 估计行数 |
| --- | --- | --- |
| `shared/web-request.ts`（新） | 类型、审计 schema、RPC | 50 |
| `server/web-request/normalize.ts`（新） | 回答规范化（两种格式、自由文本） | 120 |
| `server/web-request/ledger.ts`（新） | 答案来源登记 | 40 |
| `server/web-request/executor.ts`（新） | 执行器、审计持久化 | 210 |
| `server/presence.ts` | 2.6 | 改 70 |
| `server/questions.ts` | `nativePrompts` 的 `allowOther`、`validateAnswers` 自由文本规则、`nativeResponse` 两种格式 | 改 40 |
| `shared/presence.ts` | `allowOther`、`otherAnswers`、`source`、`delegatedTo`、`isQuestionTodo` | 改 10 |
| `server/cloud-session/index.ts` | 2.7 | 改 40 |
| `server/browser-bridge.ts` | 末尾追加两个方法 | 加 15 |
| `shared/browser.ts` | 末尾追加一行导出 | 加 1 |
| `index.server.ts` | 注入和 RPC 注册 | 改 10 |
| `client/presence-panel.tsx` | “其他”输入框 | 改 40 |
| `browser-extension/background.js` | `cleanQuestion`、`cleanDecision` | 改 10 |
| `browser-extension/questions.js` | 2.9（claude.ai 卡片识别、逐页执行） | 改 150～200 |
| `browser-extension/approval.js` | 2.9（下拉菜单里的 Allow once） | 改 30 |
| `browser-extension/manifest.json` | 版本 0.5.0 | 改 1 |
| `tests/*`、`tests/fixtures/claude-web/*` | 第 8 节 | 800 |
| `README.md`、`browser-extension/README.md` | 网页作答说明、权限只显示、自由文本、已知限制 | 30 |

与 #1727 的合并顺序：本分支先合入。共享文件只在末尾追加或只改函数内部，冲突可直接合并。
