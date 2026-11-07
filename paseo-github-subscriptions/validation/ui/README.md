# 客户端组件界面验收

预览直接挂载本插件的客户端入口与组件，使用 React Native Web、假 Paseo SDK、假 RPC 和主题夹具。此次检查八十四项全部通过，汇总见 `../summary.json`。覆盖宽窄布局、深浅主题、订阅与事件页面、错误和空状态、令牌、设置保存、两个会话胶囊、定时刷新及卸载清理。详细报告、截图和 GIF 由脚本写入本地 `out/`，不提交生成产物。

主会话复查了宽屏按会话分组、窄屏深色页面与面板、取消订阅清零流程，并在浏览器复查取消操作。截图见 `out/main-review-compact-dark.png` 和 `out/main-review-settings.png`。完整交互关键帧见 `out/frames/`，GIF 见 `out/gifs/`。

## 复现

先在插件根目录执行 `npm ci --ignore-scripts`，再进入本目录：

```sh
npm ci --ignore-scripts
npm run build
npm run serve
```

服务只监听 `127.0.0.1:4173`。另开终端，在本目录运行：

```sh
ego-browser nodejs < acceptance.js
python3 make_gifs.py
```

GIF 生成需要 Python Pillow 和 macOS 的黑体字体。验收脚本以当前目录为根目录，必须从本目录执行。验收脚本复用名为 `ghsub-ui-fixture-preview` 的专用 TaskSpace；已结束的用户空间不应自动接管。脚本会重建 `out/` 并覆盖旧证据，因此需要保留旧报告时先另存。

手动入口可带查询参数，例如 `?scene=shadow&layout=compact&theme=dark&route=screen:main`。设置页用 `route=screen:settings`，主会话用 `route=agent:agent-main`。所有订阅和令牌操作都针对夹具。

## 证据与范围

| 目录 | 内容 |
| --- | --- |
| `out/results.json` | 每个检查的名称、通过状态和说明 |
| `out/shots/` | 布局、主题、页面与错误场景 |
| `out/frames/` | 各交互步骤的关键帧 |
| `out/gifs/` | 胶囊取消、页面跳转、双会话、紧凑面板、令牌和设置流程 |

主题值由夹具提供，接近宿主主题。假宿主按 workspace/agent/id 区分胶囊，双会话检查只能证明插件与夹具交互正确。尚未在生产原生 Paseo、真实手机面板或真实双机中验收胶囊顺序、宿主目标隔离和系统布局。

本次没有连接生产守护进程，没有注册额外生产 host，没有操作用户的生产浏览器空间。

## 全局页面修复回归（2026-11-06）

全局页面不提供工作区状态上下文。订阅行改为显示订阅快照中的会话标题，不再调用 `useAgent`。预览的 `useAgent`、`useWorkspace` 改为抛出宿主相同错误，防止假宿主掩盖上下文缺失。

类型检查与预览构建通过。专项浏览器回归四项通过：胶囊进入全局页面、按会话分组、另一会话只显示自己的两个订阅、弹出层仅有一份。证据是 `out/hook-fix-results.json`、`out/hook-fix-session-grouping.png`、`out/hook-fix-second-session.png`。这些证据使用夹具，不覆盖之前的八十四项报告。

Mac Mini 已通过 `plugin reload` 热更新；原生 Paseo 中从胶囊进入全局页已成功显示真实订阅。用户报告的左上角重复弹层，在热更新前后均未复现，原因尚未确认。双会话夹具检查不能代替原生多标签页验证，因此重复弹层仍保留跟踪。
