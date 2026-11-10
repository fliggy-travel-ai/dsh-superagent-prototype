# 整合方案

## 细化记录（2026-11-08）

依据 feasibility.md 的代码核对和用户决定（open-questions.md）。

| 改动 | 位置 | 依据 |
|---|---|---|
| 改为**同一份代码装两个实例**：`github-subscriptions`（页面和其他模块）和 `dev-automation-providers`（只运行 Provider 模块）。实例角色由部署目录中的生成文件决定 | 第 1、3、5 节，新增第 8 节 | 用户决定；插件代码读不到自己的安装 ID（feasibility 3b） |
| “重载断开会话”改为“只让正在执行的轮次失败，空闲会话下次发消息时恢复” | 第 7 节 | `plugin-provider.js:633-643` |
| 新增风险：插件进程崩溃不会自动重启；`core` 加进程级异步错误保护 | 第 3、7 节 | `runtime.js:988-1003` |
| 来源 ID 自检改为同步读取 `config.json` 的旧插件开关；Provider 和额度模块开关重载后生效 | 第 3、7 节 | Provider 和来源只在启动时上报一次（feasibility 5） |
| 新增 `core/hosts`：待办两台合看由服务端转发；Provider 页按所选主机 | 第 3 节 | feasibility 第 1 项 |
| `core/daemon` 必须等待 `paseo.pid` 写入地址后再连，沿用主插件 60 秒重试 | 第 3 节 | 事件通知失败根因（feasibility 第 4 项） |
| 迁移第 0 步改为“先修旧事件通知插件” | 第 5 节 | 用户决定 |
| 会话角色只看置顶工作区；父会话标签只用于找转发目标（待确认） | 第 3 节 | 用户决定；feasibility 第 8 节 |
| 代答和升级保持两套独立规则 | 第 3 节 | 用户决定 |
| 待办不再收 Paseo 原生授权和提问；删除与原生重复的页面功能 | 第 3 节 | feasibility 第 7 节，ia.md 第 6 节 |

## 1. 结论

1. **保留插件 ID `github-subscriptions`**，显示名称保留“开发自动化”。其他 10 个插件的功能迁入这份代码，然后停用旧插件。
2. **同一份代码装两个实例。** `github-subscriptions` 运行页面和除 Provider 以外的全部模块；`dev-automation-providers`（显示名称“开发自动化 · Provider”）只运行 Provider 模块（云端会话、Antigravity）。更新页面只重载主实例，不影响 Provider 会话。
3. **一份代码，两台机器共用。** 机器差异全部写进每台机器自己的机器配置文件。代码中不写 Provider ID 列表、邮箱、路径或机器名。
4. **源码放在现有公开仓库** `fliggy-travel-ai/dsh-superagent-prototype` 的 `paseo-github-subscriptions/`。私有内容只放在每台机器的状态目录中。
5. **按模块逐个切换。** 每个模块先迁入并默认关闭，再“停旧、开新”。旧插件先停用，保留 14 天，再删除。
6. **两台机器都从部署目录安装。** Mac Mini 不再从开发检出目录直接安装。每个实例一个部署目录。

## 2. 为什么保留 `github-subscriptions`

- 两台机器都已安装。会话中已有 `github_subscribe` 等工具和 GitHub 胶囊，用户已经习惯这个入口。
- 主状态目录 `~/.paseo/github-subscriptions/` 有 1.8 MB 的订阅和事件、问答记录、浏览器配对令牌。改 ID 要迁移全部状态，并且浏览器扩展要重新配对。
- Paseo 的插件设置目录按插件 ID 存放，`paseo plugin remove` 会删除该目录。换 ID 就要先删旧插件，风险高。
- 已注册的 `cloud-session` Provider 和 `claude-browser` 额度来源 ID 不变，已有会话可以继续恢复。`cloud-session` 迁到 Provider 实例后 ID 仍不变。
- 跨主机转发调用写死插件 ID `github-subscriptions`（`server/presence-port.ts:48`），两台必须用相同的主实例 ID。

ID 中的“github-subscriptions”与实际范围不符。这只是内部标识，用户只看到显示名称。不为了名称一致付出迁移代价。

## 3. 模块划分

