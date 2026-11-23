# 账号额度与问题答复模块（#1737 第二期）

四个部分：`usage.claudeAccounts`（Claude 账号额度）、`core/session-roles`（会话角色）、`answer.quietChildren`（子会话免提醒和事件转发）、`answer.escalation`（升级通知）。四部分都在主实例运行。三个模块默认关闭，在 `machine.json` 的 `modules` 中打开。

页面用的 RPC 按 #1737 的“RPC 约定”实现，契约在 `shared/claude-accounts.ts`、`shared/escalation.ts`、`shared/quiet.ts`。

## 会话角色（core/session-roles）

**主会话 = 置顶且未归档的工作区中的会话，与父会话同在一个工作区的子会话除外。** Paseo 0.17 起子会话默认建在调用方工作区，所以父会话标签 `paseo.parent-agent-id` 指向同工作区中未归档的会话时，该会话是子会话；父会话已归档（接班）、在其他工作区或其他主机时，仍按工作区判定。父会话标签另用来找子会话事件的转发目标。三处使用同一判定：

| 功能 | 旧判定 | 新判定 | 行为变化 |
|---|---|---|---|
| 停滞会话 | 没有父会话标签的会话 | 置顶工作区中的会话 | 不在置顶工作区、也没有父会话的会话（例如临时会话）不再报停滞。置顶工作区里带父会话标签的会话会被当作主会话检查。**约定：不要把子会话建在置顶工作区里。** |
| 子会话免提醒 | 工作区未置顶且未归档的会话 | 同左 | 无变化。读不到 `workspaces.json` 时不清除任何提醒（旧版会把所有会话当作子会话清除）。 |
| 升级通知 | 登记表 `main-agents.tsv` 里的会话 | 置顶工作区中的会话 | 范围从登记表（约 8 个）变成全部置顶工作区的会话。登记表和接班映射不再使用。 |
| 事件转发 | 登记表接班映射 | 沿父会话标签**逐层向上**到置顶工作区中的主会话（多层子会话也行，防循环）；那个主会话已归档、已关闭或不再置顶时，发给它所在工作区最近活动的主会话；找不到只记录 | 接班逻辑是新写的，见 `tests/session-roles.test.ts`。 |

**读不到置顶状态时不猜**：`workspaces.json` 不存在、无法读取或无法解析，都按错误处理并在页面显示原因——不清除任何提醒、不升级、不判停滞。

**读不到 Paseo 配置时不猜**：`core/legacy-plugins.ts` 判断旧插件是否仍启用，**只有 `config.json` 不存在才算没启用**；读取或解析出错按“旧插件仍启用”处理，并在页面显示原因（额度模块不启动、升级通知不启动也不发送、事件转发打不开）。

## usage.claudeAccounts

迁入 `/Users/<用户>/Documents/Workspace/paseo-plugins/claude-quota-resume`：额度来源、额度耗尽后自动继续、登录续期、Provider 显示名称加额度、账号显示标签、跨用户查询。

