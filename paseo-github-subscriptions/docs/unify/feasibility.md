# 可行性核对（Paseo 0.15.0）

核对日期：2026-11-08。只读调研，未改已安装插件，未重载或重启 Paseo。

代码证据的路径简写：

- `S/` = `app.asar` 中的 `node_modules/@getpaseo/server/dist/server/server/`
- `SDK/` = 开发检出目录 `paseo-github-subscriptions/node_modules/@getpaseo/`（版本 0.15.0，与 app 内置版本一致）
- `旧通知/` = Mac Mini 的 `/Volumes/data/Workspace/paseo-plugins/event-notifications/`
- `主插件/` = 本工作树的 `paseo-github-subscriptions/`

## 结论总表

| # | 项目 | 结论 | 对设计的影响 |
|---|---|---|---|
| 1 | 两台机器合在一起看 | **有条件可行** | 待办总览：由所选主机的插件服务端向另一台转发查询，再合并。Provider 页：改为“按所选主机显示”，顶部加另一台主机的摘要和切换入口 |
| 2 | 页面“添加账号” | **有条件可行** | Claude 同用户账号：配置、目录、终端、改名都能由插件完成；浏览器登录、授权码、Apple 登录真实邮箱必须人工。独立 macOS 用户账号不能由插件完成。新增 Antigravity 账号要重载插件 |
| 2b | 添加浏览器环境 | **有条件可行** | 新建环境、装扩展、粘贴配对信息、登录 claude.ai 都是人工步骤。页面给出分步引导、复制配对信息、等待首次同步 |
| 3a | 重载会断开 Provider 会话 | **部分属实** | 只有**正在执行的轮次**会失败；空闲会话下次发消息时自动恢复。云端会话的未确认消息会丢失 |
| 3b | 同一份代码装两个实例（用户已选） | **有条件可行** | 安装 ID 可不同；但插件代码读不到自己的安装 ID，Provider 和额度来源 ID 必须全局唯一。用两个部署目录，各写一个实例角色文件。Provider 实例的状态由 Paseo 设置 → 插件原生显示，插件页面只放一行摘要 |
| 4 | 会话事件通知启动失败 | **根因已查明** | 守护进程启动时，插件先于监听地址写入就开始连接，旧插件不重试。修复约 30 行。整合后由共享连接模块统一重试 |
| 5a | 额度来源 ID 重复停掉整个插件 | **仍成立** | 还会连带撤下本插件注册的全部 Provider。切换顺序保持“先停旧插件” |
| 5b | 一个模块在 `contribute` 中抛错 | **整个插件失败** | 每个模块注册必须单独捕获错误。另外，未捕获的异步拒绝会让插件进程退出，Paseo 不会自动重启 |
| 6 | 侧栏两行、尾标数字、⌘K 命令 | **可行** | 一个侧栏项可画多行，每行有尾部插槽；命令面板支持全局命令 |
| 7 | 与 Paseo 原生界面重复 | **有重复，已删** | Provider 启停、模型、诊断、额度条、原生授权和提问作答、会话状态分组、插件启停和日志，Paseo 都已有。插件页面不再做这些，见第 7 节和 ia.md |
| 8 | 主会话只看置顶工作区（用户决定） | **可行，有行为变化** | 停滞会话和事件转发的范围会变化，见第 8 节 |

---

## 1. 两台机器的数据

### 证据

