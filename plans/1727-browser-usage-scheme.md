# 技术方案：Paseo 面板显示浏览器环境的 claude.ai 剩余额度（deepseek-harness#1727）

- 代码基线：`fliggy-travel-ai/dsh-superagent-prototype` 的 `021ed85`，目录 `paseo-github-subscriptions/`，分支 `1727-browser-usage`。
- 插件接口：`@getpaseo/plugin` 0.15.0。
- 执行人：本文件给没有上下文的实现会话使用。不改 Paseo 和 DSH 上游包。只改本插件和浏览器扩展。
- 合并顺序：`1704-answer-web-request` 先合并，本分支后合并。文中的行号按 `021ed85`，合并后按内容查找。

## 1. 用户决定

1. 只读用量页面上显示的内容，**不构造请求**，不读会话页面下方的圆环（#1727 评论 6720771386：“那就统一打开一个用量页”）。
2. 每个浏览器环境保持一个用量页面标签页：没有就在后台打开（`/settings/usage`，会跳转到 `/new#settings/usage`）；已有就复用；打开后保留，不反复打开和关闭。扩展记住自己维护的这个标签页编号。
3. 每 10 分钟读取一次 5 小时和每周两个窗口；读取前只刷新扩展维护的这个用量页面标签页。
4. 用户把这个标签页切走、改地址或关闭时，不强行改回，下一轮再按规则处理（地址不再是用量页面时，视为不再由扩展维护，另开一个）。
5. 读不到时不清空数字。额度区域写明“未打开浏览器，无法检测剩余额度，只展示上一次同步的额度”，并显示这份额度的同步时间。
6. 额度面板里每个浏览器环境的条目显示它登录的 claude.ai 账号邮箱（`环境名称 · 邮箱`，没有邮箱时只显示环境名称，“未打开浏览器”时显示上一次读到的邮箱；#1727 评论 6721183577）。
7. 不加用户设置。环境长时间未连接时保留 3 天。

硬性限制：扩展不点击任何页面，不刷新业务会话页面或其他非维护页面，不切换账号，不改设置。

## 2. 真实页面取证

取证时间 2026-11-08 10:50–11:08 UTC，Mac Mini，SunBrowser 环境 29（扩展 `hoickgpfemgkohbnflileklfjonjdicb`），页面语言 `en-US`，页面时区 `America/New_York`（`getTimezoneOffset()` 为 300，和 Mac 时区不同）。

脱敏样本：`paseo-github-subscriptions/tests/fixtures/claude-usage/session-usage-ring.html`、`usage-dialog.html`。样本里没有邮箱、显示名称、会话内容。

### 2.1 会话页面（`https://claude.ai/code/session_*`）

- 输入框下方一行有圆环按钮，按钮的 `aria-label` 是额度文字，不需要悬停或点击：
  `Usage: 59% of 5-hour limit, Resets at 6:50 AM`
- 选择器：`button[aria-label^="Usage:"]`。
- **只有 5 小时窗口。** 每周窗口在点击圆环后的弹出层里。扩展不能点击，所以会话页面读不到每周窗口。
- 页面上另有“Context 75%”和“75% used”，它们是上下文占用，不是额度。选择器不能匹配这些文字。
- 文字里的时间是页面时区的本地时间。
- 闲置会话页面的额度数字可能过时：11 分钟被动监听里，这个页面没有发出任何额度相关的 `/api` 请求。同期圆环文字没有变化，用量页面也还是 59%，所以这次没有观察到偏差，但也不能证明圆环会自动更新。监听只覆盖 HTTP 请求，不包括 WebSocket 推送。
- **按用户最新决定（#1727 评论 6720771386），扩展不再读取会话页面下方的圆环，统一读取第 2.2 节的用量页面。** `session-usage-ring.html` 保留在测试夹具中，用于验证扩展不会向业务会话页面注入读取或把圆环当作数据源。

### 2.2 用量页面

- 打开 `https://claude.ai/settings/usage`，页面跳转到 `/new#settings/usage`，并显示“Settings”弹窗。`location.pathname` 是 `/new`。
- `document.title` 是 `New session - Claude`，不能用标题判断。
- 后台标签页（`document.hidden` 为真）能正常显示数据。首次打开 13 秒出现数据，之后 2 秒。
- 根节点：`[data-testid="usage-page-pace"]`。窗口元素：其中的 `[role="meter"]`。
- 窗口元素的结构：

