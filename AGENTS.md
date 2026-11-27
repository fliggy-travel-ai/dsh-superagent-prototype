# AGENTS.md

dsh-superagent-prototype 是 Paseo「开发自动化」插件的源码仓库，属于 DeepSeek Harness 项目簇的工程工具（[项目簇架构图](https://github.com/fliggy-travel-ai/deepseek-harness/blob/master/docs/project-cluster.zh.md)）。插件服务开发流程中的 Paseo 会话：GitHub 事件送达、问答与代答、Provider 额度与新建会话检查、主会话收尾与容量、心跳和云端会话接入。它不在商家产品的请求链路上。

## 仓库布局

```
paseo-github-subscriptions/   插件，插件 ID github-subscriptions，侧栏名「开发自动化」
  index.server.ts             服务端入口，只做组装
  index.client.tsx            客户端入口
  server/core/                模块框架、共享守护进程连接、机器配置、会话角色
  server/modules/<模块>/      功能模块，一个目录一个模块，登记在 server/modules/index.ts 的 MODULES
  server/vendor/              从外部复制的源码，按来源重新复制，不手改
  shared/                     服务端和客户端共用的 RPC 契约（zod）与纯函数
  client/                     React Native 界面
  browser-extension/          配套浏览器扩展
  scripts/                    部署、RPC、检查脚本
  tests/                      node:test 单元测试、守护进程联调、界面夹具
  validation/                 提交的验收汇总；out/ 等生成目录不提交
  docs/                       单个模块的规则、迁移和限制
  OVERVIEW.md                 用户操作说明
  README.md                   开发与运维说明：安装、送达、状态文件、模块框架、两个实例
paseo-cloud-session/          云端会话转发程序；cloud/ 是正式版，prototype/ 只作参考
plans/                        方案和确认记录，文件名以 DSH 需求单号开头
src/                          scripts/vendor-sync.ts 的三份源文件
paseo.json                    Paseo 工作区脚本：远程切换问答模式
```

## 命令

在 `paseo-github-subscriptions/` 中运行：

```sh
npm ci --ignore-scripts
npm run check            # 类型检查、打包边界、单元测试、密钥扫描；CI 运行同一命令
node --import ./tests/resolve-js-to-ts.mjs --experimental-strip-types --test tests/<名称>.test.ts   # 单个测试文件
npm run check:paseo      # 用本机 Paseo.app 的插件编译器真实构建并加载
npm run test:daemon      # 临时 PASEO_HOME 中的隔离守护进程联调
npm run vendor:check     # Paseo 升级后比较复制的内置插件文件
```

云端转发程序在 `paseo-cloud-session/cloud/` 中运行 `npm ci && npm run typecheck && npm test`。

## 需求与复盘

- 需求和缺陷记在 DSH 仓库的 Issue。本仓库的 PR、提交和 `plans/` 文件用 `fliggy-travel-ai/deepseek-harness#<号>` 引用同一单号。
- DSH 复盘或总协调巡检决定改插件时，直接在本仓库修改、合并并部署。DSH 仓库不保存插件源码副本。
- 本仓库的接口有仓库外的消费方：总协调会话技能 super-agent 调用 `scripts/rpc.ts` 的方法并依赖会话标签 `role=main`、`need`、`dsh.lb`；DSH `dev-env-setup` 技能的 `deploy.sh` 安装本插件；DSH 各主会话按 `github_subscribe` 的工具描述订阅和发评论。改这些接口时，在同一需求中更新消费方，或在需求 Issue 中写明消费方要做的改动。

## 插件约束

以下约束由检查脚本或运行事故得出。违反时检查不一定报错，评审时逐条核对。

- **Paseo 上游**：只用公开插件接口 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol`，不修改 Paseo 本体。三个包固定为同一精确版本；`paseo-plugin.json` 的 `requirements.paseo` 写最低可用版本。Paseo 升级按 [插件开发技能](.agents/skills/plugin-development/SKILL.md#paseo-升级) 处理。
- **打包边界**：源码只放在 `client/`、`server/`、`shared/` 和两个入口文件。`shared/` 不依赖 Node 内置模块、`server/`、`client/` 和只给单侧用的 SDK。Paseo 用 `eval` 执行服务端包，打包源码中没有 `import.meta`、`__dirname`、`__filename`。`npm run boundaries` 静态检查这些规则；`npm run check:paseo` 做真实加载。
- **模块**：新功能写成模块，不改 `server/core/plugin.ts` 的组装顺序来实现功能。模块用 `context.services.daemon.ready()` 取共享连接，不另开本机连接。`register` 返回的清理函数停止计时器、订阅和子进程，并等已开始的写盘和通知处理结束；停止后不再写状态目录。连接守护进程的等待不能拖住插件停止。一个模块失败只停这个模块。
- **机器配置**：主机之间不同的值放在 `machine.json` 的模块区块中，用 zod 校验并给出默认值，同时更新 `config/machine.example.json`。默认值等于改动前的行为。新模块默认关闭，用户决定默认启用时才设为 `defaultEnabled: true`。区块不合法时只停用依赖它的模块。
- **两个实例**：仓库中的 `shared/instance.ts` 保持 `null`，部署脚本写入实际角色。注册 Provider 的模块用 `instance.hostsProviders` 判断，注册界面和其他功能的模块用主实例判断。
- **状态文件**：放在 `$PASEO_HOME/github-subscriptions` 下，目录 0700、文件 0600，用原子替换写入。文件损坏时报错并保留原内容。读不到配置、置顶状态或状态文件时，报出原因并停止有副作用的动作，不按默认值继续。迁移旧插件状态只复制，不删除原文件。
- **替用户做决定的规则**：代答、自动批准权限和自动继续，对验收、登录与安全验证、资金操作，以及数据、文件、工作树、账号、环境的清理、释放、归档和丢弃改动，一律保留人工处理。浏览器扩展只点“Allow once”。结果未知时不自动重发，也不记为成功。放宽其中任何一条前先请用户决定。
- **隐私**：源码、测试、文档和提交的验收材料中不写邮箱、真实账号、主机地址、个人路径和令牌。测试数据所在行写 `scan-allow`。日志不记录令牌和命令内容。
- **客户端**：只用 React Native 原语，TypeScript 不引入 DOM 库。界面文案用中文。

## 文档

- 行为改动在同一 PR 中更新文档：用户看到的行为写进 `OVERVIEW.md`，开发与运维事实写进 `README.md`，单个模块的详细规则写进 `docs/`。
- 文档写当前行为，不写版本流水账。删除已失效的内容，不追加“本版改为”之类的段落。
- `plans/` 保存方案与确认记录，落地后不改写；结论变化时新增一份记录并在旧记录开头注明被哪份取代。
- 文档和代码注释用中文，按 ASD-STE100 简明风格书写。

## 交付

1. 从最新 `main` 建分支，一个需求一个 PR。PR 标题和描述用中文，描述写摘要、跑过的测试命令和结果、部署影响（哪台主机、是否要重载、`machine.json` 是否要改）。
2. CI 的 `check` 通过后合并。改入口、导入关系、模块注册或 Paseo 版本时，合并前在 Mac 上另跑 `npm run check:paseo`。改送达、RPC 或重载行为时另跑 `npm run test:daemon`。
3. 合并后按 [插件部署技能](.agents/skills/plugin-deployment/SKILL.md) 把 `main` 上的合并提交部署到 Mac mini 和 MacBook，读回运行状态，把部署结果写回 DSH 需求 Issue。
4. 安装目录只接收部署脚本从提交导出的文件。紧急修复也先提交，再从该提交部署。

## 技能

- [plugin-development](.agents/skills/plugin-development/SKILL.md)：修改插件代码、新增模块或 RPC、改界面、Paseo 升级时使用。
- [plugin-deployment](.agents/skills/plugin-deployment/SKILL.md)：部署、读回、回滚，以及排查运行中的插件时使用。
- 通用工作流技能（ODD 交付、复盘、代码评审、TDD 等）在 [deepseek-harness/.agents/skills](https://github.com/fliggy-travel-ai/deepseek-harness/tree/master/.agents/skills)。
