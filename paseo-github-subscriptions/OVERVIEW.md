# 开发自动化

插件沿用 `github-subscriptions` 标识。侧边栏入口为「开发自动化」，包含概览、问答模式、浏览器分组、GitHub 订阅、人工待办和最近动作。

## 在线与离线问答

「问答模式」统一登记 Paseo 原生提问和已配对浏览器里的 Claude Code 提问。插件不自动代答（不选推荐项）；代答由总控（Grok）按用户选择画像决定。

- 自动：读取所选主机的手机蓝牙在场状态。
- 在线：在所选主机语音提醒，提问进入人工待办并按时段规则升级通知总控。
- 离线：不播报语音提醒，提问进入人工待办并按时段规则升级通知总控。

自动模式读取 `~/.claude-guard/proximity-state.json` 和 `auto-answer.flag`。状态超过两分钟、没有有效信号或两份状态尚未同步时显示「判定未知」，不播报语音，照常通知总控。有效手动覆盖优先。跨主机读取和语音使用已有 Paseo 主机连接，两台主机都需要安装本版插件；断连时显示原因。

在「问答模式 → 蓝牙锚定设备」中刷新设备列表，选择随身手机或手表。设备来自所选的来源主机；列表显示地址末尾、连接状态和信号强度。也可以输入系统蓝牙列表中的完整名称。同名设备有多台时，应从列表按地址选择。暂时未发现设备时保留原选择。

选择保存到来源主机的 `~/.claude-guard/proximity-target.json`。来源主机需运行本仓库 `scripts/proximity-away.py` 采样器，且与 Paseo 使用同一 macOS 用户。采样器每 30 秒读取目标；切换设备后重新累计时间，信号持续不低于 −78 dBm 60 秒判为在线，持续不高于 −88 dBm 120 秒判为离线。新设备尚未形成稳定判定、没有信号或配置版本不一致时保持未知。设备显示「已连接」不代表系统提供了信号强度。

人工待办显示来源、会话名称、问题和选项，支持单选与多选。原生提问在待办卡片上提供「打开会话」按钮；网页回答核对会话、问题内容和有效期，「已提交」表示扩展已操作页面，不能证明 Claude 已处理。结果未知时不自动重试。暂停或切换模式会取消尚未下发的网页回答。登录、两步验证和安全验证仍由用户处理。

## 人工待办与停滞会话

人工待办保留未回答、正在提交和结果未知的问题。已回答的问题在下次持久化时自动清理；网页回答需要扩展完整读取同一会话，确认问题已消失后才移出。关闭标签页、读取失败或只点击提交都不作为完成证明。

涉及每日任务、复盘审阅、本机现场确认、最终验收、登录验证、资金操作和破坏性清理的问题会标记为仅限用户本人确认（`ownerOnly=true`）。合并与发布不标记为 `ownerOnly`。完整扫描确认原问题已经结束后，未知结果会转为已处理。

「网页等待处理」展示已配对网页的等待输入或用量限制提示及最后消息。只采用最近九十秒的状态；已有问答的网页不重复显示。网页后台子任务和监听仍需打开原会话核对，不自动续推或换账号。

## 语音提醒

语音沿用原方案的 Glass 提示音、晓晓中文神经语音和三分钟冷却。插件内置 `node-edge-tts` 直接合成神经语音，无需安装 Python；仅在内置合成失败且显式配置 `ASKUSER_PYTHON` 或存在专用 `~/.claude-guard/speech-venv/bin/python3` 时尝试 Python `edge_tts` 回退（绝不调用系统 `/usr/bin/python3`），神经语音仍失败时回退到系统 Flo 语音。可用 `ASKUSER_VOICE` 指定声音，并沿用来源主机的代理设置。重新部署时保留整个 `~/.claude-guard` 目录。

只有语音播放进程成功退出才记录已提醒。提示音成功不算语音成功；失败保留原因，三分钟后可以重试。成功记录保存在来源主机，插件重启后不重复提醒同一道题。播放历史区分神经语音、系统语音、失败和取消。

