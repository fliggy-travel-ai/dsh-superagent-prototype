---
name: plugin-development
description: 修改「开发自动化」Paseo 插件时使用：改已有功能或缺陷、新增模块、RPC、机器配置区块或界面，以及 Paseo 升级后同步复制文件和插件接口版本。
---

# 修改开发自动化插件

先读仓库根目录的 `AGENTS.md`，其中的插件约束是本技能每一步的评审标准。以下命令都在 `paseo-github-subscriptions/` 中运行。

## 1. 定位

用下表从功能找到模块目录，再读四处：模块的 `index.ts`、`shared/` 中的契约文件、`tests/` 中同名或同前缀的测试、文档中描述该功能的段落。完成标准：能说出改动涉及的模块 ID、RPC 方法、状态文件和 `machine.json` 区块。

| 功能 | 模块 ID | 目录（`server/modules/`） | 文档 |
|---|---|---|---|
| GitHub 订阅与事件送达 | `github` | `github/`，另有 `server/github/`、`server/delivery.ts` | README「事件与送达」 |
| 问答模式、在场判定、语音 | `answer.presence` | `answer-presence/`，另有 `server/presence.ts`、`server/speech.ts` | OVERVIEW「在线与离线问答」 |
| 浏览器扩展、网页提问与额度 | `answer.browser` | `answer-browser/`，另有 `server/browser-*.ts`、`browser-extension/` | `browser-extension/README.md` |
| 升级通知 | `answer.escalation` | `answer-escalation/` | `docs/answer-usage-modules.md` |
| 子会话免提醒与事件转发 | `answer.quietChildren` | `answer-quiet-children/` | `docs/answer-usage-modules.md` |
| 人工待办 | `todo` | `todo/`，另有 `server/todo.ts` | OVERVIEW「人工待办与停滞会话」 |
| 停滞主会话 | `todo.stalled` | `todo-stalled/`，另有 `server/stalled.ts` | 同上 |
| Claude 账号额度与自动继续 | `usage.claudeAccounts` | `usage-claude-accounts/` | `docs/answer-usage-modules.md` |
| 其他 Provider 额度 | `usage.providerQuotas` | `usage-provider-quotas/` | OVERVIEW「其他 Provider 额度来源」 |
| 新建会话额度检查 | `providers.quotaGate` | `providers-quota-gate/` | README「兼容与安装」 |
| 工具权限自动批准 | `providers.toolPermissions` | `providers-tool-permissions/` | README「兼容与安装」 |
| 新建会话默认设置 | `providers.defaults` | `providers-defaults/` | `config/machine.example.json` |
| 云端会话 Provider | `providers.cloudSession`、`providers.cloudGateway` | `providers-cloud-session/`、`providers-cloud-gateway/`，另有 `server/cloud-session/` | README「云端会话 Provider」，`../paseo-cloud-session/` |
| Antigravity 多账号 | `providers.antigravity` | `providers-antigravity/` | OVERVIEW「Antigravity 多账号 Provider」 |
| 主会话收尾 | `dispatch.finalize` | `dispatch-finalize/` | OVERVIEW「主会话收尾与容量」 |
| 容量与换号迁移 | `capacity.mainSessions` | `capacity/` | 同上 |
| 心跳 | `heartbeats` | `heartbeats/`，另有 `client/heartbeats/` | OVERVIEW「代理定时心跳」 |
| 定时任务工作区 | `schedules.workspaces` | `schedule-workspaces/` | `scripts/check-schedule-workspaces.ts` |

主会话与子会话的判定在 `server/core/session-roles.ts`，停滞会话、免提醒、升级通知和事件转发共用它。改判定规则会同时改变这四个功能。

## 2. 决定改动位置

- **已有模块**：在模块目录内改。跨模块共用的逻辑放 `server/` 或 `server/core/`；服务端和客户端都要用的类型和纯函数放 `shared/`。
- **新模块**：建 `server/modules/<名称>/index.ts`，导出 `Module`（`id`、`label`、`defaultEnabled`、`appliesTo`、可选 `config`、`register`），加到 `server/modules/index.ts` 的 `MODULES`。`register` 返回清理函数。
- **新 RPC**：输入和输出用 zod 定义在 `shared/<功能>.ts`，客户端和服务端从同一文件导入。只有只读快照或已获用户同意的写操作才加入 `scripts/rpc-lib.ts` 的允许列表。
- **新机器配置区块**：在模块定义的 `config: { section, spec: { schema, fallback } }` 中声明，同时写进 `config/machine.example.json`。`tests/machine-example.test.ts` 检查样例能通过校验。
- **改界面**：组件放 `client/`，通过 `client/store.ts` 的共用 store 读快照。只用 React Native 原语。

改动涉及「替用户做决定的规则」或仓库外消费方用到的接口时，先停下来，在需求 Issue 中写明改动和影响，等用户决定后再继续。

## 3. 测试

- 每个行为改动在 `tests/` 中加或改测试。依赖守护进程或文件系统的逻辑通过端口参数注入假实现，参考 `dispatch-finalize/finalize.ts` 的 `FinalizePort`。
- 改送达、RPC、重载或模块开关后的加载行为时，运行 `npm run test:daemon`。
- 改界面时，按 `validation/ui/README.md` 跑组件预览并录制 GIF，把 GIF 交给主会话核对界面。预览是假宿主，不能代替在真实 Paseo 中的验收。

## 4. 文档

按 `AGENTS.md` 的文档规则，在同一 PR 中更新 `OVERVIEW.md`、`README.md` 或 `docs/` 的对应段落。删除被改动取代的旧描述。

## 5. 检查

完成标准，逐项满足：

- `npm run check` 通过。
- 改了入口、导入关系、模块注册或 Paseo 版本：`npm run check:paseo` 通过（需要本机安装 Paseo.app）。
- 改了复制的外部源码或升级了 Paseo：`npm run vendor:check` 通过。
- `git diff` 中没有 `shared/instance.ts` 的角色改动，没有 `validation/**/out/`、`node_modules/` 等生成文件。

之后按 `AGENTS.md` 的交付步骤提 PR、合并并部署。

## Paseo 升级

Paseo 应用升级后，插件可能因为接口变化或内置插件重名而整体加载失败（0.17 内置 `antigravity` 额度来源与本插件同名，导致整个插件停止）。

1. 读新版本内置插件的列表，核对本插件注册的 Provider ID、额度来源 ID 和 RPC 名没有与内置插件重名。
2. 把 `package.json` 中三个 `@getpaseo/*` 包改成新版本的同一精确版本，运行 `npm install` 更新锁文件。只有用到新接口时才提高 `paseo-plugin.json` 的 `requirements.paseo`。
3. 运行 `npm run vendor:check`。`server/vendor/paseo-*` 有差异时，从新版本重新复制并更新 `scripts/paseo-vendor.ts` 中的版本。`providers-antigravity/acp/` 以新版本内置 `antigravity-provider` 的源文件为准重新复制，只保留 OVERVIEW 中登记的差别。
4. 运行第 5 节的全部检查，`check:paseo` 必须用新版本的 Paseo.app。
5. 在 README「兼容与安装」中更新实测过的版本。