插件内部按“模块”组织。每个模块有自己的目录、状态子目录和开关。一个模块初始化失败时只停这个模块，其他模块继续运行（沿用现有 `ready*()` 分别初始化的做法）。

Paseo 0.15 对模块注册的约束（feasibility 第 3、5 项）：

- `contribute` 中任何同步抛错都会让整个实例启动失败。每个模块的注册放在单独的 `try/catch` 中。
- Provider 和额度来源只在 `contribute` 返回时上报一次，之后不能增减。所以这两类模块的开关、账号列表变化都要**重载对应实例**才生效。机器配置要用同步读取。
- 未捕获的异步拒绝会让插件进程退出，Paseo 不自动重启。`core` 在 `contribute` 开头注册 `process.on("unhandledRejection")`，记录模块名和错误摘要，清理时移除。
- 额度来源和 Provider ID 全局唯一。插件不能在注册前查询守护进程已有哪些来源。做法：同步读取 `~/.paseo/config.json` 的 `plugins`，对应旧插件仍启用时跳过该来源并在页面报错；内置来源 ID 写成固定列表。

| 模块 | 实例 | 页面 | 来源 | 贡献点 |
|---|---|---|---|---|
| `core/session-roles` 会话角色 | 主 | 问题答复 | 统一为“置顶工作区中的会话是主会话”。父会话标签只用于找子会话事件的转发目标（待确认） | 内部服务 |
| `core/daemon` 共享守护进程连接 | 两个 | 无 | 三个插件各自的本机连接。沿用主插件的 60 秒重试，等待 `paseo.pid` 写入地址 | 内部服务 |
| `core/hosts` 跨主机转发 | 主 | 待办总览、Provider 页摘要 | 现有在线状态模块的主机通道 | 内部服务（内部接口集中于此） |
| `providers/cloud-session` 云端会话 | Provider | Provider 与账号 | 现有（从主实例移出） | provider |
| `providers/antigravity` Antigravity 多账号 | Provider | Provider 与账号 | 两个 antigravity-*-provider | provider（按配置列表注册，改列表要重载 Provider 实例） |
| `providers/defaults` 新建会话默认设置 | 主 | Provider 与账号 | codex-speed-defaults、opencode-auto-accept-default、qoder-permission-defaults | `before("agent.create")` |
| `usage/claude-accounts` Claude 账号额度、自动继续、登录续期、显示名称 | 主 | Provider 与账号；会话时间线 | claude-quota-resume | usage source、timeline、hook |
| `usage/claude-browser` 网页额度 | 主 | Provider 与账号 | 现有 | usage source |
| `usage/provider-quotas` 其他 Provider 额度 | 主 | 额度面板（原生） | provider-quotas-usage-source、glm-usage-source | usage source（按配置开关，重载生效） |
| `answer/presence` 在线、离线、自动 | 主 | 问题答复 | 现有。决定是否代答 | RPC |
| `answer/permissions` 精确授权策略 | 主 | 问题答复 | 现有 | hook |
| `answer/browser` 网页提问与扩展桥接 | 主 | 问题答复；Provider 与账号 | 现有。新增“添加浏览器环境”引导 | 本机 HTTP |
| `answer/escalation` 升级通知 | 主 | 问题答复 | event-notifications。按时段决定是否通知 Grok，与代答**独立运行** | hook、webhook |
| `answer/quiet-children` 子会话免提醒和事件转发 | 主 | 问题答复 | subsession-quiet、event-notifications | 订阅会话列表 |
| `github` GitHub 订阅 | 主 | GitHub 订阅 | 现有 | agent tools、pill |
| `todo` 待办汇总 | 主 | 待办总览 | 网页提问、网页等待、停滞会话、升级事件、代答未读。**不收**原生授权和提问、登录和额度提醒（原生已有） | RPC；两台合看经 `core/hosts` |

复制自 Paseo 自带插件的文件放在 `server/vendor/paseo-<版本>/<自带插件名>/`，保持原相对路径，不修改。自有逻辑写在模块目录中。`scripts/vendor-sync.ts` 已有对比功能，扩展到这些目录。Paseo 升级后用它 `diff` 比较。

## 4. 机器差异写成配置

### 4.1 配置位置