| 显示文字 | `aria-labelledby` 指向的文字 | `aria-valuenow` | `aria-valuetext` | 同一行的重置文字 |
|---|---|---|---|---|
| 5 小时窗口 | `Current session` | `59` | `59% used` | `Resets at 6:50 AM` |
| 每周窗口 | `This week` | `46` | `46% used` | `Resets Friday 7:00 PM` |

- 同一根节点下还有按产品分类的窗口（`Claude Code`、`Chats`、`Cowork`、`Other`），它们的 `aria-valuetext` 没有 `used`。只取上表两行，按标签文字匹配。
- 页面有 `Refresh` 按钮和 `Last updated: just now`，不要点击。

### 2.3 Paseo 面板的限制

- `UsageReport` 只有 `available` 状态能带窗口数值和 `details`。`unavailable`、`error` 不带数值。
- 非 `available` 时，面板显示错误文字，并显示守护进程内存里的上次成功结果（`lastSuccessful`）和“上次更新于”。这份结果在守护进程重启或插件重新加载后丢失，时间是 Paseo 上次拉取的时间，不是扩展读取的时间。所以本方案不依赖它，插件自己持久化数值。
- 部署的 Paseo 前端有过滤函数 `sanitizeUsageEntry1664`：`details` 的 label 或 value 匹配绝对时间（`\b\d{1,2}:\d{2}\b`、`\d{1,2}月\d{1,2}日`、`YYYY-MM-DD`、UTC、时区等）时，整行被删除；`problem.detail` 和 `error` 匹配时，整段被替换成“额度查询未完成”。所以**所有说明文字只用相对时间**，例如“2 小时 15 分钟前”。不要绕过这个过滤。
- Paseo 守护进程按账号缓存 `fetch` 结果 5 分钟，所以面板变化最多晚 5 分钟。

## 3. 总体设计

```
后台用量页面的显示内容（每个浏览器环境维护一个标签页，读取前只刷新该标签页）
        ↓ chrome.scripting.executeScript（只读 DOM）
browser-extension/usage-reader.js（到期判断、维护和刷新用量标签页、解析）
        ↓ 每分钟 POST http://127.0.0.1:<端口>/usage（复用配对令牌）
server/browser-usage.ts（持久化、映射 UsageReport、registerUsageSource）
        ↓
Paseo 面板额度区域（每个浏览器环境一个账号）
```

使用独立的 `/usage` 路由，不在 `/sync` 里加字段。原因：

1. 旧插件严格校验 `/sync`，加字段会让旧插件拒绝同步，分组和问答一起失败。独立路由在旧插件上只是失败，不影响 `/sync`，所以插件和扩展的部署顺序不再是风险。
2. 不改 `BrowserSyncSchema` 和 `background.js` 第 170 行，减少和 #1704 的冲突。

`/usage` 每分钟发一次，同时充当“浏览器在线”信号。

## 4. 文件清单

### 4.1 新增

| 文件 | 内容 |
|---|---|
| `shared/browser-usage.ts` | `/usage` 请求结构 |
| `server/browser-usage.ts` | `BrowserUsageStore`、`toUsageReport`、`registerBrowserUsage` |
| `browser-extension/usage-reader.js` | 第 5 节的全部扩展逻辑 |
| `tests/browser-usage.test.ts` | 插件测试 |
| `tests/browser-usage-reader.test.ts` | 扩展测试 |

已提交的样本：`tests/fixtures/claude-usage/session-usage-ring.html`、`usage-dialog.html`。

### 4.2 修改（只追加，不重排）

| 文件 | 改动 |
|---|---|
| `browser-extension/background.js` | 第 1 行前加一行：`if (typeof importScripts === 'function') importScripts('usage-reader.js');` |
| `server/browser-bridge.ts` | 增加字段和方法：`private usageRoute?: (body: unknown) => void \| Promise<void>;`、`setUsageRoute(route: (body: unknown) => void \| Promise<void>) { this.usageRoute = route; }` |
| `server/browser-bridge.ts` 第 61 行 | 预检路径改成 `(req.url === '/sync' \|\| req.url === '/usage')` |
| `server/browser-bridge.ts` 第 68 行 | 把 `req.url !== '/sync'` 改成 `(req.url !== '/sync' && req.url !== '/usage')`，鉴权和请求体限制沿用 |
| `server/browser-bridge.ts` 第 72 行 `try {` 之后 | 加分支：`if (req.url === '/usage') { await this.usageRoute?.(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(204).end(); return; }`，解析失败走现有的 `catch` 返回 400 |
| `index.server.ts` | 增加导入，在第 113 行后加 `registerBrowserUsage(server, readyBrowser, directory);` |
| `OVERVIEW.md`、`browser-extension/README.md` | 文末说明读取内容、频率、不做的事 |