- **客户端只连所选主机。** `useRpc(contract)` 没有主机参数（`SDK/plugin/dist/client/rpc-context.d.ts:12`）。页面和侧栏项属于页头选中的主机。
- **客户端能拿到另一台主机的 Paseo 接口，但不能调用插件 RPC。** `useHosts()` 和 `getPaseoClient(serverId)` 在 0.15 中存在（`SDK/plugin/dist/client/index.d.ts:14-22`）。`getPaseoClient` 返回 `PaseoApi`，只有 `hosts`、`terminals`、`workspaces`、`projects`、`agents`、`providers`、`config`（`SDK/client/dist/index.d.ts:406-416`）。调用插件 RPC 的 `invokePluginRpc` 只在内部的 `DaemonClient` 上（`SDK/client/dist/daemon-client.d.ts:1363`）。
- **插件服务端之间已经能互相调用。** 主插件的在线状态模块用 `openHostRoute` + `createHostChannelTransport`（内部导出 `@getpaseo/client/internal/hosts`）连到另一台主机，再调用 `invokePluginRpc('github-subscriptions', 方法, 输入)`（`主插件/server/presence-port.ts:21-49`）。旧通知插件用同样方法（`旧通知/server/peer.ts:1-9`）。
- **两台主机已互相登记且在线。** Mac Mini 的 `paseo host ls --json`：MacBook（`srv_8u_hsRgzZXzn`）`enabled: true`、`status: online`，经 relay。MacBook 上：Mac mini（`srv_RBkDrTgFhpo5`）`True online`。
- **能跳到另一台主机的会话。** `navigation.openAgent({ agentId, serverId })`（`SDK/plugin/dist/client/contracts.d.ts:22-37`）。

### 可行做法

1. 每台主机的插件只上报**本机**的待办（本机原生提问和授权、本机浏览器桥接收到的网页提问、本机停滞会话、本机升级事件）。
2. 所选主机的服务端提供 `todo.list`：读本机列表，同时向每台在线的已登记主机调用 `todo.local`（超时 5 秒），合并后每条标出主机。
3. 某台主机离线或超时：列表顶部显示“MacBook 未响应，以下只含 Mac mini 的待办”，不让整页报错。
4. 卡片上的操作（提交回答、标为已处理、已读）带主机 ID，服务端转给所属主机执行。打开会话用 `openAgent` 带 `serverId`。
5. 侧栏“待办 N”读同一个合并结果。无论页头选哪台，两台看到的 N 相同。

### 设计调整

- **待办总览：保持两台合看**，用上述转发。
- **Provider 与账号：改为按所选主机显示。** 原因：登录终端、`config.patch`、配置目录、浏览器桥接（只监听 `127.0.0.1`）都是本机操作。合看要把这些写操作也转发到另一台，出错面大，收益小。页面顶部加一行“另一台主机：MacBook 有 1 个账号需要处理 → 切换到 MacBook”。摘要数据走同一个转发通道，只读。
- 额度：Paseo 原生额度面板本来就按主机显示，不变。

### 风险

- `openHostRoute`、`createHostChannelTransport`、`invokePluginRpc` 是内部接口，Paseo 升级可能改变。现在在线状态模块已依赖它们。整合后集中到 `core/hosts` 一处，升级时只核对一处。
- 转发调用的插件 ID 写死为 `github-subscriptions`（`presence-port.ts:48`）。两台必须用相同安装 ID。

---

## 2. 添加账号与登录

### 插件可用的接口

| 能力 | 接口 | 证据 |
|---|---|---|
| 写 `agents.providers` | `paseo.config.patch({ providers: { "<ID>": {...} } })`。可写字段：`extends`、`label`、`description`、`command`、`env`、`models`、`additionalModels`、`enabled`、`order` 等。守护进程合并后写入 `config.json` 并立即应用，不用另外执行 `paseo reload` | `SDK/client/dist/index.d.ts:384-405`；字段 `asar node_modules/@getpaseo/protocol/dist/provider-config.js:41-56`；合并和持久化 `S/daemon-config-store.js:210-232, 255-290, 488-505` |
| 删除 Provider | `config.patch({ removeProviders: [...] })` | `protocol/dist/messages.js:141` |
| 读配置（复制 `claude` 的 models） | `paseo.config.get()` | 同上 |
| 建目录、建链接、读 `claude auth status` | 插件服务端用 Node 文件和子进程接口（插件以用户 bbm 身份运行） | 插件进程环境 `HOME=/Users/bbm`、`PASEO_HOME=/Users/bbm/.paseo`（`ps eww` 读取） |
| 开 Paseo 终端并发命令 | `paseo.terminals.create({ workspaceId, cwd, name })`，返回句柄 `write()`、`sendKeys()`、`capture()`、`kill()` | `SDK/client/dist/terminals/index.d.ts:10-58` |
| 读诊断 | `paseo.providers.diagnostic(id)`、`paseo.providers.listUsage()` | `SDK/client/dist/index.d.ts:365-383` |

