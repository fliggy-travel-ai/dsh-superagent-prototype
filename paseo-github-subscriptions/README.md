# GitHub 订阅 Paseo 插件

插件独立位于本目录。用户操作说明见 [OVERVIEW.md](OVERVIEW.md)，完整方案及确认记录见 [技术方案](../plans/paseo-github-subscriptions.md)。开发和验证不修改原型已有源代码，也不修改 Paseo 上游。

## 在线、离线与人工待办

人工待办支持人工回答完成后自动清理、自动代答答案展示与已读清理，以及跨主机检查后的停滞主会话提醒。提交中和结果未知的问题继续保留。规则见 [人工待办与停滞会话](OVERVIEW.md#人工待办与停滞会话)，界面复现与演示材料见 [待办验证](../plans/1704-presence-ui/README.md#待办清理与停滞会话验证)。

原方案迁移对照和交付验证见 [迁移清单](../plans/1704-source-migration.md)。本版加入晓晓神经语音（内置 `node-edge-tts` 合成，无需安装 Python，失败时回退系统语音）、提示音、冷却、持久成功回执、失败重试和按问题取消，以及扩展 0.4.0 的活动提示与权限审计（仅在 `approvalEnabled === true` 时自动点同意；未配对或配对无效立即置关，同步失败超过 3 分钟自动置关）。完整扫描确认问题结束后，未知结果也会结束，但不补记回答成功。验收和合并问题必须由用户本人确认。

离线代答需要明确推荐项，并检查整个问题及选项描述。涉及登录、验证、访问权限、资金操作，以及数据、文件、工作树、账号或环境的清理、释放、归档和改动丢弃时，保留人工待办并说明原因。“备份后释放”和“先审查再丢弃”也需要人工确认。代答记录的来源始终是插件自动代答，不能写成用户本人验收或授权。

## 兼容与安装

实现使用 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 的 0.15.0 版本。清单限制 Paseo 为 `>=0.15.0 <0.16.0`。

核对过的 npm 0.15.0–0.15.3 未提供在线文档所示的 subscription API。因此客户端通过一个共用 store 每五秒读取一次 snapshot RPC。胶囊和侧边栏共用刷新，不要求用户打开插件页面。客户端使用 React Native 原语；TypeScript 不引入 DOM 库。

本地目录安装需要先准备依赖，然后在目标机器安装。以下命令会改变所选守护进程的插件配置，应只在确定安装目标后执行：

```sh
cd paseo-github-subscriptions
npm ci --ignore-scripts
paseo plugin install "$PWD"
```

macOS 应用内置 CLI 可能不在 PATH，其位置为 `/Applications/Paseo.app/Contents/Resources/bin/paseo`。两台机器分别安装和设置。插件默认启用影子模式。Mac Mini 与 MacBook 已完成生产安装和插件热更新，并通过 snapshot RPC 核对；生产守护进程未重启。安装与验收证据见 `validation/production-hotfix-20261106.json` 和 `validation/gh-comment-guidance-20261106.json`。

## 事件与送达

- 默认组织为 `fliggy-travel-ai`，排除 `rea`、`dsh-superagent-prototype`、`hypit`、`content-wx`、`harness2`。新增组织仓库默认纳入。组织外或已排除的仓库，需要先在设置中显式纳入。
- 每仓库读取 Issue、对话评论、代码评论和最近 100 条 Actions runs。详情流支持分页、五秒重叠窗口、ETag 和十四天追读上限。首次启动只建立基线。
- `opened`、`comment`、`review_comment`、`state` 可按仓库或具体对象匹配。整仓库 `ci` 只监听默认分支；`push`、`review` 需要指定 PR，仓库范围选择会返回明确错误。
- 已跟踪 PR 每五分钟补读详情和评审，每十分钟核对 CI；默认分支每十分钟核对 CI。这些核对用于补充列表更新信号，可能增加请求数。额度偏低、429 或额度耗尽时降速，按重置时间恢复。
- CI 使用 Actions runs、jobs 和提交状态，不调用 `check-runs`。同一 `workflow_id + event` 分组下优先取最新的非 `cancelled` 运行，仅当该组全部为 `cancelled` 时才取最新的 `cancelled`。首次观测即存在失败项（如新订阅或丢失来源状态重启）会发出一次 `failed`，带已保存状态正常重启不重复发送；新提交出现同名失败、恢复后再次失败、取消后重订都有独立事件编号。
- 同轮按会话合并。通知最多展开二十条、总长小于四千字符，超出部分给出数量和读取提示。送达记录仍保留全部事件编号。发送使用固定 `messageId` 与 `activeTurnBehavior: 'steer'`。
- 失败最多尝试三次；重试沿用相同编号和正文。结果未知时停止自动重发并记录原因。提供方设置「跳过本轮」时直接跳过，不等待空闲。
- 订阅工具描述提示会话使用 `gh issue comment` 或 `gh pr comment` 发评论时，从 `PASEO_AGENT_ID` 读取当前会话 ID，在正文末尾另起一行添加 `<!-- paseo-ghsub agent=<当前会话ID> -->`。只过滤写评论的会话，其他订阅者仍能收到。插件不再提供评论发布工具；未按格式加标记的评论照常送达。
- 每个会话最多五十个 Issue/PR、五个整仓库订阅，全机最多一千条。归档立即清理；关闭三天后到期，重开取消到期；十四天无事件清理。

## 设置、凭据与状态

默认目录为 `$PASEO_HOME/github-subscriptions`，测试可用 `PASEO_GHSUB_STATE_DIR` 覆盖。目录权限 0700，文件权限 0600。

| 文件 | 内容 |
| --- | --- |
| `github-token` | 独立令牌文件；不从守护进程的 GH_TOKEN 读取 |
| `state.json` | 版本、偏好、订阅、来源游标、去重、事件、送达和评论登记 |
| `web-requests.json` | 云端网页作答审计记录（最多保留最近 300 条，仅保存自由文本长度与 SHA-256，不存原文） |
| `browser-usage.json` | 浏览器环境 `claude.ai` 额度记录、AdsPower 名称解析缓存与可选 AdsPower API key（权限 0600，key 不写日志、不返回前端，前端只显示“已配置/未配置”，支持清除与重新填写，环境变量作为后备；要准确显示环境名称需在扩展选项页填写一次环境序号，单环境自动识别只在单个活跃环境且单个扩展上报时生效） |

`state.json` 通过串行事务和原子替换保存。来源游标与待发登记一起提交，避免游标先推进而漏发。待发记录包含事件快照，最近事件列表裁剪不影响重试。坏状态文件会报错并保留原内容。

最近事件保留七天、最多五百条；完成的送达记录保留十四天、最多五千条；待发记录不按数量裁剪。去重与评论登记保留十四天。切换到影子模式会把已有待发记录转为影子记录，切回实发不会补发这些记录。停用期间不轮询；重新启用后按保存的游标追读并受消息摘要上限约束。

令牌保存前请求 GitHub `/user` 验证。请求仅发往 `api.github.com`，拒绝重定向、跨主机分页和 `/notifications`。客户端令牌输入为密文，保存成功后清空；RPC 快照、日志、状态文件不包含令牌。令牌文件本身是权限受限的本机文件，未声称由系统钥匙串加密。

## 模块、机器配置和两个实例（#1737）

服务端入口 `index.server.ts` 只做组装：读机器配置，建共享守护进程连接和服务，注册模块。

- **模块**：`server/modules/<名称>/index.ts` 导出一个 `Module`，加到 `server/modules/index.ts` 的 `MODULES`。每个模块的注册单独捕获错误，失败只停这个模块；处理函数、钩子和 Provider 回调在模块的异步上下文中运行。进程级 `unhandledRejection` 和 `uncaughtException` 按模块记录，不让插件进程退出。RPC `modules.status` 返回每个模块的状态（运行、关闭、出错和原因）。
- **共享连接**：`server/core/daemon.ts` 的 `SharedDaemon`，用法 `const { paseo, client } = await context.services.daemon.ready()`。守护进程启动初期 `paseo.pid` 没有监听地址，连接最多等 60 秒；失败后下次调用重试。不要在模块中另开本机连接。
- **机器配置**：`~/.paseo/github-subscriptions/machine.json`（可用环境变量 `PASEO_GHSUB_MACHINE_CONFIG` 指定），样例见 `config/machine.example.json`。同步读取。`modules` 写模块开关；其他键是各模块登记的区块（模块定义中的 `config: { section, spec: { schema, fallback } }`）。一个区块不合法只停用依赖它的模块。没有文件时全部用默认值，默认值等于整合前的行为。
- **两个实例**：角色由 `shared/instance.ts` 决定。仓库中为 `null`（兼容模式：按 main 处理并保留云端会话）。部署脚本在部署目录中写入 `'main'` 或 `'provider'`：
  - `main`（安装 ID `github-subscriptions`）：页面和除 Provider 以外的全部模块。云端程序写死调用这个 ID，所以主实例保留云端会话的 RPC 并转给 Provider 实例。
  - `provider`（安装 ID `dev-automation-providers`）：只注册 Provider 模块，状态写到 `~/.paseo/github-subscriptions/providers/`，不注册任何界面。
- **部署**：`node --experimental-strip-types scripts/deploy.ts --role main|provider|compat --ref <标签或提交> [--install] [--reload]`。重载前检查旧实例和新实例托管的 Provider 有没有运行中轮次，有就停止。目标目录的现有角色与目标角色不同时停止；确认变更后可加 `--change-role`。`compat` 保持角色文件为 null。
- **提交前扫描**：`npm run scan`（已包含在 `npm run check`），命中邮箱、Apple 隐藏邮箱、webhook 地址或令牌格式时失败。测试数据所在行写 `scan-allow`。

## 开发检查

在本目录执行：

```sh
npm run check
npm run vendor:check
npm run test:daemon
```

`check` 包含类型检查与单元测试，不改变仓库根目录的 `pnpm check`。隔离联调用临时 PASEO_HOME、独立端口、固定提供方与网络夹具；没有真实模型调用，没有真实 GitHub 请求。测试结束只停止自建守护进程，并删除临时目录。

提交保留检查汇总、复现脚本和必要实测记录。下表中的 daemon 原始报告、日志及界面 `out/` 均为本地输出，不随源码提交；可按复现说明重新生成。

| 材料与本地输出 | 范围 |
| --- | --- |
| `validation/summary.json` | 类型检查、七十三项测试、隔离联调、组件预览与安装包检查的汇总和边界 |
| `validation/daemon/latest-result.json` | 真实隔离守护进程加载、工具注入、RPC、送达幂等、重载、重启和归档 |
| `validation/ui/out/results.json` | 实际客户端组件在 React Native Web 预览中的八十四项交互与布局检查 |
| `validation/ui/out/gifs/` | 胶囊取消、跳转、两个会话、窄屏面板、令牌和设置流程 |
| `validation/ui/out/shots/` | 宽窄布局、深浅主题、空状态与错误状态截图 |
| `validation/gh-self-comment-20261106.json` | 真实 GitHub 评论读回、会话标记识别和发布会话自通知过滤 |

界面预览说明与复现命令见 [界面验收](validation/ui/README.md)。该预览使用真实客户端组件、假宿主和假 RPC，主题颜色为近似值，不能代替原生 Paseo 的生产验收。Mac Mini 已验证从胶囊进入全局页；用户报告的重复弹层尚未复现，根因待确认。手机系统面板、真实胶囊排序、MacBook 原生界面和二十四小时影子观测仍需验证。

## 账号额度与问题答复模块（#1737 第二期）

`usage.claudeAccounts`、`answer.quietChildren`、`answer.escalation` 三个模块和 `core/session-roles`（主会话 = 置顶工作区中的会话）。默认关闭，在 `machine.json` 的 `modules` 中打开；区块 `claudeAccounts`、`quietChildren`、`escalation` 见 `config/machine.example.json`。行为变化、旧状态迁移（只复制）、旧插件保护和已知限制见 [docs/answer-usage-modules.md](docs/answer-usage-modules.md)。

## 原型复用边界

`server/vendor/dsh-superagent` 由 `scripts/vendor-sync.ts` 生成三个纯逻辑副本，只调整导入并记录原文件 SHA-256。`shim.ts` 是本插件适配层。漂移检查会在原型变更时失败，更新时运行 `node --experimental-strip-types scripts/vendor-sync.ts` 后检查差异。

事件格式、CI 摘要与 `readGithub` 复用原型纯函数；GitHub 请求通过本插件的 fetch 适配器执行。未复制原型的命令执行器、Web、Eval、Ticket 或 Executor。安装包只包含客户端、服务端、共享定义和用户说明，不包含夹具、截图及开发依赖目录。

## 云端会话 Provider

插件同时提供 `cloud-session` Provider：云端会话按稳定编号对应 Paseo agent，推送时间线，并接收面板消息和子会话通知。代理所有 Paseo MCP 工具；调用 `create_agent` 时调用方必须显式提供 `settings.modeId`。注册标题由云端提供，之后可由会话改名。

代理只使用 daemon 在会话打开时提供的本机 Paseo MCP 地址及请求头；注册和恢复通过本机 Paseo daemon 客户端完成。地址和凭据只保存在内存，不由云端选择。云端会话模块与 GitHub 订阅的初始化独立。 导入时按云端工作目录的最后一段匹配本机项目名称，优先选择有未归档工作区且目录存在的项目；没有匹配时使用存在的 `fallbackCwd`，否则使用本机用户主目录。

新注册的云端会话创建独立本地工作区并尝试置顶；已注册会话沿用现有工作区。权限与提问可映射到 Paseo 原生请求，云端工具结果会关闭请求。

云端 `AskUserQuestion` 提问统一接入在线离线问答体系：在线时语音提醒并等待人工回答，离线时只选明确推荐项（沿用验收、合并、登录、资金与清理拦截）。人工可在插件人工待办或 Paseo 原生提问界面选择单选、多选、多题及填写“其他”自由文本；回答经 `answerWebRequest` 转交已配对浏览器扩展，在唯一打开该会话的 claude.ai 页面复核并逐页点选提交。云端会话的网页提问在同步到 Paseo 前也不由网页侧自动代答，已有对应云端提问时隐藏网页副本。人工回答不按关键词拦截，自动代答仍按离线规则拦截。

云端权限请求在 Paseo 里只作显示，不在 Paseo 侧点击网页；由浏览器扩展在 claude.ai 页面自动点击“Allow once”（含打开“More allow options”菜单点击“Allow once”，永不点击“Always allow”）。已知限制：经 Paseo 原生界面作答多选题时，若“其他”文本恰好等于某个选项标签，会被当作选中该选项（插件人工待办无此限制）。

收件队列仅存于内存：插件或 daemon 重启后未确认消息丢失，不自动对账。支持联系信号的云端会话在失联达到阈值后结束轮次；旧程序不使用该兜底。面板的停止按钮对 Paseo 开启的这轮不起作用。插件重启时，如果云端正在重试消息确认，序号可能错位并删除新到的消息。真机端到端验收需另行进行。

本机可使用 `node --import ./tests/resolve-js-to-ts.mjs --experimental-strip-types scripts/rpc.ts capacity.snapshot '{}'` 调用主实例。脚本只允许 `capacity.clear-review`、`dispatch.finalize` 和已登记的只读快照方法；输出隐藏主机地址和凭据字段。

问答模式远程切换（总控只能用 paseo CLI 连 Mac mini 时）：仓库根目录 `paseo.json` 登记了 `presence-offline`、`presence-online`、`presence-auto`、`presence-status` 四个工作区脚本，调用部署目录的 `scripts/presence-mode.ts`，只改 `mode`，其余设置保持。命令：`paseo script start presence-offline --host <Mac mini> --workspace <Mac mini 上本仓库的工作区>`，再用 `paseo script ls --host <Mac mini> --workspace <同上> --json` 读该脚本的 `exitCode`：切换脚本 0 = 读回一致，1 = 失败；`presence-status` 20 = 判定在线，21 = 判定离线，22 = 未知。

`cloudSession.offlineMinutes` 默认 120，最少 60。新云端程序每分钟发送空时间线作为联系信号。插件只对收到该信号并持久化标记的会话执行失联兜底：两小时没有联系时结束运行中轮次并撤下待答请求，提醒在网页核对。现有浏览器扩展没有可靠的归档或不存在信号，不把页面关闭或读取失败视为归档。可信云端调用方可用 `cloud-session.ended` 明确报告归档或不存在。新心跳需要更新云端程序；旧程序没有周期联系，未收到信号的会话保留原有存量请求对账规则，不会因失联超时结束轮次。Mac mini 自身停机或断网超过两小时后，恢复时可能将已标记会话按云端失联处理。