不修改：`manifest.json` 的权限和 `content_scripts`（扩展已有 `scripting`、`tabs`、`https://claude.ai/*`、`http://127.0.0.1/*`）、`shared/browser.ts`、`activity.js`、`approval.js`、`questions.js`、`title.js`、`options.js`、`tests/browser-extension.test.ts`、`tests/browser-bridge.test.ts`。扩展版本号在合并 #1704 后统一调整。

## 5. 扩展：`usage-reader.js`

运行在后台 Service Worker 中，用 `importScripts` 加载。文件内用 `globalThis.paseoUsage = { readDialog, parseReset, parseDialog, isUsageUrl, tick }` 暴露函数供测试。`typeof chrome === 'undefined'` 时不注册监听。文件自己注册闹钟和监听：

```js
chrome.alarms.create('usage', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'usage') void tick(); });
void tick();
```

`tick()` 单次执行（用内存标记防止并发）。

### 5.1 注入页面的函数（只读）

标签页 `status === 'complete'` 后，用 `chrome.scripting.executeScript({ target: { tabId }, func: readDialog, args: [reloadAt] })` 注入到扩展维护的用量页面标签页。函数同时返回 `performance.timeOrigin`（供 `reload` 后核对是否为新文档），内部短轮询等待 `[role="meter"]` 出现（每 500 毫秒查一次，最多 30 次即 15 秒；遇到 `/login`、`Just a moment` 或检测到 `timeOrigin < reloadAt` 的旧文档时立即结束等待）：

```js
async function readDialog(minTimeOrigin = null) {
  const timeOrigin = typeof performance !== 'undefined' && Number.isFinite(performance?.timeOrigin) ? performance.timeOrigin : null;
  const isStale = typeof minTimeOrigin === 'number' && typeof timeOrigin === 'number' && timeOrigin < minTimeOrigin;
  let meters = [];
  for (let i = 0; i < 30; i++) {
    if (location.pathname.startsWith('/login') || document.title.includes('Just a moment')) break;
    const root = document.querySelector('[data-testid="usage-page-pace"]');
    meters = [...(root?.querySelectorAll('[role="meter"]') ?? [])];
    if (meters.length > 0 || isStale) break;
    if (i + 1 < 30 && typeof setTimeout === 'function') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const rows = meters.map(meter => {
    const labelEl = document.getElementById(meter.getAttribute('aria-labelledby'));
    let row = meter;
    for (let i = 0; i < 6 && labelEl && row.parentElement && !row.contains(labelEl); i++) row = row.parentElement;
    return { label: labelEl?.textContent?.trim() ?? '', used: meter.getAttribute('aria-valuenow'), valueText: meter.getAttribute('aria-valuetext') ?? '', reset: row.textContent.match(/Resets (?:at )?[A-Za-z]*\s?\d{1,2}:\d{2} [AP]M/)?.[0] ?? null };
  });
  return { path: location.pathname, title: document.title, rows, now: Date.now(), tzOffset: new Date().getTimezoneOffset(), timeOrigin };
}
```

不要在 `Resets` 前加 `\b`：`textContent` 把标签和重置文字连在一起（`Current sessionResets at 6:50 AM`）。向上查找只到包含本行标签元素（`aria-labelledby` 指向的节点）的那一层行容器为止，避免 5 小时窗口尚未开始（显示 `Starts with your first message`、无 `Resets` 文字）时越过本行读到每周窗口的重置时间。

### 5.2 解析与校验函数（纯函数，不碰 DOM）

- `isUsageUrl(url)`：判断地址是否仍为 claude.ai 用量页面（`https://claude.ai/settings/usage` 或 `https://claude.ai/new#settings/usage`）。
- `parseReset(text, now, tzOffset)`：`tzOffset` 取页面值，在页面本地时间上计算，返回 ISO 时间或 `null`。
  - `Resets at H:MM AM|PM`：当天该时刻；不晚于现在就加 1 天。
  - `Resets <星期全名> H:MM AM|PM`：下一个该星期的该时刻；不晚于现在就加 7 天。
  - 其他格式返回 `null`（窗口仍显示比例）。
- `parseDialog(data)`：要求 `Current session` 和 `This week` 两行都存在，且 `valueText` 含 `used`、`used` 是 0–100 的数字。否则返回 `null`（记 `parse` 或 `timeout`）。