限制：

- 终端必须属于一个工作区（`workspaceId` 必填）。做法：在每台主机固定一个“账号登录”工作区（目录为用户主目录），没有就用 `workspaces.create` 新建。用户在这个工作区中能看到登录终端。
- 插件 Provider 的列表在插件启动时一次性上报，之后不能增减（初始化只在 `ready` 消息中带 `providers` 和 `usageSources`，`S/plugins/plugin-process.js:238-268`；协议中没有“Provider 列表变化”消息，`S/plugins/plugin-process-protocol.js:153-216`）。**新增 Antigravity 账号必须重载插件**，见第 3 项的影响。Claude 账号是 `config.json` 中的 Provider，不受影响。

### Claude 账号（同一 macOS 用户）的分工

| 步骤（按 paseo-prefs） | 谁做 | 说明 |
|---|---|---|
| 1 选下一个编号 `claude-N` | 插件 | `providers.listAvailable` 或 `config.get` |
| 2 备份 `config.json` | 插件 | 写前复制到带时间的备份 |
| 3 写 Provider | 插件 | `config.patch`。`CLAUDE_CONFIG_DIR` 用绝对路径；`models` 从 `claude` 深拷贝 |
| 4 建目录和共享链接 | 插件 | 只链接技能、指令、设置；不链接账号记录 |
| 5 确认 Provider 可用 | 插件 | `providers.waitForReady` 后读状态 |
| 6 开登录终端 | 插件 | 命令带 `BROWSER=/usr/bin/true`，阻止打开默认浏览器（paseo-prefs 记录在 Claude Code 2.1.314 上已核验；版本变化后要重新核验） |
| 7 拼出登录链接 | 插件 | 移植 `join_login_url.py` 的逻辑，检查 `code_challenge` 和 `state` 为 43 个字符 |
| 8 在指定浏览器环境中打开链接并登录 | **人工** | 页面显示链接和“复制”按钮，写明应在哪个浏览器环境打开。不调用 `openExternalUrl`（会用默认浏览器） |
| 9 粘贴授权码 | **人工** | 页面提供输入框，插件写入终端；也可以直接在终端中粘贴 |
| 10 读邮箱和订阅类型 | 插件 | `CLAUDE_CONFIG_DIR=... claude auth status` |
| 11 Apple 登录时填真实邮箱 | **人工确认** | 隐藏邮箱时页面要求填写或确认真实邮箱，写入账号标签文件 |
| 12 改显示名称 | 插件 | `config.patch` 改 `label` |
| 13 重新触发 | 插件 | 发送 `C-c`，抓取输出确认回到命令行后再重发 |

**不能由插件完成：** 独立 macOS 用户的 Provider（需要 sudo、ACL、钥匙串隔离）。页面只显示“按运行手册由会话处理”。AdsPower 环境的新建和代理设置也是人工。

### 网页版 claude.ai：添加浏览器环境

现有配对方式（`主插件/browser-extension/options.js:8-34`、`server/browser-bridge.ts:54, 142`）：

- 本机插件生成一个共用令牌（`~/.paseo/github-subscriptions/` 中，权限 600），监听 `http://127.0.0.1:<端口>/sync`。
- 每个浏览器环境装同一个未打包扩展。在扩展选项中粘贴地址和令牌，填写环境名称，可选填 AdsPower 环境 ID。扩展首次运行时生成自己的环境标识。
- 扩展每分钟同步一次。插件用 AdsPower 本地接口和设置中的 API key 查环境名称（`server/browser-usage.ts:23-59`）。

由于桥接只监听 `127.0.0.1`，**浏览器环境必须和插件在同一台主机上**。

完整流程和分工：

