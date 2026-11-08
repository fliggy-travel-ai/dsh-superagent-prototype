# #1704 Claude guard 源码审计与迁移建议

调查日期：2026-11-07。范围为本机静态源码和目标仓库结构；未连接浏览器或 Paseo，未执行 guard、安装脚本或网页操作。源码行为不代表当前进程状态或线上验收。

## 摘要和目标仓库边界

- `/Users/yishu.cy/Documents/IdeaProjects/research/.agents/skills/claude-allow-guard/scripts/` 与 `/Users/yishu.cy/.claude-guard/` 的 `matcher2.js`、`probe.js`、`resident.py`、`cdp.py` 逐字节一致。`account_failover.py`、`steer_stopped.py`、`watchdog.sh`、`resume.sh`、`stop.sh`、`auto-answer.flag`、`check-prompt.txt` 也一致；此处只比较文件内容，不判断进程实际加载版本或 flag 当前语义。源码侧 `install.sh` 无对应运行目录文件；运行侧 `tabgroup-ext/{manifest.json,bg.js}` 在技能目录内未找到。运行侧还有其他辅助程序与状态文件，不等于技能安装内容。
- 当前仓库 HEAD `6337fc823ce20251c8de8085948165c81aaa701e`，`main` 落后 origin/main 3 个提交；调查开始时工作区干净。`git ls-tree -r HEAD` 和本地有限路径检索未发现 `paseo-github-subscriptions` 或其插件入口；`package.json` 标识的是 DSH bundle `dsh-superagent`，`prompts/subscriptions.md` 不能证明是该 Paseo 插件。因此无法核实插件 ID、实际文件布局和生命周期，以下是对主会话的接口建议，不是对该插件现状的断言。请主会话在其实际插件位置验证后落位，保留既有 ID、GitHub 行为和配置兼容性。
- 两种能力属于不同协议：guard 使用 AdsPower + CDP 观察 Claude 网页 DOM；Paseo 原生权限请求必须由 Paseo 自身会话/权限通道处理，不能以网页按钮文字推导原生授权。现有分组是 Claude 网页会话名，未发现 Paseo session ID 到标签的绑定。

## 旧代码：文件、依赖和行为