样本期望值（`now = 2026-11-08T11:07:20.885Z`，`tzOffset = 300`）：

| 来源 | `usedPct` | `resetsAt` |
|---|---|---|
| `Current session` | 59 | `2026-11-08T11:50:00.000Z` |
| `This week` | 46 | `2026-11-14T00:00:00.000Z` |

### 5.3 读取规则

状态保存在 `chrome.storage.local` 的独立键 `usageState`：`nextReadAt`、`failures`、`fiveHour`、`weekly`、`status`、`reason`、`observedAt`、`tab`。不碰其他键。

`tick()` 的步骤：

1. 读取 `pairing`、`instanceId`、`instanceName`、`adspowerProfile`。未配对或配对格式错误时结束，不读取，不打开页面，不发送。
2. `now >= nextReadAt` 时执行一次用量页面读取（第 5.4 节）：
   1. 检查扩展维护的用量页面标签页：已有且仍在用量页面或登录页面地址时刷新该标签页；没有、已关闭或地址已不是用量/登录页面时，在后台新建一个用量页面标签页。
   2. 先等待该标签页加载完成（`status === 'complete'`），再注入 `readDialog` 短轮询等待弹窗内出现 `[role="meter"]`，读取 `Current session`（5 小时窗口）和 `This week`（每周窗口）。
   3. 读取成功时更新两个窗口的值，状态设为 `ok`；未登录或失败时保留已有的窗口旧值，更新 `status`、`reason` 和下次读取时间，不上报刷新前的旧 DOM 数字作为新结果。
3. 不管是否到期，都用当前状态 POST `/usage`（第 6.1 节）。网络失败时忽略，下一分钟重试。

间隔：

| 情况 | 下次读取 |
|---|---|
| 成功 | 10 分钟后 |
| 失败 | 按连续失败次数 20、40、60 分钟，最长 60 分钟 |
| 未登录 | 30 分钟后 |

### 5.4 维护、刷新与读取用量页面标签页

复用或打开：

1. 如果 `usageState.tab?.id` 有记录，调用 `chrome.tabs.get(usageState.tab.id)` 检查该标签页：
   - 标签页存在且 `isUsageUrl(tab.url)` 为真（`/settings/usage` 或 `/new#settings/usage`）：复用该标签页，只对它调用 `chrome.tabs.reload(tab.id)` 刷新。
   - 标签页已不存在，或 `isUsageUrl(tab.url)` 为假（用户已把该标签页切走、改地址或关闭了弹窗）：**不刷新、不改回、不关闭该标签页**，视为不再由扩展维护，清除 `usageState.tab` 记录。
2. 没有可复用的维护标签页时：
   - `chrome.windows.getAll({ windowTypes: ['normal'] })` 为空时不打开，记 `failed`、`no_window`。
   - 调用 `chrome.tabs.create({ url: 'https://claude.ai/settings/usage', active: false })` 在后台打开用量页面，**先把 `{ id, openedAt }` 写入 `usageState.tab`，再开始等待**。
3. 打开后保留该标签页，不调用 `chrome.tabs.remove` 关闭，供下一轮复用。

等待：

1. `reload` 发起前记录 `reloadAt = Date.now()`（新开标签页时 `reloadAt` 为 `null`，不做 `timeOrigin` 校验）。
2. 每 500 毫秒轮询一次（最多 30 次即约 15 秒）：先用 `chrome.tabs.get(tabId)` 确认标签页 `status === 'complete'`，再注入 `readDialog`。
3. 对 `reload` 的标签页，只接受 `pageData.timeOrigin >= reloadAt` 的新文档结果；若返回的是旧文档（`timeOrigin < reloadAt`），每 500 毫秒重试，最多约 15 秒，仍不满足则记 `failed`、`timeout`，绝不把旧文档数字上报为新结果。
4. 进入新文档后，`readDialog` 在函数内每 500 毫秒短轮询 `[role="meter"]`，最多 30 次（15 秒）。

| 页面情况 | 结果 |
|---|---|
| `parseDialog` 成功 | `ok` |
| `path` 以 `/login` 开头 | `signed_out` |
| 标题含 `Just a moment` | `failed`、`challenge` |
| 标签页加载超时或 15 秒内未出现有效数据 | `failed`、`timeout` 或 `parse`（有 `rows` 但解析失败时为 `parse`） |
| 等待期间标签页被关闭，或被用户改到非用量、非登录地址 | 清除 `usageState.tab`，不强行改回，记 `failed`、`tab_closed` |