- **来源 ID**：默认 `claude-accounts`，可在 `claudeAccounts.sourceId` 改。
- **旧插件保护**：同步读取 `~/.paseo/config.json` 的 `plugins`。旧插件 `claude-quota-resume` 仍启用时，**不注册额度来源，整个模块报错**（页面 `claude-accounts.snapshot` 返回原因，写操作被拒绝）。原因：来源 ID 重复会让整个实例停止；两处同时运行还会重复改写 Provider 显示名称、重复发送继续消息。
- **自动继续默认值**：`claudeAccounts.autoResumeDefault`（默认 `false`）。没有单独选择过的会话（含新会话）按这个值处理；会话卡片上的勾选是单独选择，保存在 `enabled-agents.json` 或 `disabled-agents.json`，默认值改变后仍保留。归档会话时清掉它的选择。页面（“本机配置”面板的“新建 Claude 会话默认开启自动继续”开关）保存在 `quota/settings.json`，优先于 `machine.json`。
- **状态目录** `~/.paseo/github-subscriptions/quota/`：`jobs.json`、`enabled-agents.json`、`disabled-agents.json`、`usage-history.json`、`cross-user-providers.json`、`cross-user-cache.json`、`renewal/`、`settings.json`。账号显示标签在 `~/.paseo/github-subscriptions/labels.json`（隐藏邮箱 → 显示名称）。
- **查询合并与失败等待**：额度面板、容量计算和新建会话检查在同一插件进程、同一状态目录内共用普通账号和独立用户的查询、缓存及等待；各自的登录续期和额度身份校验仍独立，保存前合并较新的额度历史。成功结果缓存五分钟，401/403 按凭据缓存五分钟，新凭据不复用旧响应。普通账号的连接失败、超时和 5xx 按五、十、二十、三十分钟递增等待，成功后恢复正常缓存；服务端要求更长等待时遵守服务端时间。429 按账号遵守 Retry-After，缺失时等待十五分钟。界面刷新和创建新的检查实例不会绕过等待。
- **失败记录与提示**：`request-cooldowns.json` 保留原有账号哈希 → 429 截止时间，并新增 `failures`（账号与接口哈希 → 故障类别、次数、截止时间）和 `aliases`（配置目录哈希 → 账号哈希），不保存凭据、凭据指纹、邮箱或接口响应。启动时只读合并旧 `claude-quota-resume/request-cooldowns.json`，采用较晚截止时间；身份资料暂时缺失时继续遵守原账号等待。资料接口临时失败时不额外探测额度，提示具体原因和下次允许重试时间。日志只记实际失败请求的账号哈希前缀、接口、结果和重试时间，本地等待不重复记为服务端限流。
- **浏览器重复账号**：同一邮箱和登录方式已有启用的 Claude Code Provider 时，`claude-browser` 不再发现对应的浏览器额度项。邮箱和登录方式来自 AdsPower 环境名称与登录标签，CLI 身份优先使用本地身份元数据，隔离用户使用 Provider 账号标签；Apple 隐藏邮箱通过 `labels.json` 映射。同邮箱的 Apple 登录与直接登录分别处理，缺少或冲突的浏览器登录标签保留展示。每次发现重新读取 Provider 配置，停用或删除 Provider 后浏览器项自动恢复。上报、网页提问和原始额度记录保留，不增加 Claude 额度请求。旧浏览器记录首次加载时补取 AdsPower 登录标签，并将 `adspowerLoginMethod` 写入 `browser-usage.json`；回滚到不识别该字段的旧插件前需移除该字段。

### 复制自 Paseo 自带插件的文件

`server/vendor/paseo-0.15.0/claude-usage-source/` 原样复制 Paseo 0.15.0 自带的 `claude-usage-source`，保持相对路径：`server/usage.ts`、`server/stores.ts`、`shared/input.ts`、`icon.svg`。Paseo 升级后运行 `npm run vendor:check`（自动在 `/Applications/Paseo.app` 里找，也可用 `-- --paseo-builtin <目录>` 指定）比较，有差异就重新复制并更新 `scripts/paseo-vendor.ts` 中的版本。自有逻辑都在 `server/modules/usage-claude-accounts/`，账号绑定输入的扩展在 `shared/continuity-input.ts`。

复制来的文件用 `./x.js` 导入同目录的 `.ts`，Paseo 打包时能解析，Node 直接跑不行。`npm test` 通过 `tests/resolve-js-to-ts.mjs` 解决。

### 迁移旧状态

模块启动时自动运行（`migrateLegacyClaudeQuota`），**只复制，不移动、不覆盖，可重复运行**：

1. 先停用旧插件 `claude-quota-resume`（`paseo plugin disable`），否则模块拒绝启动。
2. 打开模块并重载本插件。模块把 `~/.paseo/claude-quota-resume/` 的 `jobs.json`、`enabled-agents.json`、`disabled-agents.json`、`usage-history.json`、`cross-user-*.json`、`renewal/` 复制到 `quota/`，并把 `account-labels.json` 并入 `labels.json`（已有标签不覆盖）。
3. 旧目录保留到旧插件被删除（稳定 14 天后）。回滚：关闭模块，重新启用旧插件，旧状态未动。

旧插件停止时会恢复 Provider 原名称，新模块下一分钟重新加上额度。`cross-user-providers.json` 里是本机查询程序的绝对路径，只留在状态目录，不进仓库。

## answer.quietChildren

迁入 `subsession-quiet`（待查看清除）和 `event-notifications` 中“子会话事件转发给主会话”的部分。

