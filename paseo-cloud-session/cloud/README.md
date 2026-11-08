# 云端会话程序

在 Linux、Node 22 容器中运行。启动脚本 `setup-snippet.sh` 的地址和 SHA-256 必须在发布后填入；下载校验通过后安装单文件，并合并 Claude 的用户级 SessionStart 钩子和 `paseo` MCP 条目。启动脚本应在 Claude 启动前运行。配对链接由个人环境变量 `PASEO_MINI_HOST` 提供；云端会话编号由 `CLAUDE_CODE_REMOTE_SESSION_ID` 提供。不要把实际链接写进仓库。

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/paseo-cloud-session.mjs install-claude-config
```

在 `paseo-cloud-session/cloud/` 中运行 `npm ci` 和 `npm run build`，从源码生成 `dist/paseo-cloud-session.mjs`；产物不进入 Git，运行时不需要 `node_modules`。构建依赖锁定在 `package-lock.json`。使用 `@getpaseo/client` 0.15.0 的公开 Node 入口 `createHostClient` 解析和连接配对链接；该公开入口返回的 daemon 客户端提供 `invokePluginRpc`。RPC 的名称和响应结构直接使用同仓库共用接口的 schema 校验。无须依赖 CLI 的内部路径。

SessionStart 钩子注册 agent，将身份写入 Claude 环境文件并启动后台转发；转发从启动时记录文件末尾开始，仅在进程内保留断线期间的待发送数据。MCP 服务器本地应答 initialize，首次工具请求时初始化插件端 MCP，然后代理所有工具。`wait` 在收到消息后打印并确认，后台命令结束会唤醒 Claude。处理完后需重新启动 `wait`。经 Paseo 工具创建子会话时需传 `settings.modeId`。

插件重启会丢失未取走的消息，不做对账；云端离线时已有 Paseo 轮次保持运行中。待发送队列只保存在转发进程的内存中，容器或进程退出后不会恢复。若 RPC 已在 Mac 执行但响应丢失，云端无法判断这次推送是否被接收，重试可能重复轮次边界；相同工具调用和累积文本的去重行为由插件及 Paseo 决定。启动时 Mac 不可达时，后台会重试注册和转发；由于启动钩子已经结束，无法向该次启动的 Claude 环境补写 `PASEO_AGENT_ID`；该会话通过命令行创建的子会话不会挂在云端 agent 下。通过 Paseo MCP 工具创建的子会话不受影响。真实配对链路、面板显示和 Claude 唤醒需要在目标环境验收。