表中“登录页”和“安全验证页”两行没有实测，因为取证时不能退出登录。实现时用假数据测试，并在真机验收时留意。

## 6. 插件

### 6.1 `shared/browser-usage.ts`

```ts
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserUsageWindowSchema = z.strictObject({ usedPct: z.number().min(0).max(100), resetsAt: z.string().datetime().nullable(), observedAt: z.string().datetime() });
export const BrowserUsagePostSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().trim().min(1).max(120).default('未命名浏览器环境'),
  adspowerProfile: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['pending', 'ok', 'signed_out', 'failed']),
  reason: z.enum(['no_window', 'parse', 'timeout', 'challenge', 'tab_closed']).optional(),
  observedAt: z.string().datetime(),
  fiveHour: BrowserUsageWindowSchema.nullable(),
  weekly: BrowserUsageWindowSchema.nullable(),
});
export type BrowserUsagePost = z.infer<typeof BrowserUsagePostSchema>;
```

`pending` 表示扩展还没读过一次。`adspowerProfile` 为可选的 AdsPower 环境序号（`serial_number`）或环境 ID（`user_id`）。请求体不含会话内容。

### 6.2 `server/browser-usage.ts`

`BrowserUsageStore`：

- 每个环境一条记录：`instanceId`、`instanceName`、`adspowerProfile`、`adspowerUserId`、`adspowerSerialNumber`、`adspowerName`、`adspowerQueriedAt`、`adspowerError`（`'连接失败' | '需要在额度设置填写 AdsPower API key' | 'API key 无效，请在额度设置重新填写' | '需要 api key' | '被限流' | '未找到环境'`）、`displayName`、`labelSource`（`'adspower_name' | 'serial_number' | 'user_id' | 'instance_name'`）、`labelSourceText`、`lastPostAt`（插件接收时间）、`status`、`reason`、`fiveHour`、`weekly`。`BrowserUsagePostSchema` 与 `StoredRecordSchema` 均向后兼容可选的 `account` 字段并自动剥离丢弃。
- `record(body)`：用 `BrowserUsagePostSchema.parse` 校验，失败时抛错（路由返回 400）。先将额度窗口数据与已有缓存名称立即落盘并返回，不阻塞 `BrowserBridge` 请求队列；需要在后台查询 AdsPower 官方本地 API（默认 `http://127.0.0.1:50325`，保留可配置，超时 3 秒，支持在插件“额度设置”配置页填写 AdsPower API key 并保存在权限 0600 的 `browser-usage.json` 中——不写日志、不返回给前端，前端接收 `adspowerApiKeyConfigured` 与 `adspowerApiKeySource` 显示“已配置/已配置（来自环境变量）/未配置”，来自环境变量时隐藏清除按钮，保存或清除 key 时递增版本号丢弃旧在途结果并立即重查，额度模块支持 `stop()` 并在插件停止时调用；全局请求队列保证两次请求至少间隔 1.1 秒，按 `user_id` 缓存并在首次出现、上报序号变化或距上次查询满 10 分钟时才查询，同一环境同一版本最多 1 个在途查询）时，在队列外异步执行并在完成后更新 `displayName` 与 `adspowerError` 落盘：
  - 扩展上报了 `adspowerProfile`（或数字 `instanceName`）时，先查 `/api/v1/user/list?page_size=100` 批量缓存并按 `serial_number` 或 `user_id` 精确匹配；若批量列表未命中，再用 `serial_number` 或 `user_id` 过滤参数查一次（仍走全局限速队列），仍无精确匹配时记为 `未找到环境`（不拿列表第一条顶替）；
  - 扩展未填且仍为默认 `未命名浏览器环境` 时，仅当本机只有 1 个扩展上报且 `/api/v1/browser/local-active` 恰好返回 1 个已打开环境时，取其 `user_id` / `serial_number` 并查 `/api/v1/user/list?page_size=100`（未命中时带过滤参数再查一次）取 `name`；
  - 若 `name` 为空或本地 API 未开启/查询失败，按顺序回退显示 `serial_number`、`user_id`、`instanceName`（已有解析结果的保留上次名称），记录 `labelSource` / `labelSourceText` 调试字段，并将失败原因（`连接失败` / 未配置 API key 时 `需要在额度设置填写 AdsPower API key` / 已带 key 仍被拒时 `API key 无效，请在额度设置重新填写` / `被限流` / `未找到环境`）写入该环境额度详情行（`环境名称: AdsPower 查询失败（原因）`），不影响额度上报。