关闭语音、暂停、切换模式或声音主机、问题结束时，会取消对应提醒。跨主机播放超时也会发送取消；来源主机断连时无法保证立即停止，界面会保留失败原因。插件只能确认播放进程的结果，不能确认用户实际听到声音。

「停滞主会话」显示本机未归档、没有父会话标签的主会话。主会话没有活动轮次和待处理请求，跨主机子孙会话与提供方子代理都不在工作，且整个会话家族没有有效 GitHub 监听或定时唤醒任务时，才列入待办。卡片显示最后一条助手消息，支持打开原会话；恢复工作或监听后自动移出。任一来源主机或子代理读取失败时显示错误，不把读取失败当作停滞。

## 浏览器自动同意与分组

配套浏览器扩展安装后按网页会话名称自动分组；仅当已完成本机 Paseo 配对且 `approvalEnabled === true` 时，才自动点击 Claude Code 网页权限窗口的同意按钮。未配对或配对地址格式无效时立即将 `approvalEnabled` 置为关闭并停止点击；同步连续失败超过 3 分钟时自动将 `approvalEnabled` 置为关闭。每个浏览器环境有独立身份；同名会话使用会话编号后缀区分。详细操作见 [扩展说明](browser-extension/README.md)。

扩展保留人工改名。如需让分组使用 Paseo 会话名称，可在高级设置中配对同一台电脑的 Paseo 插件。桥接仅监听本机回环地址，端口冲突时可在控制台改端口。名称同步默认关闭，不影响扩展独立分组。

自动点击根据网页可见按钮和权限文字识别弹窗，网页结构变更可能影响识别。扩展选项提供自动点击开关，并受本机 Paseo 同步状态控制（只有 `approvalEnabled === true` 才点击）。网页提问与自动点同意均需完成一次 Paseo 配对；配对后网页提问出现在人工待办，并接入升级通道按时段规则通知总控（插件不代答）。未配对时仅保留独立分组功能，不自动点同意、不上传问题。

## 暂停与恢复

「暂停 Paseo 模块」暂停问答处理、Paseo 名称同步和 GitHub 监听。浏览器扩展的自动点击需在扩展选项中关闭；停用扩展可同时停止点击和分组。某个 Paseo 模块失败时，其余模块仍更新。「恢复本页暂停前状态」仅在当前页面保留恢复点；关闭页面或刷新后，可分别启用所需模块。暂停不删除标签组。

## GitHub 订阅

GitHub 订阅插件每 60 秒检查一次仓库变化，把会话订阅的事件发给本机 Paseo 会话。默认使用影子模式：记录事件和匹配结果，不发送消息。

在「开发自动化」中打开「GitHub 订阅」，可查看订阅、最近事件和监听状态。在设置页保存 GitHub 令牌，检查「给会话注入 MCP 工具」已开启。令牌单独保存在本机权限为 0600 的文件中，界面只显示前缀、账号和额度。

会话可调用 `github_subscribe` 订阅仓库或具体 Issue/PR。订阅后，输入框上方显示 GitHub 胶囊。点击胶囊可查看或取消本会话的订阅。全局订阅页可按仓库或会话分组，并打开对应会话。

整仓库默认接收新建、关闭或重开，以及默认分支的 CI 失败和恢复。新提交和评审需要指定 PR。具体 Issue/PR 默认选择所有适用事件。`github_read` 可读取详情、评论、评审和 Actions CI；评论与评审支持分页。会话使用 `gh issue comment` 或 `gh pr comment` 发布用户已授权的评论时，按订阅工具描述在正文末尾添加当前会话标记，防止自己的评论通知自己。

确认影子事件正确后，在设置页关闭「影子模式」并保存。新事件会立即发送，同轮按会话合并。忙会话使用 steer；不支持 steer 的提供方默认允许回退中断，也可设置「跳过本轮」。Paseo 收到 steer 时会清除正在等待的提问或审批。

Mac mini 和 MacBook 各自保存设置、令牌和订阅。每台机器只向本机会话发送。取消订阅立即生效；归档会话会取消本会话订阅。关闭的 Issue/PR 三天后到期，期间重开会取消到期时间；连续十四天没有事件的订阅会清理。