| 步骤 | 谁做 | 页面引导 |
|---|---|---|
| 1 在 AdsPower 新建环境，设置代理 | 人工 | 提示：每个账号一个环境，记下环境 ID |
| 2 在环境中加载扩展（开发者模式，“加载已解压的扩展程序”，选择部署目录中的 `browser-extension`） | 人工 | 显示扩展目录路径和“复制路径” |
| 3 打开扩展选项，粘贴配对信息，填写环境名称和 AdsPower 环境 ID | 人工 | “复制配对信息”按钮（地址和令牌）。令牌只在复制时取出，不在页面显示原文 |
| 4 在环境中登录 claude.ai | 人工 | 写明登录哪个账号 |
| 5 等待首次同步 | 插件 | 页面显示“等待新环境连接…”，收到未见过的环境标识后显示“已连接”，再显示 AdsPower 名称 |
| 6 用量标签页 | 扩展自动 | 配对后扩展自动维护用量页，10 分钟刷新一次 |

可选改进（不在本次范围）：把地址和令牌合成一段配对码，扩展选项只粘贴一次。要同时改扩展。

---

## 3. 重载影响与两个实例

### 3a. 重载断开会话：部分属实

- 插件停止时，子进程关闭全部 Provider 连接（`S/plugins/plugin-process.js:270-292`）。
- 守护进程侧，连接关闭时每个会话的处理（`S/agent/plugin-provider.js:633-643`，原注释）：“Closing fails only an interrupted turn. An idle session goes stale, and its next prompt reopens it from persistence.”
  - 有运行中轮次：发布 `session.runtime_failed`，这一轮失败。
  - 空闲：标为过期，下次发消息时从持久化数据重新打开。
- 云端会话在打开时写入持久化数据（`主插件/server/cloud-session/index.ts:225`，`persistence: { cloudSessionId }`），所以空闲的云端会话能恢复。内存中的未确认消息队列会丢失。
- Antigravity Provider 是否写持久化数据，需要在 MacBook 上核对旧插件源码。没有持久化时，空闲会话也无法恢复。

结论：文档中“重载会断开会话”改为“重载会让**正在执行**的会话这一轮失败；空闲会话下次发消息时恢复”。部署脚本的检查条件改为“这些 Provider 有没有**运行中**的会话”。

**更严重的情况：插件进程崩溃。** 子进程退出后，守护进程撤下插件、让 Provider 连接失败，**不自动重启**（`S/plugins/runtime.js:988-1003`）。插件进程没有处理未捕获的异步拒绝（`plugin-process.js` 中没有 `unhandledRejection`），Node 默认会退出进程。整合后任何一个模块漏掉一个异步错误，就会停掉全部功能，直到手动重载。

### 3b. 同一份代码装两个实例：有条件可行

- 安装 ID 必须唯一，目录安装可以用 `--id` 指定（`S/plugins/index.js:187-205`，报错文本：“is already configured; choose another ID with --id”）。没有检查目录是否重复。
- **插件代码读不到自己的安装 ID。** 守护进程在初始化消息中传了 `pluginId`，但没有交给 `contribute`（`plugin-process.js:238-246` 只传 `handle`、`registerProvider`、`registerUsageSource`、`registerSettings`、`addHook`、`on`、`before`）。客户端上下文也没有。
- Provider ID 和额度来源 ID 全局唯一（`S/plugins/index.js:537-543`；`S/plugins/usage-sources/index.js:20-23`）。两个实例注册同一个 ID，后启动的一个整体失败。
- 两个实例会各自贡献同名页面和侧栏项，侧栏会出现两行。

做法：两个部署目录（例如 `~/.paseo/local-plugins/github-subscriptions` 和 `~/.paseo/local-plugins/dev-automation-providers`），部署脚本在每个目录写入 `shared/instance.generated.ts`（`role: "main"` 或 `"providers"`）。服务端和客户端都按角色决定注册哪些模块。`providers` 角色只注册 Provider 模块，不注册页面、侧栏和其他钩子；状态写到自己的子目录。

### 3c. Provider 实例的状态怎样展示

- Paseo 设置 → 插件已经显示每个插件的状态、启用、停用、重载、删除和日志（客户端包文案键 `settings.plugins.actions.enable|disable|reload|remove`、`plugin.logs.*`，见第 7 节）。插件页面不再做这些。
- 插件页面只放一张卡片：一句话说明 + 状态（运行中、已停止、启动失败）+ 运行中会话数。状态来源：
  - Provider 是否可用：`paseo.providers.snapshot()` 中 `cloud-session`、`antigravity-*` 的状态（官方接口）。
  - 运行中会话数：`paseo.agents.list()` 按 Provider 统计状态为运行中的会话（官方接口）。
  - 实例是否在运行：主实例经自己的守护进程连接调用 `invokePluginRpc("dev-automation-providers", "instance.status", {})`。调用失败即显示“已停止或启动失败，请在 设置 → 插件 查看日志”。这一步用内部接口，与跨主机转发集中在同一个模块。