- 持久化到状态目录 `browser-usage.json`，权限 0600，先写临时文件再改名（写法同 `browser-bridge.ts` 的 `save`）。只在 `status`、`reason`、窗口、名称、AdsPower 字段变化或多实例清理单环境自动识别结果时立即写入，或距上次写入超过 1 小时时写入。
- 超过 3 天没有收到 POST 的记录，在读取时删除。

`registerBrowserUsage(server, readyBrowser, directory)`：

- 先 `store.load()`，再 `readyBrowser().then(browser => browser.setUsageRoute(store.record))`。`discover` 和 `fetch` 开头也调用一次（幂等），这样浏览器通道重建后还能接上。失败时忽略。
- `server.registerUsageSource({ id: 'claude-browser', label: 'claude.ai 浏览器环境', input: z.strictObject({ instanceId: id }), discover, fetch })`。
- `discover(scope)`：`scope.kind !== 'global'` 时返回空数组；否则返回保留期内的每个环境：`key: hashAccountKey(instanceId)`、`label` 为 `displayName || instanceName`（未打开浏览器时仍显示已持久化的名称）、`input: { instanceId }`。两个环境显示标签相同时，标签改为“显示标签 · key 前 4 位”。
- `hashAccountKey`、`toneFromUsedPct`、`windowFromUsedPct`、`unavailable` 从 `@getpaseo/plugin/server/usage` 导入。

### 6.3 `toUsageReport(record, now, channelEnabled)`

“在线”的定义：`now - lastPostAt < 150_000`（和 `browser-bridge.ts` 的 `MAX_AGE` 相同）。

窗口：

- `windows[0]`：`windowFromUsedPct({ id: 'five_hour', label: '5 小时窗口', shortLabel: '5h', summary: true, utilizationPct, resetsAt, tone })`
- `windows[1]`：`windowFromUsedPct({ id: 'weekly', label: '每周窗口', shortLabel: 'wk', utilizationPct, resetsAt, tone })`
- 还没有某个窗口的数据时，`utilizationPct` 传 `null`。
- 在线且 `status` 为 `ok` 时 `tone` 用 `toneFromUsedPct(usedPct)`；其他情况 `tone: 'default'`，表示这不是当前值。

| 情况 | 返回 | `details` 或文字 |
|---|---|---|
| 通道已关闭，有数据 | `available` + 上次窗口 | 状态：`开发自动化插件的浏览器通道已关闭，无法检测剩余额度，只展示上一次同步的额度` + 上一次同步 |
| 不在线，有数据 | `available` + 上次窗口 | 状态：`未打开浏览器，无法检测剩余额度，只展示上一次同步的额度` + 上一次同步 |
| 不在线，无数据 | `unavailable`（`no_quota`） | `未打开浏览器，无法检测剩余额度，还没有同步过额度` |
| 在线，`ok` | `available` + 窗口 | 同步时间 |
| 在线，`signed_out`，有数据 | `available` + 上次窗口 | 状态：`该浏览器环境未登录 claude.ai，只展示上一次同步的额度` + 上一次同步 |
| 在线，`signed_out`，无数据 | `unavailable`（`no_quota`） | `该浏览器环境未登录 claude.ai` |
| 在线，`failed`，有数据 | `available` + 上次窗口 | 状态：`额度读取失败（原因），只展示上一次同步的额度` + 上一次同步 |
| 在线，`failed`，无数据 | `error` | `额度读取失败（原因）` |
| 在线，`pending` | `unavailable`（`no_quota`） | `正在等待第一次读取额度` |
| `instanceId` 不在存储中 | `unavailable`（`no_quota`） | `该浏览器环境已长时间未连接` |

原因的中文：`no_window` 没有打开的浏览器窗口；`parse` 页面格式无法识别；`timeout` 页面加载超时；`challenge` 需要完成安全验证；`tab_closed` 读取页面被关闭。

`details` 的写法：

- 状态行：`{ id: 'state', label: '状态', value: 上表文字, tone: 'warning' }`。
- 时间行：`{ id: 'synced', label: '上一次同步' 或 '同步时间', value: 相对时间 }`，取两个窗口里较新的 `observedAt`。
- 两个窗口的 `observedAt` 相差超过 10 分钟时，加 `{ id: 'weekly-synced', label: '每周窗口同步时间', value: 相对时间 }`。
- 显示上一次数据且某个窗口的重置时间已过时，状态行末尾加：`；部分窗口已过重置时间，实际用量可能更低`。数字不清空。
- 相对时间格式：`刚刚`（小于 1 分钟）、`N 分钟前`、`N 小时 M 分钟前`、`N 天 H 小时前`。任何文字都不能出现第 2.3 节列出的绝对时间格式。