## 云端会话

内置 `cloud-session` Provider 将云端会话映射为 Paseo agent，接收时间线并将面板提示和通知排队交给云端。它代理全部 Paseo MCP 工具，`create_agent` 的 `settings.modeId` 由调用方明确提供。注册与恢复使用本机 daemon，MCP 转发只连接 daemon 提供的本机 Paseo MCP 地址；凭据仅保存在进程内。

队列不持久化，插件或 daemon 重启会丢失未确认消息。新云端程序每分钟发送联系信号；收到过联系信号的会话，在运行中轮次或待答请求两小时没有云端联系时，插件结束轮次、撤下请求并提示到网页核对。旧程序保留原有的存量请求对账规则。可在机器配置的 `cloudSession.offlineMinutes` 调整阈值，最少 60 分钟。Mac mini 停机或断网超过阈值后，恢复时也可能触发失联处理。GitHub 订阅与云端会话各自初始化。

## 浏览器环境剩余额度

已配对的浏览器环境在 Paseo 面板额度区域展示 `claude.ai` 的 5 小时窗口和每周窗口剩余额度及重置时间。条目名称优先由插件服务端通过 AdsPower 官方本地 API（默认 `http://127.0.0.1:50325`，可通过配置或环境变量覆盖）查询当前浏览器环境在 AdsPower 中的名称：可在插件“额度设置”中填写 AdsPower API key（只保存在本机权限 0600 的插件状态文件中，不写日志，不返回给前端，前端仅显示“已配置/已配置（来自环境变量）/未配置”，支持清除与重新填写，并保留环境变量 `PASEO_ADSPOWER_API_KEY` / `ADSPOWER_API_KEY` 作为后备来源）；要准确显示环境名称需在扩展选项页填写一次环境序号，单环境自动识别只在本机单个活跃环境且单个扩展上报时生效；读不到名称时按顺序回退显示环境序号、`user_id` 或扩展上报的环境名称，查询失败时在额度详情中显示具体原因（连接失败、需要在额度设置填写 AdsPower API key、API key 无效，请在额度设置重新填写、被限流、未找到环境）。扩展在每个已配对浏览器环境中保持一个后台 `https://claude.ai/settings/usage`（跳转到 `/new#settings/usage`）用量页面标签页，每 10 分钟刷新该标签页并在页面加载完成后只读页面显示的额度比例与重置文字，每分钟通过本机 `/usage` 路由上报当前状态。用户把该用量标签页切走、改地址或关闭时，扩展不强行改回，下一轮读取时另开一个后台用量页面标签页。浏览器未打开、通道关闭、未登录或读取失败时，面板保留并展示上一次同步的额度、环境名称与相对同步时间，超过三天未连接的环境自动移除。扩展不构造 `claude.ai` 请求，不点击任何页面，不刷新业务会话标签页，不切换账号，也不修改网页设置。

## Claude 账号额度、升级通知和子会话免提醒（#1737 第二期）

三个模块默认关闭。行为、配置和迁移见 `docs/answer-usage-modules.md`。主会话是置顶工作区中的会话；停滞会话、子会话免提醒和升级通知使用同一判定。

### 复制自 Paseo 自带插件的文件

`server/vendor/paseo-0.15.0/claude-usage-source/` 原样复制 Paseo 0.15.0 自带插件 `claude-usage-source` 的 `server/usage.ts`、`server/stores.ts`、`shared/input.ts` 和 `icon.svg`，保持相对路径，没有修改。Paseo 更新后运行 `npm run vendor:check` 比较，有变化时重新复制。自有逻辑放在 `server/modules/usage-claude-accounts/`。

### 迁入的旧插件

| 旧插件 | 迁入模块 | 来源版本 |
|---|---|---|
| `claude-quota-resume` | `usage.claudeAccounts` | 2026-11-07 的本机副本（OVERVIEW 更新于 11 月 7 日，要求 Paseo ≥ 0.14.0，已核对 0.15.0） |
| `subsession-quiet` | `answer.quietChildren` | 本机副本 0.0.0 |
| `event-notifications` | `answer.escalation`、`answer.quietChildren`（事件转发） | Mac Mini 副本，包含 2026-11-08 的启动重试修复 |