| 内容 | 位置 | 权限 | 进不进仓库 |
|---|---|---|---|
| 代码和默认值 | 仓库 | 公开 | 进 |
| 机器配置（模块开关、Provider 账号列表、默认设置规则、时段规则、主机名映射） | `~/.paseo/github-subscriptions/machine.json` | 600 | 不进 |
| 账号显示标签（隐藏邮箱到真实邮箱） | `~/.paseo/github-subscriptions/labels.json` | 600 | 不进 |
| 令牌和密钥 | 现有独立文件（`github-token`、`browser-token`）和 Keychain（webhook） | 600 | 不进 |
| 配置样例 | 仓库 `config/machine.example.json`，用假账号 | 公开 | 进 |

不用 Paseo 的 `registerSettings`。原因：它的目录在 `paseo plugin remove` 时删除，现有模块也不用它。全部状态留在插件自己的目录，一处备份。

### 4.2 机器配置样例（结构）

```json
{
  "version": 1,
  "machine": "macbook",
  "modules": {
    "providers.antigravity": true,
    "usage.claudeAccounts": false,
    "usage.providerQuotas": ["antigravity", "codex-multi", "grok-multi", "qoder", "glm", "opencode-token-switch"],
    "usage.hideBuiltin": ["codex", "grok", "cursor", "kimi", "zai"],
    "answer.escalation": "shadow"
  },
  "antigravity": {
    "accounts": [
      { "providerId": "antigravity-cy517", "label": "Antigravity · <账号>" },
      { "providerId": "antigravity-beibeimao", "label": "Antigravity · <账号>" }
    ]
  },
  "agentDefaults": [
    { "provider": "codex*", "modeId": "full-access", "features": { "service_tier": "priority" } },
    { "provider": "opencode", "features": { "auto_accept": true } },
    { "provider": "glm-acp-agent", "features": { "auto_accept": true } },
    { "provider": "qoder", "modeId": "yolo", "features": { "auto_accept": true } }
  ],
  "escalation": {
    "timezone": "Asia/Singapore",
    "immediate": [ { "days": "daily", "from": "01:00", "to": "09:30" }, { "days": "weekdays", "from": "12:00", "to": "14:00" } ],
    "delayMinutes": 30,
    "webhookKeychainService": "<服务名>"
  },
  "hosts": { "<serverId>": "macmini" }
}
```

规则：

- `agentDefaults` 只在创建请求没有显式值时生效（与三个旧插件行为一致）。Mac Mini 的独立用户 Claude 规则写成 `{ "provider": "claude-user-pilot", "modeIdWhenAuto": "bypassPermissions" }`。该 Provider 目前已不在配置中，迁移时不再写入。
- Antigravity 账号的启动命令、`HOME`、代理继续写在 `~/.paseo/config.json` 的 `agents.providers`。插件只按列表注册 Provider ID 和标签。**Provider ID 必须保持 `antigravity-cy517`、`antigravity-beibeimao`**，否则已有会话无法恢复。
- 新加 Antigravity 账号：在页面“添加账号”，写入两处配置，不复制插件。之后要**重载 Provider 实例**，页面先显示会受影响的运行中会话数。
- 配置文件不合法时，相关模块显示错误并停用，不让整个插件停止。

### 4.3 两台机器的配置差异（迁移后）

| 项目 | Mac Mini | MacBook |
|---|---|---|
| Antigravity 账号 | 无 | 2 个（1 个停用） |
| Claude 账号额度和显示名称 | 开 | 关（无 Claude Provider） |
| 其他 Provider 额度 | `glm` | `antigravity`、`codex-multi`、`grok-multi`、`qoder`、`glm`、`opencode-token-switch`、`cursor-cli` |
| 隐藏内置额度来源 | 无（自带 Claude 来源已改名停用） | `codex`、`grok`、`cursor`、`kimi`、`zai` |
| 新建会话默认设置 | Codex 规则 | Codex、OpenCode、GLM、Qoder 规则 |
| 蓝牙与声音来源主机 | 按现有设置 | 按现有设置 |

## 5. 迁移与停用顺序

先迁移状态、后切换。只复制，不移动。旧状态目录保留到删除旧插件为止。

**第 0 步：备份和修复准备（两台）**