## 7. 测试

### 7.1 `tests/browser-usage-reader.test.ts`（`node:vm` 加载 `usage-reader.js`，假 `chrome`）

1. `parseReset`：当天、跨天、跨周；未知格式返回 `null`；用 `tzOffset` 300 和 0 各测一次。
2. `readDialog` 与 `parseDialog`：用真实样本 `usage-dialog.html` 提取并解析出两个窗口（59% / `2026-11-08T11:50:00.000Z`、46% / `2026-11-14T00:00:00.000Z`）；不读会话圆环样本 `session-usage-ring.html`；只有一行、`valueText` 不含 `used`、比例超出 0–100 时返回 `null`；不把 `Claude Code` 等分类行当成窗口。
3. 维护与复用用量标签页：首次读取没有维护标签页时调用 `tabs.create({ url: 'https://claude.ai/settings/usage', active: false })`，先把标签页编号写入存储再等待，读完后保留标签页不调用 `tabs.remove`；下一轮 10 分钟到期且标签页仍在 `/new#settings/usage`（或 `/settings/usage`）时，复用该标签页并只对它调用 `tabs.reload`，不新建标签页，不碰业务会话标签页；`reload` 后先返回 `loading` 再 `complete` 时等待 `complete` 后才注入读取、`[role="meter"]` 延迟出现时短轮询等待成功、加载或 `[role="meter"]` 超时记 `failed`（`timeout`）且不上报刷新前的旧数字。
4. 用户切走、改地址或关闭标签页：
   - 用户把维护的标签页改地址（如变为 `/new`、`/code/session_abc`、`https://example.com`）时，下一轮不刷新、不强行改回、不关闭原标签页，视为不再由扩展维护，另开一个后台用量页面并记住新标签页编号。
   - 用户关闭维护的标签页后，下一轮另开一个后台用量页面。
   - 等待读取期间标签页被关闭或被用户改到非用量、非登录地址时，清除旧标签页编号，记 `failed`（`tab_closed`），保留上次窗口数值。
5. 异常情况：没有普通浏览器窗口时记 `failed`（`no_window`）且不创建标签页；登录页 `/login` 记 `signed_out`；标题含 `Just a moment` 记 `failed`（`challenge`）；有 `rows` 但无法解析记 `failed`（`parse`）；超时无数据记 `failed`（`timeout`）。
6. 到期和退避：10 分钟；失败按连续次数 20、40、60 分钟（最长 60 分钟）；未登录 30 分钟。
7. 未配对或配对格式无效时不注入、不打开、不刷新、不发送。
8. POST 的地址是把配对地址的 `/sync` 换成 `/usage`，带令牌，每分钟一次，不到期时也发送。
9. 全文检查：`usage-reader.js` 里调用的 `fetch` 只指向配对地址；不含 `.click(`、`dispatchEvent`、`location.` 赋值、`tabs.remove`。

### 7.2 `tests/browser-usage.test.ts`

1. 多个环境与 AdsPower 名称解析：`discover` 的 `key` 等于 `hashAccountKey(instanceId)`，`label` 优先采用 AdsPower 本地 API 返回的环境名称（`labelSource: 'adspower_name'`），读不到名称时按顺序回退显示 `serial_number`、`user_id`、`instanceName`；按 `user_id` 缓存且 10 分钟内不重复请求；仅在本机单活跃环境且仅 1 个扩展上报时启用 `/api/v1/browser/local-active` 自动识别；显示标签相同时带后缀；持久化后重新加载及未打开浏览器时仍显示上一次解析的名称。`scope.kind === 'session'` 时返回空数组。
2. 第 6.3 节表格的每一行。
3. 窗口替换：`null` 不覆盖旧值，旧的 `observedAt` 不覆盖新值，未来时间被截断。
4. 显示上一次数据且窗口的重置时间已过时，数字保留，状态行有说明。
5. 所有 `details` 的 label 和 value、所有错误文字都不匹配第 2.3 节的绝对时间规则（把规则抄到测试里）。
6. 持久化：重建存储后数据还在；文件权限 0600；3 天后 `discover` 不再返回。
7. 真实 `BrowserBridge`（写法同 `tests/browser-bridge.test.ts`，随机端口）：有令牌的 `/usage` 返回 204 并进入存储；无令牌返回 401；非法比例 150 返回 400；`/usage` 的 OPTIONS 通过；`/sync` 不受影响。

