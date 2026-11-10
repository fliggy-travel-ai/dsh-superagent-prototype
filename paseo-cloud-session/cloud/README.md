# 云端会话程序

在 Linux、Node 22 容器中运行。启动脚本 `setup-snippet.sh` 的地址和 SHA-256 必须在发布后填入；下载校验通过后安装单文件，并合并 Claude 的用户级 SessionStart 钩子和 `paseo` MCP 条目。启动脚本应在 Claude 启动前运行。配对链接由个人环境变量 `PASEO_MINI_HOST` 提供；云端会话编号由 `CLAUDE_CODE_REMOTE_SESSION_ID` 提供。不要把实际链接写进仓库。

`PASEO_CLOUD_SESSION_FALLBACK_CWD` 可由成员在个人云环境的环境变量中自行设置为 Mac 上的目录，作用于该成员的所有云端会话。插件先按云端会话工作目录的最后一段查找 Mac 上的同名项目；找不到时使用此目录，不设置时使用 Mac 主目录。该变量由成员自己修改。

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/paseo-cloud-session.mjs install-claude-config
```

在 `paseo-cloud-session/cloud/` 中运行 `npm ci` 和 `npm run build`，从源码生成 `dist/paseo-cloud-session.mjs`；产物不进入 Git，运行时不需要 `node_modules`。构建依赖锁定在 `package-lock.json`。使用 `@getpaseo/client` 0.15.0 的公开 Node 入口 `createHostClient` 解析和连接配对链接；该公开入口返回的 daemon 客户端提供 `invokePluginRpc`。RPC 的名称和响应结构直接使用同仓库共用接口的 schema 校验。无须依赖 CLI 的内部路径。

SessionStart 钩子注册 agent，将 agent、server 和工作区编号写入 Claude 环境文件并启动后台转发；定下需求 Issue 后及每次阶段变化时，云端会话应通过 `rename_workspace` 将工作区改名为 `<Issue 号>【<状态>】<需求名>`。PermissionRequest 钩子不作权限决定，分离的后台进程将请求通知插件；记录中出现对应工具结果后，转发程序关闭 Paseo 请求。转发从启动时记录文件末尾开始，仅在进程内保留断线期间的待发送数据。MCP 服务器本地应答 initialize，首次工具请求时初始化插件端 MCP，然后代理所有工具。`wait` 在收到消息后打印并确认，后台命令结束会唤醒 Claude。处理完后需重新启动 `wait`。经 Paseo 工具创建子会话时需传 `settings.modeId`。

插件重启会丢失未取走的消息，不做对账；重试收件确认期间插件重启可能使序号错位，删除新到消息；云端离线时已有 Paseo 轮次保持运行中。待发送队列只保存在转发进程的内存中，容器或进程退出后不会恢复。若 RPC 已在 Mac 执行但响应丢失，云端无法判断这次推送是否被接收，重试可能重复轮次边界；相同工具调用和累积文本的去重行为由插件及 Paseo 决定。启动时 Mac 不可达时，后台会重试注册和转发；由于启动钩子已经结束，无法向该次启动的 Claude 环境补写 `PASEO_AGENT_ID`；该会话通过命令行创建的子会话不会挂在云端 agent 下。通过 Paseo MCP 工具创建的子会话不受影响。真实配对链路、面板显示和 Claude 唤醒需要在目标环境验收。

`mcp` 与 `wait` 不检查 `PASEO_AGENT_ID`：启动钩子写入该变量后，Bash 中运行的 `wait` 仍需工作。每个会话在 `/tmp/paseo-cloud-session-<hash>/` 下保存 `epoch` 和 `forward.pid`；后者记录转发进程、记录文件路径、标题是否已尝试及最后的标题失败原因，不保存时间线偏移；为保留已尝试状态，进程退出后可能留下 PID 为 0 的记录。`/clear` 更换记录文件时，新转发进程接管。

MCP 请求按顺序处理，长时间工具调用会挡住其他请求。启动时工具列表获取失败后，恢复连接会发送 `notifications/tools/list_changed`；Claude Code 是否响应此通知尚需真机验收，若不响应，本会话的工具列表可能仍为空。收件提示原样打印，多个 `<paseo-system>` 段由 Claude 自己阅读。

已知限制：由 `isMeta` 用户消息开启的轮次（例如其他会话发来的消息）不会在面板上开始一轮。

PermissionRequest 的 tool use id 优先从钩子输入取；缺失时在记录中找“同名、还没有结果”的 `tool_use`：输入相同的取最后一条；钩子输入可能带记录里没有的默认值（如 `multiSelect`、`replace_all`），对不上时若同名且无结果的只有一条就用它（先等 1 秒给新调用写入）；最多等 3 秒，仍不能唯一确定就不通知。通知前在会话临时目录 `requests/` 下以 id 的哈希作标记（内容是 id），工具结果在转发进程内缓存至对应标记出现并完成关闭；转发进程重启后从记录开头回放已有的工具结果。无法取得 id 或 Mac 不可达时不会阻塞 claude.ai，但相应 Paseo 请求可能不会显示。MCP 本地初始化时若尚未拿到工作区编号，说明会提示使用 `PASEO_WORKSPACE_ID`。

请求关闭的对账（#1737）：forward 每 10 秒在 `forward.pid` 写心跳；每次权限通知都会检查 forward，进程已退出或心跳超过 2 分钟时结束旧进程并重新拉起。插件侧另有兜底：时间线里工具调用已结束即关闭请求，同会话有更新请求且已过 10 分钟或已等 2 小时的请求会从 Paseo 撤下。