1. 打包 `~/.paseo/{github-subscriptions,event-notifications,claude-quota-resume}`、`~/.paseo/config.json` 到带时间的备份目录（权限 700）。
2. 记录 `paseo plugin ls --json` 和 `paseo usage ls --json`，作为切换后的对照。
3. **先修旧的会话事件通知插件**（用户决定）。根因：守护进程启动时插件先于监听地址写入就去连接，且不重试。按 feasibility 第 4 节“最小修复方案”改 3 个文件，先影子运行，确认后切回实际发送。

**第 1 步：部署整合版本，新模块全部关闭**

1. 建部署目录 `~/.paseo/local-plugins/github-subscriptions`（Mac Mini 新建，MacBook 已有），从主干标签 `git archive` 生成，写入 `shared/instance.generated.ts`（`role: "main"`）。
2. Mac Mini 用同一 ID 改装到部署目录。插件状态目录不变。
3. 建第二个部署目录 `~/.paseo/local-plugins/dev-automation-providers`，同一标签，角色 `providers`。此时 Provider 实例**先不安装**（`cloud-session` 仍由主实例注册，ID 不能重复）。
4. 两台各写 `machine.json`，所有新模块为关。重载插件，对照第 0 步记录，确认行为不变。

**第 2 步：逐个模块“停旧、开新”**。每步之后核对日志、额度列表或对应页面，通过后再做下一步。

| 顺序 | 模块 | 停旧 | 迁移状态 | 注意 |
|---|---|---|---|---|
| 1 | 新建会话默认设置 | 停 codex-speed-defaults、opencode-auto-accept-default、qoder-permission-defaults | 无 | 新旧同时开也只是重复写同一默认值，风险最低 |
| 2 | 子会话免提醒 | 停 subsession-quiet | 无 | 先确认会话角色判定结果与旧插件一致 |
| 3 | 额度来源 | 停 glm-usage-source、provider-quotas-usage-source | 无 | **必须先停旧插件再开新模块**。来源 ID 重复会让整个开发自动化插件停止 |
| 4 | Claude 额度恢复（Mac Mini） | 停 claude-quota-resume | 复制 `jobs.json`、`enabled-agents.json`、`disabled-agents.json`、`usage-history.json`、`cross-user-*.json`、`renewal/` 到 `quota/`；`account-labels.json` 并入 `labels.json` | 同时停旧插件，否则两处同时改写 Provider 显示名称并反复 reload。旧插件停止时会恢复原名称，新模块下一分钟重新加上额度 |
| 5 | 云端会话移到 Provider 实例（两台） | 无旧插件 | 无 | 主实例关闭云端会话模块并重载，紧接着 `paseo plugin install <Provider 部署目录> --id dev-automation-providers`。在没有云端会话运行轮次时做。Provider ID 不变 |
| 6 | Antigravity（MacBook） | 停两个 antigravity-*-provider | 无 | 在没有 Antigravity 会话运行轮次时做。Provider 实例开 Antigravity 模块并重载。Provider ID 不变。先在 MacBook 核对旧插件是否写会话持久化数据 |
| 7 | 升级通知和子会话事件转发 | 停 event-notifications | `config.json` 转入 `machine.json`；`state.json` 复制到 `escalation/`；`events.jsonl` 不复制，保留为旧记录 | 先以影子模式运行，核对记录后切实际发送。按旧插件说明，切换实际发送要用新的去重记录。会话角色改为只看置顶工作区，范围变化见 feasibility 第 8 节 |

**第 3 步：收尾**。全部模块稳定 14 天后，`paseo plugin remove` 旧插件。旧源码打包存到私有位置（含邮箱，不进公开仓库）。旧状态目录再保留 30 天。

## 6. 公开仓库与私有配置分离

- 仓库只放代码、假数据测试和 `machine.example.json`。
- Antigravity 插件中写死的邮箱、`account-labels.json`、AdsPower 环境名、webhook 地址、额度报警凭据路径都不进仓库。event-notifications 代码中写死的 `/Volumes/data/Workspace/Macmini/.quota-webhook` 路径改为机器配置项。
- 加一个检查脚本，在提交前扫描邮箱、Apple 隐藏邮箱域名、`https://` webhook 地址和令牌格式，命中就失败。放入现有 `npm run check`。
- 浏览器扩展、日志、页面不显示令牌原文；邮箱只在本机页面显示。

## 7. 风险与回滚