- 插件页面不能跳到原生设置页（`navigation` 只有 `openAgent`、`openWorkspace`、`openBrowser`，`SDK/plugin/dist/client/contracts.d.ts:22-37`），只写文字指引。

---

## 4. 会话事件通知启动失败：根因

### 现象

两台都一样。Mac Mini（`paseo plugin logs event-notifications`）：

```
09:37:34.451Z  stdout  [paseo] Loading plugin
09:37:36.286Z  stdout  [paseo] Plugin ready
09:37:36.293Z  stderr  会话事件通知启动失败，请检查配置、状态文件和连接
```

MacBook（`--host "$MACBOOK_PASEO_HOST"`）：`16:28:17.862Z Plugin ready`，`16:28:17.887Z` 同一条失败信息。

### 根因

1. 守护进程的 supervisor 只在工作进程就绪后才把监听地址写入 `paseo.pid`（`asar node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js:144-147`，`onWorkerReady` 中 `updatePidLock(... { listen, serverId })`）。启动初期 `listen` 是 `null`。
2. 插件在这之前加载。守护进程日志：`09:37:30.519 Server listening`，`09:37:34.451` 开始加载事件通知，`09:37:36.286` 加载完成。
3. 同一时间段，子会话免提醒插件的日志连续 5 次“本机连接尚未就绪，1 秒后重试 Error: paseo.pid 中没有监听地址”，到 `09:37:39.252` 才“已连接守护进程”。MacBook 上同样出现这条重试信息。
4. 事件通知的 `connectLocalDaemon` 读到 `listen` 不是字符串就直接抛错，**没有重试**（`旧通知/server/daemon.ts:9-11`）。`ready` 被拒绝后，`ready.catch` 撤下全部钩子并只打印固定文字，不打印错误本身（`旧通知/index.server.ts:643-649`），之后不会再试。
5. 守护进程日志中，事件通知只有插件会话本身的连接（`plugin:event-notifications`），它自己的连接（`plugin-event-notifications-<随机>`）从未出现。

佐证：其他步骤都没有问题。把插件源码复制到临时目录，用临时状态副本、影子模式、额度报警空跑独立运行，在守护进程已就绪时能正常启动并输出“会话事件通知已启动，投递模式：shadow”。配置校验、`state.json`、`server-id`、`main-agents.tsv` 都能正常读取。

状态文件最后写入在 11 月 5 日，说明从那次守护进程重启起就一直没有运行。只要守护进程重启，插件就会失败；守护进程就绪后手动重载插件可以临时恢复（本次未执行）。

### 修复量

- 旧插件：把子会话免提醒的重试函数（`subsession-quiet/server/retry.ts`）带过来，`connectLocalDaemon` 改为重试直到读到地址，`ready.catch` 打印错误摘要。约 30 行，3 个文件。
- 整合后：`core/daemon` 沿用主插件已有的 60 秒重试连接（`主插件/server/daemon.ts:8-40`），所有模块共用，不再各自连接。

注意：恢复后是实际发送模式（Mac Mini 配置为 `live`）。启动时会清掉旧积压，但会为当前仍待答的问题重建通知。如果在迁移前先修旧插件，建议先把配置改为影子模式观察。

### 最小修复方案（用户已决定：先修旧插件，再迁移；本次只诊断，修复另派）

改 3 个文件，约 30 行。

| 文件 | 改动 |
|---|---|
| `server/retry.ts`（新增） | 原样复制 `subsession-quiet/server/retry.ts`（19 行：失败后等 1 秒重试，直到成功或插件停止） |
| `server/daemon.ts` | `connectLocalDaemon(home, signal)` 用 `retryConnection` 包住“读 `paseo.pid` → 校验 `listen` → 建连接 → `connect()`”。失败时关闭这次的连接再重试。日志写“本机连接尚未就绪，1 秒后重试”和错误摘要 |
| `index.server.ts` | 第 67 行传入 `lifetime.signal`；第 643–649 行的 `ready.catch` 在固定文字后加错误摘要（只打印 `message`，不打印 webhook 地址和令牌） |