## Antigravity 多账号 Provider

`providers.antigravity` 模块在 Provider 实例（或兼容模式主实例）中按 `machine.json` 的 `antigravity.accounts` 列表注册 Antigravity Provider。模块默认关闭，保持原有 `antigravity-cy517`、`antigravity-beibeimao` 等 Provider ID 不变，已有会话可直接恢复；显示名称与启动命令从配置读取，源码不含邮箱或机器路径。

- 复制文件来源与版本：`server/modules/providers-antigravity/server/internal/{catalog,process,prompt,session,signals,timeline,wire}.ts` 复制自 Paseo 0.15.0 内置的 `antigravity-provider`，与其逐文件一致，只有两处差别：导入路径加了 `.ts` 后缀；`signals.ts` 加了 macOS 进程组 `EPERM` 信号回退修复。配置驱动的工厂与 RPC 位于单独文件 `provider.ts` 和 `index.ts`。
- 读取和写入的本机文件与环境变量（不复制凭据）：
  - `PASEO_GHSUB_MACHINE_CONFIG` 或 `~/.paseo/github-subscriptions/machine.json`：读取 `modules["providers.antigravity"]` 与 `antigravity.accounts`。
  - `PASEO_HOME`（默认 `~/.paseo`）下的 `~/.paseo/config.json`：同步读取 `plugins["<providerId>-provider"]`（若旧插件仍启用，或 config.json 读不出、无法解析，都按“仍启用”处理：跳过该账号并报错）及 `agents.providers[providerId]`（新增账号时写入 `enabled`、`label`、`command`、`env.HOME`、`env.HTTPS_PROXY`、`env.HTTP_PROXY`）。
  - 各账号的 Antigravity CLI 在其配置的 `HOME` 目录下自行读取登录凭据。
- `machine.json` 的账号 ID 必须匹配 `antigravity-[a-z0-9][a-z0-9-]{0,31}`，因此不会占用内置 `antigravity`、`cloud-session` 等 Provider ID。`homeDir` 只在新增账号时写入 Paseo 配置的 `env.HOME`；之后页面显示 Paseo 配置里的值，启动不读 `machine.json` 的 `homeDir`、`proxy`。
- 新增账号（`antigravity.account.add`）：`command`、`env`、`label` 不在 `paseo.config.patch` 支持范围内，所以直接写 `~/.paseo/config.json`——先备份（`config.json.bak-<毫秒时间>`）、原子写入、读回核对，再写 `machine.json`（同样先备份）；`machine.json` 写失败时用备份恢复 `config.json`。任一文件存在但无法解析时报错，不写入。新账号需要重载 Provider 实例才生效。
- 启停账号（`antigravity.account.toggle`）：写 `machine.json`（先备份），再向守护进程发 `paseo.config.patch` `{ providers: { <id>: { enabled } } }` 并检查返回；失败时恢复 `machine.json` 并报错。
- “需要重载”不存在内存标志里，而由“启动时实际注册的账号”和“配置里启用的账号”比较得出；Provider 实例重载后自动清除。

## 其他 Provider 额度来源

`usage.providerQuotas` 模块在主实例中按 `machine.json` 的 `providerQuotas` 配置逐个启用额度来源，并支持配置隐藏 Paseo 内置额度来源（`hideBuiltin`：可选 `codex`、`cursor`、`grok`、`kimi`、`zai`）。模块默认关闭。注册前同步读取 `~/.paseo/config.json` 的 `plugins`：若 `provider-quotas-usage-source` 仍启用则跳过对应来源并报错；若 Mac mini 上的 `glm-usage-source` 仍启用则跳过 `glm` 来源并报错，确保 `glm` 在两边只注册一次。

