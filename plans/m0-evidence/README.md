# M0 实测证据（2026-11-06，隔离守护进程）

仓库仅保留本说明中的结论与边界。下表列出的一次性探针、脚本和原始时间线保留在本地，不随功能提交。当前可维护的隔离联调脚本见 `paseo-github-subscriptions/tests/daemon-integration.ts`，复现说明见 `paseo-github-subscriptions/validation/daemon/README.md`。

环境：Paseo 0.15.0；临时 `PASEO_HOME=/tmp/m0/home`，监听 127.0.0.1:6790，干净环境变量启动（`scripts/cli.sh`）。未碰生产守护进程、生产配置和已有会话。测试会话都在隔离守护进程里，测完归档，隔离目录已删除。模型：Claude `claude-haiku-5-5`、Codex `gpt-6-luna`。

| 本地留存文件 | 内容 |
| --- | --- |
| `steer-busy-claude-steer.json`、`steer-busy-codex-steer.json` | 忙时 steer：回合编号不变，前台命令跑完，转向文字被采纳 |
| `steer-busy-claude-interrupt.json` | 对照：interrupt 取消前台命令，开新回合 |
| `steer-perm-claude.json`、`steer-perm-codex.json` | 有待处理权限请求时 steer：权限请求被拒绝并清除，转向文字送达 |
| `dedup-A.json`、`dedup-B.json` | messageId 去重；守护进程重启后向“已关闭未归档”会话发送 |
| `github-permissions.md` | 细粒度令牌对各接口的 HTTP 状态 |
| `probe-plugin/` | 探针插件源码（服务端工具、RPC、胶囊、侧边栏、页面） |
| `scripts/` | 全部测试脚本 |

## 工具注入与环境（探针插件实测，无单独 JSON）
- `agent.open.before` 返回 `tools` 后，Claude 会话里工具名是 `mcp__paseo__ghsub_probe_env`，Codex 会话里是 `paseo.ghsub_probe_env`，两者都调用成功。
- 前提：守护进程配置 `daemon.mcp.injectIntoAgents=true`。隔离守护进程默认没开，开之前两个提供方都看不到工具（实测）。Mac mini 生产配置已开；MacBook 未核实。
- 守护进程带 `GH_TOKEN` 启动：插件进程 `process.env.GH_TOKEN` 存在（长度 93，未记录内容）。不带则不存在。`gh auth token` 在无环境变量时报 `no oauth token found`，本机 `gh` 没有存储的登录，所以它不能当回退。
- 插件进程由 `fork` 启动且不传 `env`，继承守护进程环境（`plugins/runtime.js` `spawnPluginChild`）。会话环境 = `process.env` + 提供方覆盖项（`provider-launch-config.js` 的 `resolveShellEnv`，不读登录 shell）。
- 处理函数上下文里的 `paseo` 可以留存到模块变量，之后在处理函数外调用仍然有效（隔离守护进程里两次调用 `agents.list` 都成功）。
- 插件放在目录里不需要 `node_modules` 即可安装和加载（宿主提供 `@getpaseo/plugin`、`zod`、React 等）。宿主 `zod` 版本 4.4.3。
- 网页端界面截图：用户决定跳过，没有在 app.paseo.sh 或桌面端添加任何主机。