| 文件 | 静态证据和实际行为 | 迁移结论 |
| --- | --- | --- |
| `scripts/install.sh:15-25,30-45` | 只复制所列 7 个文件；默认停止并重启进程，`--deploy-only` 仍会复制覆盖。扩展不在清单中。 | 不执行安装，也不将守护进程部署脚本带入插件生命周期。 |
| `scripts/cdp.py:5-15,18-52,59-119,138-145` | Python `websockets`；AdsPower 本地 API `/api/v1/browser/local-active` 和本机 `DevToolsActivePort` 扫描找 profile/端口；CDP `/json/list`、`/json/version`、`Runtime.evaluate`、`Input.dispatchMouseEvent`、`Target.createTarget`。API 失败有静默回退；源码内存在硬编码 API 凭据。 | 不复制凭据或整文件；如未来确需支持 AdsPower，使用外部凭据提供机制和明确的 profile 选择，访问失败显式上报。 |
| `scripts/resident.py:19-48,50-78,254-266,463-505` | 默认 3 秒轮询；静态 Claude 路径名称表仅用于显示，`ENSURE={}` 禁止自动补开；遍历所有发现的 profile，匹配页面/iframe 的 Claude 或 Claudeusercontent URL，排除归档项后运行 matcher。profile 信息不构成 Paseo 身份绑定，点击范围不受名称表约束。 | 不复用全 profile 扫描/点击；只对明确绑定且受授权的对象处理。 |
| `scripts/matcher2.js:1-74,140-181,185-275` | 按短按钮文本 `allow_once`、`allow_session`、精确通用 `allow/approve/yes/run` 及弹窗结构启发式点击；对部分弹窗自动滚动，普通分支可移除 disabled；下拉用 MutationObserver 点击；离开模式可点 `Always allow`。 | 不可作为原生权限判断器；启发式不能证明动作类型、授权范围或真实主体。 |
| `scripts/probe.js:3-42,90-110` | 名称虽为 probe，运行即自动滚动弹窗，匹配时还会移除 disabled 并返回坐标；不完全只读。 | 新方案的观察接口应无副作用，绝不解除禁用或绕过阅读门槛。 |
| `scripts/resident.py:281-285,341-423` | `Runtime.evaluate` 先执行可能点击的 matcher，之后才检查 30 次/5 分钟及同签名 8 次/5 分钟制动；三次探测仍存在时执行 CDP 真实鼠标点击，失败后截图，后续循环继续。二次探测异常被置为 `{}`，可能记为 fallback 成功，不能证明授权完成。 | 制动和幂等判断须在任何动作前；超时、失联、未确认或状态不一致为 unknown，停止自动处理并交人工，不能自动补点或推断成功。 |
| `scripts/matcher2.js:277-295,323-364,367-427`；`resident.py:293-339` | 离开模式下可选择 Recommended、提交并最多补提交 3 次；无推荐时按偏向自动执行的关键词选项打分；危险词拦截仅是启发式。非离开模式还会语音通知/聚焦。源码注释称只选 Recommended，与 fallback 实现不一致。 | AskUserQuestion 是用户决策，独立于权限处理；不迁移泛化代答、提交重试、语音抢焦点。登录、验证码、安全验证等一律留给用户；仅靠危险词不能构成安全边界。 |
| `tabgroup-ext/manifest.json:1-20`；`bg.js:11-171` | Manifest V3 service worker，权限 `tabs`、`tabGroups`、`scripting`、`storage`、`alarms`，访问 Claude 和本机 collector。按 `https://claude.ai/code/session_*` 查标签；`chrome.scripting.executeScript` 从同 session 的侧栏链接、标题栏再到任意 session 链接取名；新建或复用现有 group，`chrome.tabGroups.update` 命名，人工重命名锁保存在 `chrome.storage.local`；监听 tab/group、启动、安装和定时重整。 | 可借鉴分组 API、人工重命名保护和事件驱动；任意 session 链接 fallback 可能取错名，group ID/显示名称不是可信身份，现有算法也不会将多个相关业务标签按 Paseo 会话合组。 |
| `tabgroup-ext/bg.js:173-273` | 单独的 usage collector 使用网页 cookie 调 Claude organizations、usage、subscription 和 account API，存本地并 POST 给 localhost collector，另有 alarms。 | 与任务无关，最小迁移明确排除；不迁移账号数据采集、profile tag 或相关 host 权限。 |

文档 `SKILL.md:3-7,79-95` 声称永不 Always allow、会补开名单标签；实际代码在离开模式存在 Always allow，且 `ENSURE` 当前为空。旧文档不能替代源码；以上不推断旧授权适用于新插件。

## 建议的真实身份绑定和接口（待主会话确认 Paseo API）

同一现有插件入口保留原 ID 和 GitHub 模块，新增逻辑模块 `permissions`、`browser`；模块名称和下列签名均为设计建议，不是已发现 API。插件沿用现有生命周期与配置持久化，避免另起常驻守护；各模块独立启停与清理监听。默认不启用自动决策，明确记录用户授权范围及其撤销。

