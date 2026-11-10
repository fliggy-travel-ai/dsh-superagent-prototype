# 账号额度与问题答复模块（#1737 第二期）

四个部分：`usage.claudeAccounts`（Claude 账号额度）、`core/session-roles`（会话角色）、`answer.quietChildren`（子会话免提醒和事件转发）、`answer.escalation`（升级通知）。四部分都在主实例运行。三个模块默认关闭，在 `machine.json` 的 `modules` 中打开。

页面用的 RPC 按 #1737 的“RPC 约定”实现，契约在 `shared/claude-accounts.ts`、`shared/escalation.ts`、`shared/quiet.ts`。

## 会话角色（core/session-roles）

**主会话 = 置顶且未归档的工作区中的会话。** 父会话标签 `paseo.parent-agent-id` 不决定谁是主会话，只用来找子会话事件的转发目标。三处使用同一判定：

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
- **旧插件保护**：旧插件 `event-notifications` 仍启用时，事件转发不能打开（页面显示原因）。免提醒可以和旧插件 `subsession-quiet` 同时运行，清除操作是幂等的。
- **跨主机**：父会话在另一台主机时，经已登记的主机通道转发，并调用对方的 RPC `quiet.resolve-main` 确认现任主会话；两台都要安装本版插件。
- 状态目录 `quiet-children/`：`settings.json`、`handled.json`（最近处理记录）、`forward-state.json`、`forward-events.jsonl`。旧 `subsession-quiet` 没有状态，不需要迁移。

## answer.escalation

迁入 `event-notifications`（用 2026-11-08 修好启动重试的那份）中的升级通知，与代答（`answer.presence`）**两套独立规则**：问答模式决定是否代答，时段规则决定是否通知 Grok。同一道题可能先被代答，之后仍被升级。

- **范围**：主会话（置顶工作区中的会话）的提问和错误；新建项目和新建工作区（`escalation.newObjects`）；额度报警（`escalation.quotaAlerts`）。
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