- **免提醒**（`quietChildren.enabled`，默认开）：子会话结束、出错或提问后清除“待查看”；等待工具授权的子会话保留提醒。清除用未公开接口 `clearAgentAttention` 和 `clearWorkspaceAttention`，Paseo 升级后要核对。Paseo 先发通知、插件后清除，所以系统弹窗仍会出现一下。
- **提问提醒**：子会话的提问提醒**只有在提问有人接手时才清除**——事件转发已打开且找到转发目标，或旧的转发插件仍在运行；否则保留。
- **事件转发**（`quietChildren.forwardEvents`，默认**关**）：子会话的提问，以及需要用户接续的事件（合并 master、复盘），发给所属主会话；主会话有待答问题时先等。普通的完成、出错、命令失败只记录，不叫醒主会话。与旧插件一致，还会订阅每个子会话的时间线检查 shell 命令失败（带退出码的终态或失败；`gh pr checks` 退出码 8 不算）：普通失败只记录，命令文字含合并 master 或复盘时才转给主会话。每个子会话一个订阅，随事件转发开关一起启停。
- **Antigravity 本轮外续跑**（#2258，随事件转发启停）：Antigravity 的后台命令（`IsDaemon`）不保持本轮，本轮先结束；命令结束后它会自己继续推理、调用工具和回复，但这些时间线事件没有 `turnId`，会话一直是空闲，不触发回合事件，Paseo MCP 也不发完成通知。转发模块在子会话时间线订阅上识别这类事件（只对 `antigravity` 及 `antigravity-*` 提供方），最后一条事件之后静默 60 秒，向主会话发一次 `background_resumed` 事件（`data.message` 为“子会话后台续跑已结束”，附条目数、起止时间和最后一条助手消息末尾 600 字）。仍有运行中的本轮外工具时继续等待，最多 10 分钟后照常发送并注明运行中工具数（常驻服务不会结束）。新回合开始时放弃跟踪；订阅回放的 10 分钟前的事件不算。不给子会话发续接。巡检脚本可用 `scripts/out-of-turn.ts <会话 ID> [--server <serverId>]` 只读判定同一状态。
- **旧插件保护**：旧插件 `event-notifications` 仍启用时，事件转发不能打开（页面显示原因）。免提醒可以和旧插件 `subsession-quiet` 同时运行，清除操作是幂等的。
- **跨主机**：父会话在另一台主机时，经已登记的主机通道转发，并调用对方的 RPC `quiet.resolve-main` 确认现任主会话；两台都要安装本版插件。
- 状态目录 `quiet-children/`：`settings.json`、`handled.json`（最近处理记录）、`forward-state.json`、`forward-events.jsonl`。旧 `subsession-quiet` 没有状态，不需要迁移。

## answer.escalation

迁入 `event-notifications`（用 2026-11-08 修好启动重试的那份）中的升级通知。插件不自动代答：问答模式（`answer.presence`）控制是否播报语音提醒，升级通知按时段规则把未答提问发给总控（Grok），由总控按用户选择画像决定。

