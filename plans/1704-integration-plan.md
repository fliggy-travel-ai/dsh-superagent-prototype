# #1704 集成核查与最小方案

2026-11-07，静态调查；未操作网页、启动/停止 guard、安装扩展或修改插件。此报告补充并更新 `1704-source-audit.md` 的仓库结论：当时检出的旧 HEAD 无插件，现在 `main` / `origin/main` 为 `21ab7288637041a421da6ed6b678b7ccd47fc741`，已经包含插件。旧报告中的其他 guard 审计仍按当时的源码证据理解，不代表运行进程状态。

## 当前插件事实及建议落点

`paseo-github-subscriptions/paseo-plugin.json` 的 ID 是 **`github-subscriptions`**，要求 `>=0.15.0 <0.16.0`；`package.json` 将 `@getpaseo/plugin`、`client`、`protocol` 固定为 0.15.0。`index.server.ts:10-73` 管理原 GitHub Runtime、RPC、工具注入和 archive hook；`index.client.tsx:10-26` 注册两个 screen、sidebar 和 composer pills；`client/screen/index.tsx:9-68` 是订阅/事件/状态三页签。`shared/contracts.ts` 使用 `defineRpc`，`server/storage.ts:9-50` 是版本 1 状态和串行原子写；`server/daemon.ts:8-38` 建立单独的本机 Paseo 客户端。`server/delivery.ts:113` 的 GitHub steer 可能影响待处理权限，插件工具描述也明确提到这一点。

建议保留 manifest ID、现有 screen ID、GitHub 功能及配置语义；在 `server/permissions/`、`server/browser/`、`shared/` 下增量增加独立模块、契约和状态，在原主屏增加“自动化”“浏览器分组”页签；注册及注销放在既有入口/cleanup。单独版本化权限与浏览器状态，避免破坏 GitHub `StateSchema`；不将 GitHub 事件重试机制用于权限。扩展作为单独浏览器工件与插件配套，需显式加入打包清单与安装说明，不能只改插件的 `files` 推断自动安装到浏览器。

## 0.15.0 原生权限：已核对的 API 与缺口

