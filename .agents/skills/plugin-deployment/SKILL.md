---
name: plugin-deployment
description: 部署、读回或回滚 Mac mini 与 MacBook 上运行的「开发自动化」插件，或排查运行中的插件（加载失败、模块出错、事件没送达、额度或待办显示不对）时使用。
---

# 部署与排查开发自动化插件

两台主机各运行一个插件实例，安装 ID `github-subscriptions`，安装目录是该主机 Paseo 用户的 `~/.paseo/local-plugins/github-subscriptions`，状态目录是 `~/.paseo/github-subscriptions`。每台主机只能由运行该主机 Paseo 守护进程的 macOS 用户部署：Mac mini 在它的 Paseo 终端或会话中操作；MacBook 在 MacBook 上的 Paseo 会话中操作。从另一台主机只能用 `paseo ... --host` 读回，不能替换文件。

## 部署

每台主机依次完成以下步骤，再换下一台。

1. **确认提交**：在该主机本仓库的检出中运行 `git fetch origin`，再运行 `git merge-base --is-ancestor <提交> origin/main`。退出码不为 0 时停止：只部署 `main` 上的提交。
2. **读现有角色**：读安装目录的 `.deployment.json`，取 `role` 和 `commit`。`role` 为 `null` 时用 `compat`。没有该文件时，读安装目录的 `shared/instance.ts`。记下旧提交，回滚要用。
3. **试运行**：在仓库的 `paseo-github-subscriptions/` 中运行 `node --experimental-strip-types scripts/deploy.ts --role <角色> --ref <提交> --dry-run`。核对输出的目录、提交和要检查的 Provider。脚本报角色不一致时停止，请用户确认后才加 `--change-role`。
4. **部署并重载**：去掉 `--dry-run`，加 `--reload`。退出码 2 表示有会话正在运行插件托管的 Provider，重载会让这一轮失败：等这些会话空闲后重试，不绕过。脚本把旧目录保留为 `<安装目录>.prev-<时间>`。
5. **读回**：逐项满足才算完成。
   - 脚本输出插件状态为 `running`；主实例或兼容实例还输出“定时任务工作区模块已运行”。
   - 安装目录 `.deployment.json` 的 `commit` 等于本次提交。
   - `paseo plugin logs github-subscriptions` 中本次重载之后没有模块注册失败或未捕获错误。
   - 本次改动涉及的模块：用安装目录中的 `node --import ./tests/resolve-js-to-ts.mjs --experimental-strip-types scripts/rpc.ts <方法> '{}'` 读该模块的只读快照，核对新行为可见。可用方法见 `scripts/rpc-lib.ts` 的允许列表。
6. **改机器配置**：本次改动需要改 `machine.json` 时，先备份，再按 `config/machine.example.json` 修改，重载后读回该模块的快照。两台主机的 `machine.json` 各自维护，不整份复制。

两台主机都完成后，把提交、主机、角色和读回结果写进 DSH 需求 Issue。

## 回滚

1. 用部署步骤 2 记下的旧提交，按部署步骤 3 到 5 重新部署。从提交部署可以留下完整记录，优先于手动换回 `.prev-` 目录。
2. 新版本写入过旧版本不认识的状态字段时，先读 `README.md` 和 `docs/` 中关于该字段的回滚说明，按说明处理后再回滚。
3. 把回滚原因和读回结果写进需求 Issue。

## 排查

按现象从上往下查，每一步记下读到的原文，不凭推测下结论。

1. **加载状态**：`paseo plugin ls --json`。状态不是 `running` 时读 `paseo plugin logs github-subscriptions`。整个插件加载失败常见于 Provider ID、额度来源 ID 或 RPC 名与 Paseo 内置插件重名，按 [插件开发技能](../plugin-development/SKILL.md#paseo-升级) 处理。
2. **单个模块**：插件运行但功能缺失时，用第 5 步的 RPC 脚本调用 `modules.status`，读该模块的状态（运行、关闭、出错）和原因。状态为关闭时读 `machine.json` 的 `modules`；状态为出错时原因字段给出不合法的区块或注册错误。
3. **状态与快照**：用第 5 步的 RPC 脚本读模块快照，再读状态目录中的对应文件（文件名见 `README.md`「设置、凭据与状态」和 `docs/`）。输出时不打印令牌、邮箱和主机地址。
4. **跨主机功能**（语音、在场判定、停滞会话）：两台主机都要读回，并核对两边部署的提交相同。

确认是代码缺陷时，按 [插件开发技能](../plugin-development/SKILL.md) 修复，再从新提交部署。不直接修改安装目录中的文件。

## 其他开发者的机器

DSH 仓库 `dev-env-setup` 技能的 `assets/dev-automation-plugin/deploy.sh` 用于新开发者的机器，以兼容角色安装本插件。修改插件目录名、安装 ID、角色文件或 `.deployment.json` 的字段时，同时更新该脚本。
