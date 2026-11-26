# dsh-superagent-prototype

这个仓库现在只保留正在使用的 Paseo 插件。

- [paseo-github-subscriptions](paseo-github-subscriptions/)：安装到 Paseo 的插件，侧边栏名称是「开发自动化」。说明见该目录的 [OVERVIEW.md](paseo-github-subscriptions/OVERVIEW.md)。
- [paseo-cloud-session](paseo-cloud-session/)：云端会话里运行的转发程序，对应插件里的云端会话 Provider。
- [plans](plans/)：插件方案记录。

原来的 dsh-superagent（GitHub / 飞书工单、面板、提示词和配套测试）已经从仓库移除。GitHub 订阅仍用到的三份纯函数留在 `src/infra/text.ts`、`src/sources/github-read.ts`、`src/sources/github-trigger.ts`，由插件复制到 `paseo-github-subscriptions/server/vendor/dsh-superagent/`。

在插件目录检查：

```sh
cd paseo-github-subscriptions
npm ci
npm test
```
