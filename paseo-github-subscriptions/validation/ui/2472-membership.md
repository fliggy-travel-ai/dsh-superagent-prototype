# Claude 会员到期设置页验收

现有 React Native Web 夹具挂载插件客户端入口和设置页，使用假守护进程和测试账号。

| 检查 | 结果 |
| --- | --- |
| 设置页展示本机和独立用户账号的名称与邮箱 | 通过 |
| 续费日填 32 时显示校验提示 | 通过 |
| 独立用户账号保存 31 日 20:15 后显示「已保存」 | 通过 |
| 清除独立用户账号后显示「已清除」，本机账号仍为 9 日 20:15 | 通过 |
| 窄屏深色布局展示两个账号及各自的操作 | 通过 |

- [宽屏浅色，保存独立用户账号后](2472-membership-wide.png)
- [窄屏深色，独立用户账号尚未填写](2472-membership-compact.png)

按 [预览说明](README.md#复现) 启动夹具。宽屏入口使用 `?route=settings:claude-membership`。窄屏深色入口再加 `&layout=compact&theme=dark`。

Mac mini 和 MacBook 的原生 Paseo 设置页及真实额度卡片等待部署后验收。