| 风险 | 影响 | 处理 |
|---|---|---|
| 重载 Provider 实例 | 正在执行的轮次失败；空闲会话下次发消息时从持久化数据恢复；云端会话的未确认消息丢失 | Provider 单独一个实例，更新页面不重载它。重载 Provider 实例前，部署脚本检查运行中轮次，有就停止并提示 |
| **插件进程崩溃** | 子进程退出后 Paseo 撤下该实例且不自动重启，全部模块停止 | `core` 注册进程级异步错误保护；每个模块的异步任务自己捕获错误；部署后检查 `paseo plugin ls` |
| 启动顺序 | 守护进程启动初期 `paseo.pid` 没有监听地址，自建连接会失败 | `core/daemon` 统一重试，所有模块共用 |
| 跨主机转发用内部接口 | `openHostRoute` 等在升级后可能变化，待办合看失效 | 集中在 `core/hosts`；失败时只显示本机待办并提示 |
| 两个实例配置错误 | 两个实例注册同一个 Provider ID，后启动的整体失败 | 角色文件由部署脚本生成；部署脚本检查两个目录角色不同 |
| 额度来源 ID 重复 | 整个实例停止，并撤下本实例注册的 Provider | 切换顺序固定为先停旧插件。启动时同步读取 `config.json`，对应旧插件仍启用时不注册该来源并报错 |
| 一个模块抛错拖垮插件 | 同上 | 每个模块初始化独立捕获错误；`contribute` 内同步部分保持最少 |
| 会话事件通知当前不工作 | 迁移前升级通知就没有在发 | 根因已查明；第 0 步先修旧插件并影子运行 |
| 改写 `config.json` 的模块 | Claude 显示名称每分钟写配置并 reload | 保持只在名称变化时写；写前备份由现有逻辑负责；加开关 |
| 未公开接口 | 清除待查看用的是未公开接口，Paseo 升级可能失效 | 集中到 `core/daemon` 一处，升级时只核对一处 |
| Paseo 版本 | 旧插件要求从 0.11 起，整合后要求 `>=0.15.0 <0.16.0` | 两台已是 0.15.0；升级 Paseo 前先在一台验证 |
| MacBook 部署旧版本 | MacBook 是 `db43b07`，比主干旧 | 第 1 步统一为同一标签 |

回滚：

- **单个模块**：`machine.json` 关闭该模块，`paseo plugin enable <旧插件>`，重载两个插件。旧状态目录未动，可直接用（第 4 步之后旧插件的待办任务可能过期）。
- **整体**：关闭所有新模块，启用全部旧插件；必要时把开发自动化安装回上一个部署标签。
- **Provider 实例**：`paseo plugin disable dev-automation-providers`，主实例打开云端会话模块并重载，启用旧 Antigravity 插件。
- 回滚不需要重启 Paseo 守护进程。

## 8. 两个实例

| 项目 | 主实例 | Provider 实例 |
|---|---|---|
| 安装 ID | `github-subscriptions` | `dev-automation-providers` |
| 显示名称 | 开发自动化 | 开发自动化 · Provider |
| 部署目录 | `~/.paseo/local-plugins/github-subscriptions` | `~/.paseo/local-plugins/dev-automation-providers` |
| 角色文件 | `shared/instance.generated.ts`：`role: "main"` | `role: "providers"` |
| 服务端注册 | 除 Provider 外的全部模块 | 只注册 Provider 模块和一个 `instance.status` RPC |
| 客户端注册 | 页面、侧栏、⌘K、胶囊、时间线 | 不注册任何界面 |
| 状态目录 | `~/.paseo/github-subscriptions/` | `~/.paseo/github-subscriptions/providers/`（只写自己的子目录） |
| 何时重载 | 每次更新代码 | 只在 Provider 模块代码或账号列表变化时 |

为什么要角色文件：插件代码拿不到自己的安装 ID（`plugin-process.js:238-246` 传给 `contribute` 的上下文没有 ID），同一目录装两次时两个实例的行为完全相同，会重复注册 Provider 和页面。

部署脚本：同一个 Git 标签生成两个目录，各写角色文件；检查两个角色不同；重载 Provider 实例前检查运行中轮次。

页面展示：Provider 与账号页的“Provider 实例”卡片显示运行状态和运行中会话数，详细状态、启停、重载、日志在 Paseo 设置 → 插件（feasibility 3c）。