- **范围**：主会话（置顶工作区中的会话）的提问和错误；独立浏览器扩展上报的网页提问（未绑定到原生提问时，通过 `enqueueExternal` 进入升级通道，问题结束时通过 `closeExternal` 自动结束待办记录）；新建项目和新建工作区（`escalation.newObjects`）；额度报警（`escalation.quotaAlerts`）。
- **asked 负载扩展字段**（`schemaVersion: 1` 保持不变）：`questionSummary.text` 取第一个问题的正文（`input.questions[0].question`），顶层追加 `serverId`、`needId`、`workspaceTitle`、`requestId`、`answerVia`（`paseo-permission` | `cloud-session` | `browser-only`）、`prompts`（含 `answerKey` 与 `options`，覆盖 `AskUserQuestion`、`request_user_input`、`request_user_input_async`）、`audience`（`{ ownerOnly, category, reason }`，按优先级匹配 `daily_task`、`retro_review`、`local_confirm`、`final_acceptance`、`login_verification`、`payment`、`destructive_cleanup`，合并与发布不标 `ownerOnly`；本机确认关键词可在 `machine.json` 的 `ownerOnly.localKeywords` 或 `escalation.ownerOnly.localKeywords` 配置）、`presence`（`{ mode, source }`）、`features`（`['prompts', 'audience', 'serverId']`）。工作区表始终通过 `watchWorkspaces` 维护，不受 `newObjects` 开关影响。
- **时段规则**：`timezone`（默认 `Asia/Singapore`）、`immediate`（立即时段，默认每天 01:00–09:30、工作日 12:00–14:00，左闭右开）、`delayMinutes`（时段外等待的分钟数）。时段外的问题等满 `delayMinutes` 后升级，进入立即时段马上升级。**默认 `delayMinutes` 是 0（全天立即），与旧插件的实际行为一致**——旧插件文档写“其他时段等 30 分钟”，但代码里这条规则没有接入。要启用文档里的规则，把它设为 30。
- **只有实际发送**：影子模式已删除。`machine.json` 的 `escalation.delivery` 或页面旧设置（`escalation/settings.json`）写着 `shadow` 时照常读取，按实际发送处理，日志提示可以删掉这一项。去重记录只用 `state.json`；旧的 `state-shadow.json` 不读不写，文件保留不动。
- **旧插件保护**：旧插件 `event-notifications` 仍启用时本模块不启动、不发送（避免同一事件发两次），编辑面板显示“旧插件仍启用，先停用”。停用旧插件后重载本插件才开始发送。
- **webhook**：地址和鉴权头只从环境变量或 macOS Keychain 读取，服务名写在 `machine.json` 的 `escalation.webhook`（`urlEnv`/`authEnv`，或 `urlService`/`authService`/`account`）。仓库里没有地址、凭据和服务名。旧插件的服务名写在旧源码 `server/webhook.ts` 里，迁移时抄到 `machine.json`。额度报警 webhook 的凭据：环境变量 `QUOTA_WEBHOOK_URL`/`QUOTA_WEBHOOK_KEY`、`~/.config/dsh/quota-webhook.json`，或 `quotaAlerts.fileDirectory`（目录里 `url` 和 `key` 两个文件）。
- **预筛**：`escalation.prefilter` 写 `{ command, script }`；脚本输出 `{"action":"suppress"}` 时不发送。没有配置就不预筛。
- **编辑面板**：时段规则（免等时段的删除和添加、其余时段的等待分钟数，每处都有保存按钮，结果在原位置提示成功或失败原因）；“Grok bot 类个人机器人通知 Webhook”（地址、域名、8 位识别码，保存或更换地址，发测试通知）。通知记录不在面板列出，在“待办总览”的处理记录中查看；`escalation.snapshot` 仍返回 `recentDeliveries`。
- **待办中的升级事件自动结束**：来源提问不再等待时（已回答、已取消、权限已处理，或会话不存在、已归档、已关闭），升级事件自动移出“待办总览”，`events.jsonl` 写 `record-closed`，待办的处理记录显示“已自动结束（原因）”。出错事件在会话继续运行后结束；60 秒内合并的出错事件要全部成员会话都恢复运行、不存在、已归档或已关闭才结束。触发点：权限钩子、会话列表订阅推送、启动时对账一次、之后每 60 秒对账一次（逐个查询有未结束事件的会话，查询失败的保留到下次）。启动后 2 分钟内只按“会话已归档或不存在”结束：守护进程重启后会话恢复前等待列表为空，不能据此判断提问已结束。旧记录没有请求编号，启动时从 `events.jsonl` 按通知编号回填；回填不到的，会话没有任何等待中的请求才结束。同一轮对账也清掉引擎中已送达但已不再等待的提问。“标为已处理”仍可用；按钮等待超过 15 秒提示超时并恢复，随后重新读取列表。跨主机：每台主机只结束自己的事件，两台主机都要部署本版本。
- **状态目录** `escalation/`：`settings.json`、`state.json`、`events.jsonl`（审计）、`records.json`（待办的升级事件和处理记录）、`quota-alerts.json`。

### 迁移旧状态

模块启动时自动运行（`migrateLegacyEscalation`），**只复制，不移动、不覆盖**：

0. 旧插件仍启用时**不复制**（它的状态还在变），停用后重载才复制；切到实际发送前会再试一次。
1. 旧 `~/.paseo/event-notifications/state.json` → `escalation/state.json`（实际发送模式的去重记录）；`quota-alerts.json` → `escalation/quota-alerts.json`。
2. 额度报警凭据目录：旧插件默认目录写在旧源码里，请抄进 `escalation.quotaAlerts.fileDirectory`；开了额度报警却没有凭据时，页面显示警告。
3. `events.jsonl` 不复制，留作旧记录。`config.json` 不复制：日志里给出建议值（`delivery`、`webhook` 的环境变量名），请手动写入 `machine.json`。`mains`、`children`、`mainAgentsFile` 不再使用。
4. 切换顺序：先停旧插件，再打开本模块并重载。旧插件未停用时本模块不发送。

## 已知限制

- 订阅、钩子和连接部分（`runtime.ts`、`forward.ts`）没有自动化测试：它们依赖运行中的守护进程。投递、时段、配置、迁移、角色判定、清除队列和 RPC 都有单元测试。需要用真实守护进程观察。
- 额度来源的 `icon` 写成插件内相对路径 `server/vendor/paseo-0.15.0/claude-usage-source/icon.svg`；如果 Paseo 不按插件根目录解析，只是不显示图标。

## 主会话收尾与容量

`dispatch.finalize` 和 `capacity.mainSessions` 默认关闭。在运行 Claude 主会话的主机上，按需要在 `machine.json` 的 `modules` 中开启。迁移模式 `capacity.migration.mode` 默认是 `off`；开发联调使用 `shadow`，确认旧负载均衡职责已停止后再使用 `live`。