两台的做法（两台源码都没有 Git，先备份）：

1. Mac Mini：源码在 `/Volumes/data/Workspace/paseo-plugins/event-notifications`。MacBook：`~/Documents/Workspace/paseo-plugins/event-notifications`。先 `diff -r` 两份（排除 `node_modules`、`*.bak*`），确认三个文件相同再套用同一改动；不同则分别改。
2. 改前复制三个文件为 `.bak-<日期>`。改后 `npm run typecheck`、`npm test`。
3. 先把 `~/.paseo/event-notifications/config.json` 的 `delivery` 改为 `shadow`（Mac Mini 当前为 `live`），`paseo plugin reload event-notifications`（MacBook 加 `--host "$MACBOOK_PASEO_HOST"`）。
4. 验证启动：`paseo plugin logs event-notifications` 出现“会话事件通知已启动，投递模式：shadow”，没有“启动失败”。
5. 验证启动顺序问题已修复：等下一次 Paseo 正常重启（不为验证专门重启守护进程），日志应先出现若干“本机连接尚未就绪，1 秒后重试”，再出现“已启动”。补充单元测试：模拟 `paseo.pid` 先无 `listen`、1 秒后写入，`connectLocalDaemon` 能连上。
6. 验证记录：影子运行期间 `~/.paseo/event-notifications/events.jsonl` 出现 `recorded-shadow` 记录，内容与时段规则一致。
7. 切回实际发送：`delivery` 改回 `live` 再重载。检查 `events.jsonl` 中 `phase: "delivered"`、`channel: "grok-webhook"`、`httpStatus` 为 2xx 的记录。插件有 `credentialsStatus` RPC 可核对 webhook 指纹，不显示原文。

---

## 5. 额度来源 ID 与模块隔离

- **来源 ID 重复仍会停掉整个插件。** 插件启动后，守护进程先发布 Provider，再发布额度来源；任何一步抛错，都会撤下本插件的 Provider 和来源并停止插件（`S/plugins/index.js:467-482`）。重复来源 ID 在 `S/plugins/usage-sources/index.js:20-23` 抛出 `Duplicate usage source`。Provider ID 重复同样处理（`S/plugins/index.js:537-543`）。
- 同一插件内重复注册来源 ID，在 `contribute` 内就抛错（`S/plugins/plugin-process.js:107-108`）。
- **`contribute` 同步抛错 = 整个插件失败。** `initialize` 抛错后发送 `fatal`（`plugin-process.js:238-249, 381-388`），守护进程记为启动失败（`S/plugins/runtime.js:631-633`）。
- **`contribute` 返回后的异步错误**：被捕获的不影响别的模块；**未捕获的会让插件进程退出**，见 3a。
- 插件不能在 `contribute` 中先查询守护进程已有哪些来源：Provider 和来源必须同步注册，`contribute` 返回后立即上报。架构文档中“启动时自检来源 ID”改为：同步读取 `~/.paseo/config.json` 的 `plugins`，发现对应旧插件（`glm-usage-source`、`provider-quotas-usage-source`）仍启用时，跳过注册该来源并在页面报错。内置来源 ID 写成固定列表。
- 模块开关对 Provider 和额度来源**重载后才生效**。页面要写明。

模块隔离的最低要求：

1. 每个模块的注册放在单独的 `try/catch` 中（主插件已对云端会话这样做：`主插件/index.server.ts:55`）。
2. `core` 在 `contribute` 开头注册 `process.on("unhandledRejection")`，记录模块名和错误摘要，不让进程退出；清理时移除。
3. 机器配置用同步读取，解析失败时只停用相关模块。

---

## 6. 侧栏和命令面板