证据为 npm 发布的 `@getpaseo/plugin@0.15.0` 的 `dist/server/lifecycle.d.ts`、`@getpaseo/protocol@0.15.0` 的 `dist/agent-types.d.ts` / `messages.d.ts`、`@getpaseo/client@0.15.0` 的 `dist/index.d.ts` / `daemon-client.js`，以及公开 [hooks 文档](https://paseo.sh/docs/plugins/hooks.md)。并非运行时验证。

- `server.addHook('agent.permission.before', async ({agent, request}, context) => ...)` 接收 `agent.id`、`workspaceId`、`provider`、`title` 等和 `AgentPermissionRequest`；该 hook 标为 `waits: false`，是请求成为 pending 时的通知，不阻塞其他处理。`request` 有 `id`、`provider`、`name`、`kind: 'tool' | 'plan' | 'question' | 'mode' | 'other'`、可选 `input/detail/actions/metadata`。`actions` 可含 allow/deny 和 action id，但类型未保证其具体提供方语义。
- 0.15.0 高层 SDK 的确切接口是 `context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: 'allow' } })`，**不是**已在此版本类型中找到的 `permissions.respond`。可选 `selectedActionId`、`updatedInput`、`updatedPermissions`；不要自动改变 input、写入持久授权或选择未知 action。各 provider 如何解释无 selectedActionId 的 allow，需要在受控 fixture 验证，不能假设统一为一次授权。
- `handle.refresh()` 返回 `{agent, project} | null`；快照 `agent.currentModeId`、`pendingPermissions` 和 `archivedAt` 可用于最近一次核对。`ref()` 的缓存没有快照前为 null，不能把空缓存当不存在；`PluginHookAgent` 自身没有 mode。Accept Edits 对应哪个 provider/mode ID 必须实测，不能用展示名称猜测。
- 高层 `respondToPermission()` 在该版本调用底层 `sendSessionMessage`，返回 `Promise<void>` 只说明发送调用结束；不是 daemon/provider 已解析确认。`agent.permission.after` 提供 `{agent, requestId, resolution}`，订阅并匹配才可观察到解析；即便如此，与手动处理或其他插件并发时，单凭相同 resolution 不一定能证明由本插件产生。公开 `DaemonClient.respondToPermissionAndWait` 存在，但高层 handle 没有该方法；相关原子性、超时及冲突语义仍需核查，不能仅凭方法名宣称 exactly-once。
- 时序陷阱：通知可能延迟/重复或在插件重启、断线期间丢失；刷新后到发送前仍有 TOCTOU，人工批准、GitHub steer、session 关闭、模式改变和授权撤销均可发生。按 `{host, agent.id, request.id}` 单飞并预登记 attempt，hook 先注册后加载状态，实时检查启用/授权版本、provider、精确 tool 名、kind、mode、pending；但插件本地检查不是 daemon 原子 compare-and-resolve。遇断线、超时、重复、非 pending、无准确模式或授权版本变化，记 unknown/跳过，禁止自动重发；监听 after 时注册要早于发送且以 request ID 对账。自动批准前必须通过受控测试证明宿主对已解决或过期 request 的拒绝行为，仍无法证明模式/授权变化与响应原子一致时，界定这一残余风险并要求宿主提供原子条件接口或保留人工。

建议授权按 daemon/host + `agent.id` + provider + 精确工具名存显式列表，默认关闭，有撤销/到期，明确展示授权范围；只允许 `kind === 'tool'` 且请求与列表完全匹配，`question/plan/mode/other` 留给人。工具名白名单不约束该工具任意参数或副作用：UI 必须准确表达该范围；对需要参数约束的工具要增加经验证的结构化规则，否则不授权。模式不明确或 provider 未验证时不自动处理。不要靠自然语言、关键词黑名单或 Accept Edits 本身推导用户授权。

## Claude 网页审批：旧 DOM 不能提供可靠证明

`~/.claude-guard/matcher2.js:33-41,88-105,140-181` 使用按钮标题匹配、否定按钮同祖先或浮层样式及权限文本，返回的是裁剪的 question、label、URL、时间戳；`probe.js:56-105` 返回额外坐标。角色选择器和文案是 UI 形态启发式，不是受契约保护的权限请求锚点。`matcher2.js:161-167` 的截断 question 和 `:302-303,323-327` 问题文本 hash 是本地去重，既非服务端 request ID，也可能碰撞或被重渲染重用。页面 `session_...` 只标识 Claude 路由，不证明 Paseo agent/session 或具体用户授权，且 permission 匹配代码在 `:280` 的严格 code-session 检查之前执行。旧源码未发现可验证的稳定权限请求标识、工具类型/参数结构或保证只批准一次的协议。

因此现有源码不足以实现按会话明确授权的**网页自动审批**；需要 Claude 提供受支持的请求标识、结构化权限信息与可验证结果，或取得单独且充分的证据和机制后再重新设计。当前可做页面名称分组；网页权限、登录/验证码/安全验证、AskUserQuestion、计划和模式保持人工。旧 probe 有滚动和修改 disabled 的副作用，不能作为只读观测直接迁移；不迁移 Always allow、自动代答、可信鼠标补点、失败未知重试、账号 cookie/usage 采集。

## MV3 分组和本机桥接

旧 `~/.claude-guard/tabgroup-ext/manifest.json` / `bg.js:11-171` 已通过 `tabs.query`、`tabs.group`、`tabGroups.update`、`scripting.executeScript`、`storage.local`、`alarms` 对 Claude 会话标签分组。按用户当前要求，未绑定标签可使用**该 Claude 页面自己的标题**；优先匹配完整路由对应的侧栏锚点或页面自身标题，无法可靠获取则显示“未命名会话”，不采用旧代码的任意 session 锚点 fallback，也不使用 session 名作为身份。注意旧逻辑对已有 group 可能直接改标题，且新标签各自建组；跨窗口不能假定复用 group。人工改名和手动移动应有明确的保护策略。

**只修改旧扩展不能完成可信的插件通信**：它没有 Paseo 端监听、认证、绑定建立或会话查询，已有 localhost collector 仅接收 usage（`bg.js:173-273`），不能直接复用。最小实现必须同时增加插件侧桥接和扩展侧客户端；安装、配对、扩展生命周期也属于交付。Paseo 在另一台 daemon 主机时，本机 localhost 不等于浏览器设备所在主机，需显示不支持或另行设计受认证跨主机连接。

建议分两期：

1. **独立分组**：从旧 MV3 提炼 group 部分，删除 usage 与本机 collector 权限；只在用户已打开的 Claude code 页工作。按网页自身名称组，无 Paseo 绑定声明；验证 SPA 重命名、标签关闭、导航、人工修改、service worker 休眠恢复、多 profile/window 与重名情况。
2. **可选绑定**：插件提供本机桥接服务、会话清单及由用户明确发起的配对/绑定 UI；扩展展示当前 tab，用户确认该 tab 与选定的 Paseo agent，再将独立 `{hostId, agentId, browserInstance/profile, windowId, tabId, generation}` 绑定。Paseo title 从插件刷新/事件取得，仅用于显示。tab ID 是浏览器实例内临时值；重启、导航离开、关闭、重新配对后失效或重新确认，不能跨 profile 或基于同名自动复用。同步只发送所需 ID、名称、状态和短期绑定，禁传网页内容、cookie 和凭据。无绑定/桥接断开则回退网页标题分组，不影响 GitHub 或权限模块。

桥接可考虑 Chrome native messaging：由用户安装经固定 extension ID 限定的 native host，使用操作系统用户权限保护宿主文件；插件服务到 native host 的本地 IPC 也需认证、最小权限、消息版本/长度限制、断线及撤销处理。另一方案是仅监听 loopback 的插件服务加明确配对、短期能力凭据、严格 origin/扩展身份校验及 CSRF 防护；**localhost 或 CORS/Origin 本身不是认证**，还需评估同用户本机进程和凭据保管的威胁模型。两者均尚未验证浏览器兼容性及部署可用性；扩展 ID 固定、native host 安装和插件跨进程鉴权是明确的实现工作。不要把能力凭据放 URL、网页 DOM 或日志。

## 交付边界与验证

建议原型负责人先完成插件权限模块的离线假宿主测试及分组扩展独立测试：精确会话与 tool 授权、Accept Edits 识别、人工先解析、重复/失序通知、撤销、关闭、GitHub steer、发送后断线、after 丢失、插件重启；并测重名、跨 profile、tab 复用、绑定撤销、非法桥接来源和扩展重启。随后在用户授权的受控环境实测 0.15.0 各 provider 对 action 与解析的行为及桥接身份，不把 mock 结果写成线上验收。权限处理若缺原子条件保证或可验证的用户授权/模式，以人工处理作为明确降级。此 sidecar 没有做运行实验，也未确认现有 guard 是否正在运行。
# 后续实施说明

本文保留初始方案。当前交付包含用户后续授权的问答、语音和人工待办能力，详见 [原方案迁移对照](1704-source-migration.md)。初始阶段的限制与待核实事项需结合后续实现和验证记录阅读。
