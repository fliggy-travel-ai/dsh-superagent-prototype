# 云端会话接入

本目录是 Claude Code 云端会话接入 Paseo 的云端部分。`cloud/` 是正式云端程序、单文件构建、测试和启动脚本片段；`fixtures/` 是经合成处理的记录样例；`prototype/` 是核实可行性的原型，仅作参考。Mac 侧由 `paseo-github-subscriptions/` 提供，云端只依赖其中的 `shared/cloud-session.ts` RPC 契约。

构建、配置、运行方式和已知限制见 [cloud/README.md](cloud/README.md)。真实插件安装、发布和验收由主会话另行安排。