- `addSidebarHeaderItem` 的组件可以画多行 `SidebarRow`，每行用 `id` 区分；`trailing` 是右侧插槽，可以放数字或“!”（`SDK/plugin/dist/client/ui.d.ts:128-146`）。主插件现在的侧栏项已经用 `trailing` 显示事件数（`主插件/client/sidebar-item.tsx:17-26`）。
- `addCommandCenterItem` 支持 `context: "global"`，回调能 `openScreen`、调用 RPC（`SDK/plugin/dist/client/contracts.d.ts:263-272`）。“打开待办总览”“切换在线、离线、自动”“暂停全部自动化”都可以做。
- `addSettingsScreen` 存在（`contracts.d.ts:153`），设置页“开发自动化”可做。
- 限制：侧栏项属于页头最近选中的主机。数字用第 1 项的合并结果，两台显示一致。用户可在 Paseo 设置 → 侧栏中隐藏这些行。

---

## 7. Paseo 原生界面清点（0.15.0）

证据来自客户端包 `/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-c25f485e969e7b517f28e3400de6a40b.js` 中的文案键和英文取值（下表简写为“文案键”）。未截取实际界面截图。

| 原生功能 | 位置 | 能做什么 | 证据（文案键） |
|---|---|---|---|
| Provider 列表 | 设置 → Providers | 状态（可用、停用、出错、未安装、加载中）；启用；删除；模型（发现的模型、添加或删除自定义模型）；诊断（运行、刷新、复制） | `settings.providers.statuses.*`、`enableProvider`（“Enable {{name}}”）、`actions.remove`、`models.*`、`diagnostic.*` |
| 添加 Provider | 设置 → Providers → 添加 | 从目录选 Provider 类型（含 ACP），显示安装说明 | `providerCatalog.actions.addProvider`、`installInstructions`、`types.acp` |
| **没有**：改显示名称、配置目录和环境变量、登录 | — | 文案键中没有 Provider 改名或登录；`config` 接口注释写明 Provider 环境变量等仍是“配置文件形态” | `SDK/client/dist/index.d.ts:385-391` |
| 额度面板 | 侧栏额度、额度弹窗 | 各来源额度条；显示剩余或已用；刷新、全部刷新；固定；侧栏摘要；**登录过期提示**；多主机 | `providerUsage.displayRemaining|displayUsed|refreshAll|pin|showInSidebar`（“Summary in sidebar”）、`loginExpired`（“Login expired {{relativeTime}}. {{remedy}}”）、`hostUnavailable` |
| 会话状态分组 | 侧栏 | 按状态分组：需要输入、运行中、待查看、失败、完成；按主机筛选（可选全部主机）；“需要关注”“待处理”徽标 | `sidebar.statusBucket.needsInput`（“Needs input”）、`readyToReview`、`sidebar.display.grouping.status`、`sidebar.display.hostFilter.all`、`agentList.badges.attention|pending` |
| 授权和提问作答 | 会话时间线 | 允许、拒绝、提问作答、计划确认 | `agentStream.permission.accept|deny|question|plan` |
| 归档 | 会话列表、输入框命令 | 归档、取消归档 | `agentList.archiveSheet.*`、`composer.clientCommands.archiveAgent`、`agentPanel.archived.unarchive` |
| 通知 | 设置 → 通知 | 系统通知权限、播放声音、发测试通知 | `settings.notifications.permission|playSound|test` |
| 主机 | 设置 → 主机；页头主机选择 | 添加、删除、改名、外观、配对设备 | `settings.host.daemon.rename.*`、`hosts.add|remove`、`settings.host.pairDevices` |
| 工作区和项目 | 侧栏 | 新建、置顶、改名、删除 | `workspace.pin`、`project.add|rename|remove` |
| 计划任务 | 侧栏 | 计划任务分区 | `sidebar.sections.schedules`。心跳只有协议字段，没有界面文案 |
| Agent 配置档 | 设置 → 主机 → Agent 配置档 | 预设 Provider、模式、模型、思考、功能；用户新建会话时手动选用 | `settings.host.agentProfiles.providerLabel|modeLabel|modelLabel|featuresLabel` |
| 插件管理 | 设置 → 插件 | 状态、启用、停用、重载、删除、日志 | `settings.plugins.actions.*`、`plugin.logs.*` |
| 命令面板 | ⌘K | 全局命令 | `shell.commandCenter.*` |

