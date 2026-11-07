# 隔离守护进程联调

`latest-result.json` 记录本次检查，十七项全部通过，`passed` 为 `true`，`knownDefects` 为空。`plugin-logs.json` 为相关日志证据。

在插件根目录执行：

```sh
npm run test:daemon
```

macOS CLI 不在 PATH 时可为本条命令加入应用内置 CLI 路径：

```sh
PATH="/Applications/Paseo.app/Contents/Resources/bin:$PATH" npm run test:daemon
```

脚本建立临时 PASEO_HOME，选择独立端口，并清理环境变量。插件与固定事件提供方只安装到临时守护进程。网络替身把 `api.github.com` 转到本机夹具服务，其他主机一律拒绝。测试结束后只停止自建守护进程，并删除临时目录。

检查覆盖同步注册 RPC、四个工具注入、订阅工具描述中的 gh 评论标记规则、会话订阅边界、范围校验、影子不发送、实发只送订阅者、消息幂等与冲突、reload 去重、待答状态仍 steer、重启恢复、关闭会话自动重开、归档清理与凭据脱敏。没有调用真实模型，没有请求真实 GitHub，没有发布评论。

重启检查针对曾发现的启动竞态：`paseo.pid` 的监听地址会短暂为 null。插件现在等待本机连接就绪，失败后允许下次操作重试，卸载可中止等待。

固定事件提供方补充了会话持久化接口，以支持 reload 后重新打开会话；夹具不回放历史。因此重启验收确认新消息成功送达，不宣称恢复了夹具历史。真实 Claude/Codex 忙时行为的早期探针证据在仓库 `plans/m0-evidence/`。