1. **Paseo 侧信任根**：从宿主提供的可信会话上下文取得 `{hostId, workspaceId, sessionId}` 和当前显示名；以稳定 ID 做主键，显示名只作标题。Paseo API 是否提供上述字段、可靠事件及模式值由主会话实证，缺任何关键身份就不自动处理。
2. **绑定建立**：在携带可信 Paseo session 上下文的浏览器启动/打开动作中，由插件创建一次性、高熵、短时效的关联句柄；通过受控宿主桥接把该句柄和实际 browser instance/profile、window/tab ID 关联，再由插件消费一次并保存 `{hostId, workspaceId, sessionId, browserInstanceId, profileId, tabId, bindingGeneration}`。避免将句柄放入可泄露的 URL、页面内容或日志；桥接需校验来源、单次使用、过期及 tab 归属。具体桥接能力尚未验证：若宿主或浏览器不能提供可信关联，则提供用户显式选择并确认的绑定流程，仍无法验证所有权时标记未绑定，不能靠标题、URL、时间邻近或 Claude 会话名猜测。
3. **关联生命周期**：允许同一 Paseo 会话多标签，一个标签同一时刻至多一个有效绑定；跨 profile/window 只在相应实例内建立组。关闭、导航、profile 重启、session 结束或绑定代次变化时失效/重新验证，避免 tab ID 复用。session 重命名只更新展示；重名 session 使用各自 ID 独立分组。保留人工移动/重命名，冲突时提示而不强行覆盖；扩展不可用时降级为未分组并报告，不影响权限模块。
4. **建议边界**：`BrowserBindings.bind(context, verifiedTab) -> binding`、`unbind(bindingId)`、`list(sessionKey)`；`BrowserGroups.reconcile(sessionKey, displayName, bindings)`；宿主桥接实现和 Chromium 扩展之间只传绑定所需最小元数据，不读取 Claude 内容或 cookie。禁止使用现有 `profileTag` 作为身份凭据。
5. **权限接口**：`Permissions.onRequest({sessionKey, requestId, kind, details, mode, authorizationRevision})` → `evaluate(request, explicitGrant)` → `resolve(requestId, decision)`；这些是抽象接口，非宣称 Paseo 已有 API。必须由可信宿主事件同时证明 session、请求 ID、精确动作与资源、当前 Accept Edits 模式和该用户对该动作的有效授权；Accept Edits 本身不等于所有权限。仅明确匹配授权的请求允许按宿主的原生 API 一次性处理；其他请求保留给用户。提交前重新校验身份、模式、授权、请求仍 pending，按 request ID 幂等并发单飞。
6. **结果与失败**：只有宿主确认对应 request 已解析才记成功；超时、断连、重复、不匹配、已过期、登录或安全验证、AskUserQuestion、无法识别的类型均转人工/unknown，不重复提交、不用 DOM 或鼠标回退。审计只记录必要的 ID、决策、原因、时间和结果，不记录 token、cookie、原始问题、客户内容或截图。

## 最小迁移与验收建议

- 第一阶段在实际目标插件内新增原生 `permissions` 策略及 `browser` 绑定/分组适配器，复用现有 GitHub 入口和插件 ID；仅在明确可用的宿主 API 上接入。旧 JS/Python 仅供行为参考，不整包复制；不迁移全环境扫描、自动回答、Always allow、账号切换、标签复活、usage、watchdog、截图和自动重试。
- 用离线模拟宿主及浏览器适配器验证：同名 session、多个标签、多 profile、重命名、tab 关闭及 ID 复用、重启/断线和未绑定；验证错误身份、模式改变、授权撤销、重复事件、未知结果、AskUserQuestion/登录验证均不自动批准；确认只处理明确授权的单个 pending 请求及结果未知不重试。再由主会话在授权的测试环境验证真实 API 与扩展通信；本次没有做运行验证。
- 主要未决项：真实插件位置与 ID、Paseo 能否提供可信请求/会话/模式/授权事件和原子 resolve、浏览器创建是否传递可信上下文、跨扩展桥接的身份校验与实际浏览器支持。任一缺失都应先补能力或保留人工步骤，不用页面名称拼接替代。
# 后续实施说明

本文保留初始审阅结论。用户后续已授权在线离线问答、设备选择、语音和人工待办迁移。当前能力与验证边界以 [原方案迁移对照](1704-source-migration.md) 为准，前文的初始排除项不代表当前版本全部范围。