对插件页面的结论（详见 ia.md 第 6 节）：

- **删掉**：Provider 启停、模型、诊断；额度条和重置时间；登录过期提醒（额度面板已有）；Paseo 原生授权和提问的作答卡片；插件实例的启停、重载、日志。
- **只保留原生没有的部分**：Claude 账号的配置目录、登录终端和改显示名称；Agent 配置档只在手动选用时生效，插件的默认设置规则对所有创建请求生效（包括会话经 MCP 创建的子会话），所以保留规则，但页面只显示开关和规则条数。
- **保留**：网页版 claude.ai 环境注册与配对、云端会话、Antigravity 账号、问答模式与蓝牙、升级通知、子会话免提醒、GitHub 订阅、跨来源待办（网页提问、网页等待、停滞会话、升级事件、代答未读）。
- 侧栏“待办 N”只统计上述插件来源，不包含原生“需要输入”，两者不重复。

---

## 8. 主会话只看置顶工作区（用户决定）的影响

当前三处口径（代码证据）：

| 功能 | 现在怎样判定 | 证据 |
|---|---|---|
| 子会话免提醒 | 不在置顶工作区的会话，清除“需要关注” | `subsession-quiet/server/policy.ts:29-43`；置顶状态读 `~/.paseo/projects/workspaces.json` 的 `pinnedAt`（`server/pinned.ts:6`） |
| 停滞会话 | 没有 `paseo.parent-agent-id` 标签、未归档、空闲或出错的会话 | `主插件/server/stalled.ts:25` |
| 事件转发 | 在登记表 `~/.claude/hooks/main-agents.tsv` 中的是主会话；有父会话标签的是子会话，事件转给父会话；登记表按工作区把旧主会话映射到现任主会话 | `旧通知/server/protocol.ts:28-47`；`旧通知/index.server.ts:82-86` |

Mac Mini 现状：未归档工作区 9 个，其中置顶 5 个；登记表 8 行。

改为“只看置顶工作区”后的变化：

1. **子会话免提醒**：不变。
2. **停滞会话**：只检查置顶工作区中的会话。
   - 不在置顶工作区、但没有父会话的会话（例如临时会话），不再报停滞。
   - 置顶工作区中如果也有子会话，子会话会被当作主会话检查，可能多报。需要约定：子会话不建在置顶工作区中。
3. **事件转发**：
   - “谁是主会话”改为置顶工作区中的会话；登记表不再使用，接班映射随之取消。
   - “子会话的事件转给谁”仍要靠父会话标签找目标。没有父会话标签就无法知道该转给哪个主会话。建议保留父会话标签**只用于找转发目标**，不用于判定主会话。请主会话向用户确认这一点。
   - 主会话被替换（接班）时：新主会话在同一置顶工作区中，但子会话的父会话标签仍指向旧主会话。迁移方案：转发前若父会话已归档或不在置顶工作区，改发给同一工作区中最近活动的会话；找不到时只记录，不发送。这是新逻辑，需要测试。
   - 升级通知（通知 Grok）只对主会话的提问生效。范围从“登记表 8 个”变为“置顶工作区中的全部会话”。
4. 页面显示：子会话免提醒卡片的编辑视图显示规则“置顶工作区中的会话是主会话”和受影响的会话列表。

---

## 新发现的风险（汇总）

1. 插件进程崩溃不会自动重启，所有模块一起停（3a）。整合后必须加进程级异步错误保护。
2. 新增 Antigravity 账号、开关 Provider 或额度模块都要重载插件，会让运行中的轮次失败（2、3a）。
3. 两个实例方案需要部署时生成角色文件，不能只靠 `--id`（3b）。
4. 跨主机转发依赖内部接口，升级时要核对（1）。
5. 所有需要自己连接守护进程的模块，必须等待 `paseo.pid` 写入地址后再连（4）。
6. 浏览器桥接只监听本机，浏览器环境必须和插件在同一台主机（2b）。
7. 主会话改为只看置顶工作区后，事件转发仍需父会话标签找目标；接班后旧标签的处理是新逻辑（8）。