通过标准：`npm run check` 全部通过。

## 8. 已决定的问题与已知限制

1. **统一读取用量页面（#1727 评论 6720771386，用户决定“那就统一打开一个用量页”）**：
   - 不读会话页面下方的圆环，只读用量页面。
   - 每个浏览器环境保持一个用量页面标签页：没有就在后台打开一个，已有就复用，打开后保留，不再反复打开和关闭。
   - 每 10 分钟读取一次 5 小时和每周两个窗口，读取前只刷新扩展维护的这个用量页面标签页，不刷新、不点击其他页面。
   - 用户把这个标签页切走、改地址或关闭时，扩展不强行改回，下一轮再按规则处理（地址不再是用量页面时，视为不再由扩展维护，另开一个）。
2. **面板条目名称使用 AdsPower（SunBrowser）环境名称（2026-11-08 用户决定）**：
   - 不再读取 `claude.ai` 前端缓存 IndexedDB 中的邮箱。
   - 由插件服务端通过 AdsPower 官方本地 API（默认 `http://127.0.0.1:50325`，超时 3 秒，支持在插件“额度设置”配置页填写 AdsPower API key 并仅保存在本机 0600 状态文件中，不写日志、不返回前端，前端显示“已配置/已配置（来自环境变量）/未配置”且来自环境变量时隐藏清除按钮，可清除、可重新填写，保留环境变量作为后备来源；全局请求队列间隔至少 1.1 秒）按 `serial_number` 或 `user_id`（或本机唯一活跃环境且唯一上报扩展时的 `/api/v1/browser/local-active`）查询环境 `name`，按 `user_id` 缓存并在首次出现、序号变化或满 10 分钟时才查询；要准确显示名称需在扩展选项页填一次环境序号，单环境自动识别只在单个活跃环境且单个扩展上报时生效；读不到名称时按顺序回退显示环境序号、`user_id` 或扩展上报的 `instanceName`，并在额度详情行写出失败原因（连接失败 / 需要在额度设置填写 AdsPower API key / API key 无效，请在额度设置重新填写 / 被限流 / 未找到环境）及在记录中保存 `labelSource` / `labelSourceText` 供验收核对。

已知限制（不需要决定，除非有反馈）：

- 只验证了英文界面。其他语言显示“页面格式无法识别”，并保留上一次的数字。如果有中文界面的环境要支持，需要该环境的页面样本。
- 插件分不清“取消配对”和“浏览器关闭”，两者都显示“未打开浏览器”。

## 9. 真机验收（Mac Mini，部署由主会话协调）

1. 部署插件并重新加载，确认分组和问答正常。
2. 在一个 SunBrowser 环境更新扩展，确认环境名称。
3. 等待首次读取完成：确认扩展在后台打开一个 `/settings/usage`（跳转到 `/new#settings/usage`）标签页并保留不关闭；Paseo 面板出现该环境，5 小时窗口和每周窗口的值、重置时间与用量页面一致。
4. 等待下一轮 10 分钟读取触发（或用缩短常量的测试版）：确认扩展复用并只刷新该用量页面标签页，不新建第二个标签页，不刷新业务会话标签页。
5. 把该用量标签页改到其他地址（或关闭弹窗、关闭标签页），等到下一轮读取，确认扩展不强行改回原标签页，而是在后台另开一个新的用量标签页。
6. 关闭浏览器，等待 8 分钟以内（2.5 分钟判定离线 + 最多 5 分钟 Paseo 缓存）。面板显示“未打开浏览器，无法检测剩余额度，只展示上一次同步的额度”、上次的数字、相对时间。**核对状态行在面板里显示完整，没有被截断或删除。**
7. 重新加载插件后，第 6 步的显示还在。
8. 确认浏览器的 Network 面板没有扩展发出的 claude.ai 请求，业务会话页面没有刷新，没有点击痕迹。
9. 录制面板变化的 GIF，交给主会话审核 UX。

## 10. 部署顺序

推荐先插件，后扩展。原因是验收方便，不是兼容性要求：新扩展遇到旧插件时，`/usage` 请求失败并被忽略，`/sync` 不受影响；新插件遇到旧扩展时，只是没有额度数据。

部署和扩展更新由主会话协调窗口。实现会话不部署，不重新加载任何 Mac 上的插件，不更新 SunBrowser 里装的扩展。