- 复制文件来源与版本：`server/modules/usage-provider-quotas/server/{usage,usage-display,token-switch,token-hub-quota,token-hub-browser}.ts` 与 `icons/{antigravity,codex,cursor,grok,qoder,zai}.svg` 复制自本机插件 `provider-quotas-usage-source` v0.1.0，之后做过以下修改（不再是原样复制）：删除了内置的 Antigravity OAuth 客户端密钥，改为读环境变量或 `agy-oauth.json`；网络与代理代码移到 `net.ts`；凭据写回改为原子写入；Codex 不再刷新令牌；子进程统一跟踪并在模块停止时结束。模块开关、旧插件冲突保护、内置来源隐藏及 RPC 位于单独文件 `index.ts` 和 `hide-builtin.ts`。
- **`hideBuiltin` 目前只保存配置，还没有生效**：过滤内置额度来源的显示需要在客户端实现，尚未做；快照的 `hideBuiltinApplied` 为 `false`。
- 各额度来源读取的本机文件与环境变量（不复制凭据）。**令牌刷新会写回原文件**：Antigravity 和 Cursor 刷新访问令牌后，以原子写入（临时文件再改名，权限 0600）写回原凭据文件，Cursor 同时保存新的刷新令牌；Codex 令牌过期时只提示，插件不刷新、不写回（刷新会让 Codex CLI 登出）：
  - 公共配置与代理：读取环境变量 `PASEO_HOME`（默认 `~/.paseo`）、`~/.paseo/config.json` 的 `plugins` 与 `agents.providers`；网络请求读取 Provider `env.HTTPS_PROXY` / `env.HTTP_PROXY`、进程环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，以及 macOS 系统代理（`scutil --proxy`，先读 HTTPS 再读 HTTP，遵守例外列表；调用带 2 秒超时，结果缓存 60 秒）。账号显式配置的代理连接失败时报错，不改直连；带刷新令牌的请求即使走系统代理，失败也不直连。
  - `antigravity`（Antigravity 额度）：读取会话或 Provider `env.HOME`（默认系统主目录 `~`）下的 `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`；OAuth 刷新读取环境变量 `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` 或 `~/.paseo/github-subscriptions/agy-oauth.json`。
  - `codex-multi`（Codex 多账号额度）：读取会话或 Provider `env.CODEX_HOME`（默认 `~/.codex`）下的 `<CODEX_HOME>/auth.json`。
  - `cursor-cli`（Cursor 额度）：读取会话或 Provider `env.HOME`（默认 `~`）下的 `<HOME>/.cursor/auth.json` 或 `<HOME>/.config/cursor/auth.json`。
  - `grok-multi`（Grok 多账号额度）：读取会话或 Provider `env.GROK_HOME`（默认 `~/.grok`）下的 `<GROK_HOME>/auth.json`，令牌失效时调用 Provider 配置的 `grok` 命令刷新。
  - `glm`（GLM Coding Plan 额度）：读取会话或 Provider `env.XDG_CONFIG_HOME`、进程环境变量 `XDG_CONFIG_HOME`（默认 `~/.config`）下的 `<XDG_CONFIG_HOME>/glm-acp-agent/credentials.json` 中的 `z_ai_api_key`。
  - `qoder`（Qoder 额度）：调用 Provider `command[0]` 或 `~/.local/bin/qodercli`（以 `--sdk` 协议运行，传入 Provider `env.HOME` 或系统主目录）。
  - `opencode-token-switch`（OpenCode TokenHub 额度）：只读打开 `<HOME>/.token-switch/token-switch.db`（SQLite）、读取 `env.OPENCODE_CONFIG` 或 `<XDG_CONFIG_HOME|~/.config>/opencode/opencode.json`、读取 `~/.paseo/token-hub-browser.json` 并通过 `~/.local/bin/ego-browser` 查询同账号共享额度，脱敏后的观测时间缓存在 `~/.paseo/cache/provider-quotas-usage-source/`。

## 主会话收尾与容量

可选模块自动整理带需求单号的主会话，并按 Claude 实时额度计算可承接数。额度用尽时，可在已核实的 Claude 账号之间迁移主会话；点名账号的会话保留原账号并报告异常。收尾、容量和迁移事件发送到现有总控 webhook。模块默认关闭，迁移默认关闭；配置和联调步骤见 `docs/answer-usage-modules.md`。