带 `role=main` 和 `need` 或 `issue` 标签的会话会自动收尾：解绑父会话、按需置顶工作区并加「主会话」标签。首次启用时已有的主会话作为基线，不自动收尾；启用后成为主会话的会话才自动处理。收尾结果按会话和单号保存。之后手动取消置顶不会被收尾任务重新置顶。`dispatch.finalize` RPC 可按会话编号手动重试。

`capacity.snapshot` 返回各账号的实时额度、档次、置顶工作区负载和可承接数。仅使用十分钟内的可用额度报告做决策；档次由实时 `planLabel` 判断，`capacity.accounts` 的档次配置用于核对。预热账号在 `capacity.warmup` 中列出。五小时额度用尽或周额度不超过 5% 时，符合条件的主会话可迁移到有余量的 Claude 账号。点名账号的会话设置 `dsh.lb=manual`，耗尽时发例外事件。

余量变化至少间隔五分钟通知总控，每六小时发送一次心跳。收尾、迁移及异常事件使用现有升级通知 webhook。影子模式发送 `main_migration_planned`。迁移失败会保留原会话，恢复自动继续设置并发出异常；周额度迁移回退时通知原会话继续工作。中途退出、归档结果无法确认或回退不完整时，持久标记为待审并停止再次迁移，需人工核查。真实 daemon 联调须核对收尾结果、逐账号容量和影子迁移记录。

人工核查待审迁移后，可调用 `capacity.clear-review {agentId}`。该操作将会话的 `dsh.migration-state` 改为 `cleared:<时间>`，将 `dsh.migration-lease` 改为 `released:<时间>`，读回两个标签，再删除并读回 `capacity/migrations-state.json` 中该会话的记录。返回值包含记录中的自动继续原值；解除待审不会改变当前自动继续设置。调用前应核查原会话、新会话及子会话的实际状态。

新会话通过检查后，插件在归档原会话前写入并核对 `dsh.migration-successor=<新会话ID>`。该标记保留在原会话上，即使原会话被迟到消息恢复、冷却期结束或插件重载，也不会再次迁移或自动发送继续消息。归档明确失败且回滚完成时清空标记；归档结果未知或回滚不完整时保留标记并转待审。解除待审不会清除接替会话标记，需要先核查哪一个会话继续负责需求。如果决定保留原会话，应先确认新会话已停止并归档，再将原会话的接替标签设为空字符串并读回核对。自动继续安排和发送前均通过守护进程读取这些状态，读取失败时不发送。

## 隔离用户登录续期

跨用户额度映射可选配置 `renewal`。配置保存在本机额度状态目录的 `cross-user-providers.json`，不提交真实账号路径或凭据。例如：

```json
{
  "/Users/pilot/.claude": {
    "command": "/trusted/provider-launch.zsh",
    "args": ["--pilot-usage"],
    "renewal": {
      "cwd": "/Users/Shared/Pilot/workspace",
      "probeArgs": ["--pilot-egress"]
    }
  }
}
```

`command` 必须是管理员管理的绝对启动器路径。启动器需要在隔离用户身份下支持官方 Claude 参数、额度查询和固定出口预检。`cwd` 必须是目标用户获准使用的绝对工作目录。预检必须由启动器校验该账号的预期出口，成功返回 `{"verified":true}`，失败返回固定 `egress-*` 错误。额度 helper 仍保留自己的出口校验。

仅在缓存到期的新查询前，插件先做出口预检，再让官方 Claude 接收一次 SDK initialize 控制消息，然后运行原额度 helper。整个流程共用十八秒预算，预检最多四秒，初始化最多六秒（含退出清理），为额度查询至少保留三秒。不发送用户提示词，不启用工具、MCP 或 Hooks，不产生模型回复。初始化应答只表示协议完成，实际凭据是否有效以随后的额度接口结果为准；初始化未完成但还有预算时，仍查询原有凭据。

并发请求共用一个流程；普通结果和错误缓存五分钟，429 缓存十五分钟，持久缓存确保插件重载不能绕过冷却。凭据的读取和刷新由目标用户的官方 Claude 完成，插件不读取、复制或回传访问令牌和刷新令牌。未配置 `renewal` 的旧映射保持原查询行为。

先部署新版插件，再添加 `renewal` 配置。回滚旧插件前移除映射的 `renewal` 字段；旧版本使用严格映射校验，不能识别新字段。只热重载额度插件，不重启 Paseo 守护进程。
