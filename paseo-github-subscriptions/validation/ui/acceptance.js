// fixture 预览的界面验收脚本。运行：见 validation/ui/README.md
// ego-browser nodejs < acceptance.js   （每次运行会重新截图并覆盖 out/）
const ROOT = process.cwd();
const OUT = `${ROOT}/out`;
const BASE = "http://127.0.0.1:4173/";
const fs = await import("node:fs/promises");
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(`${OUT}/shots`, { recursive: true });

const task = await taskSpace("ghsub-ui-fixture-preview");
const page = task.page("p1");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => page.waitForTimeout(ms);
const text = () => page.evaluate(() => document.getElementById("root").innerText);
const report = () => page.evaluate(() => window.__ghsub.report());
const labels = {};
const counters = {};

async function open(query) {
  await page.goto(`${BASE}?${query}`);
  await page.waitForFunction(() => window.__ghsub !== undefined);
  await sleep(700);
}
async function clipRect() {
  return page.evaluate(() => {
    const root = document.getElementById("root").getBoundingClientRect();
    const banner = document.getElementById("banner").getBoundingClientRect();
    return { x: Math.max(0, root.left - 12), y: 0, width: root.width + 24, height: root.bottom + 12, banner: banner.bottom };
  });
}
async function shot(name) {
  const r = await clipRect();
  await page.screenshot({ path: `${OUT}/shots/${name}.png`, clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
}
async function frame(flow, label) {
  const n = (counters[flow] = (counters[flow] ?? 0) + 1);
  const file = `${OUT}/frames/${flow}/${String(n).padStart(2, "0")}.png`;
  const r = await clipRect();
  await page.screenshot({ path: file, clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
  (labels[flow] ??= []).push(label);
}
// 版面检查：横向溢出、纯黑文字（说明有 Text 没取主题色）。
async function layoutChecks(name) {
  const r = await page.evaluate(() => {
    const root = document.getElementById("root");
    const rect = root.getBoundingClientRect();
    const overflow = [];
    const black = [];
    for (const el of root.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const clipped = (() => {
        for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== "visible" && p.getBoundingClientRect().right <= rect.right + 1) return true;
        }
        return false;
      })();
      if (!clipped && b.right > rect.right + 1 && getComputedStyle(el).position !== "fixed") overflow.push(`${el.tagName}:${(el.textContent || "").slice(0, 20)}@${Math.round(b.right - rect.right)}`);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own && getComputedStyle(el).color === "rgb(0, 0, 0)") black.push((el.textContent || "").slice(0, 20));
    }
    return { overflow: overflow.slice(0, 5), black: black.slice(0, 5), scrollW: root.scrollWidth, clientW: root.clientWidth };
  });
  check(`${name}：无横向溢出`, r.overflow.length === 0 && r.scrollW <= r.clientW + 1, JSON.stringify(r.overflow));
  check(`${name}：没有未取主题色的纯黑文字`, r.black.length === 0, JSON.stringify(r.black));
}
const tab = (label) => page.click(`loc=role:tab[name='${label}']`);

// ---------------- 1. 矩阵：主题 × 布局 × 页面 ----------------
for (const layout of ["wide", "compact"]) {
  for (const theme of ["light", "dark"]) {
    const tag = `${layout}-${theme}`;
    await open(`scene=shadow&layout=${layout}&theme=${theme}&route=agent:agent-main`);
    await shot(`${tag}-chat`);
    await page.click("text=GitHub · 3 · 影子");
    await sleep(400);
    await shot(`${tag}-chat-popover`);
    await layoutChecks(`${tag} 胶囊弹出层`);

    await open(`scene=live&layout=${layout}&theme=${theme}&route=screen:main`);
    await shot(`${tag}-subs-by-repo`);
    await layoutChecks(`${tag} 订阅页（按仓库）`);
    await page.click("loc=role:tab[name='按会话']");
    await sleep(300);
    await shot(`${tag}-subs-by-session`);
    await layoutChecks(`${tag} 订阅页（按会话）`);
    await tab("事件");
    await sleep(300);
    await shot(`${tag}-events`);
    await layoutChecks(`${tag} 事件页`);
    await tab("监听状态");
    await sleep(300);
    await shot(`${tag}-status`);
    await layoutChecks(`${tag} 监听状态页`);

    await open(`scene=shadow&layout=${layout}&theme=${theme}&route=screen:settings`);
    await shot(`${tag}-settings`);
    await layoutChecks(`${tag} 设置页`);
  }
}
// 窄屏侧边栏抽屉
await open("scene=shadow&layout=compact&theme=light&route=agent:agent-main");
await page.click("[aria-label='打开侧边栏']");
await sleep(300);
await shot("compact-light-drawer");

// ---------------- 2. 空状态与错误状态 ----------------
await open("scene=empty&layout=wide&theme=light&route=screen:main");
await shot("wide-light-empty-subs");
check("空状态：订阅页提示还没有订阅", (await text()).includes("还没有会话订阅"));
await open("scene=empty&layout=wide&theme=light&route=agent:agent-main");
await shot("wide-light-empty-chat");
check("空状态：会话页没有 GitHub 胶囊", (await report()).pills.length === 0);

await open("scene=error&layout=wide&theme=light&route=screen:main");
await tab("监听状态");
await sleep(300);
await shot("wide-light-error-status");
let body = await text();
check("错误状态：显示仓库出错和注入工具未打开", body.includes("无权读取 Actions") && body.includes("未打开"));
await open("scene=error&layout=wide&theme=dark&route=screen:settings");
await shot("wide-dark-error-settings");
check("错误状态：设置页给出工具注入修复提示", (await text()).includes("给会话注入 MCP 工具"));

await open("scene=offline&layout=wide&theme=light&route=screen:main");
await sleep(500);
await shot("wide-light-offline");
check("离线：显示无法连接插件服务", (await text()).includes("无法连接插件服务"));
await open("scene=offline&layout=compact&theme=light&route=screen:main");
await shot("compact-light-offline");

// ---------------- 3. 流程：胶囊取消 + 跳转（GIF） ----------------
await open("scene=shadow&layout=wide&theme=light&route=agent:agent-main");
let rep = await report();
check("胶囊：主会话有胶囊，标签带数量和影子标记", rep.pillLabels[rep.pills.indexOf("agent-main:github")] === "GitHub · 3 · 影子", JSON.stringify(rep.pillLabels));
await frame("pill-cancel", "会话页：胶囊「GitHub · 3 · 影子」");
await page.click("text=GitHub · 3 · 影子");
await sleep(400);
await frame("pill-cancel", "点开胶囊：本会话 3 个订阅");
check("弹出层：影子模式提示可见", (await text()).includes("影子模式：事件只记日志"));
await page.click("[aria-label='取消订阅'] >> nth=0");
await sleep(500);
await frame("pill-cancel", "取消第 1 个订阅：胶囊变成 2");
rep = await report();
check("取消订阅：胶囊数字立即变成 2", rep.pillLabels[rep.pills.indexOf("agent-main:github")] === "GitHub · 2 · 影子", JSON.stringify(rep.pillLabels));
check("取消订阅：调用了删除接口", rep.rpc.some((line) => line.startsWith("subscriptions.remove")));
await page.click("[aria-label='取消订阅'] >> nth=0");
await sleep(500);
await page.click("[aria-label='取消订阅'] >> nth=0");
await sleep(600);
await frame("pill-cancel", "全部取消：弹出层提示没有订阅");
rep = await report();
check("全部取消：胶囊被移除", !rep.pills.includes("agent-main:github"), JSON.stringify(rep.pills));
check("全部取消：弹出层显示已没有订阅", (await text()).includes("这个会话已没有订阅"));
await page.click("[aria-label='关闭弹出层']");
await sleep(300);
await frame("pill-cancel", "关闭弹出层：输入框上方没有 GitHub 胶囊");
check("全部取消：会话页没有 GitHub 胶囊", !(await text()).includes("GitHub ·"));

await open("scene=shadow&layout=wide&theme=light&route=agent:agent-main");
await page.click("text=GitHub · 3 · 影子");
await sleep(400);
await frame("pill-jump", "点开胶囊");
await page.click("text=在 GitHub 订阅页查看全部");
await sleep(500);
await frame("pill-jump", "点「在 GitHub 订阅页查看全部」：跳到全局订阅页");
check("跳转：打开了全局订阅页", (await text()).includes("按仓库") && (await text()).includes("影子模式已开启"));
check("跳转：弹出层已关闭", !(await text()).includes("本会话的 GitHub 订阅"));
await page.click("[aria-label='打开会话'] >> nth=0");
await sleep(500);
await frame("pill-jump", "点某行「打开会话」：跳到该会话");
check("跳转：订阅行可以打开会话", (await text()).includes("已订阅这个 PR"));

// 两个会话（同一工作区、同一胶囊 id）各自独立
await open("scene=shadow&layout=wide&theme=light&route=agent:agent-main");
rep = await report();
check("两个会话：同工作区的主会话和界面稿会话各有一个胶囊", rep.pills.includes("agent-main:github") && rep.pills.includes("agent-ui:github"), JSON.stringify(rep.pills));
await frame("two-sessions", "主会话的胶囊：GitHub · 3 · 影子");
await page.click("text=GitHub · 3 · 影子");
await sleep(400);
const mainItems = await page.evaluate(() => document.querySelectorAll("[aria-label='取消订阅']").length);
const mainText = await text();
await frame("two-sessions", "主会话的弹出层：3 个订阅");
check("两个会话：主会话弹出层只有自己的 3 个订阅", mainItems === 3 && mainText.includes("sub2api"), `按钮 ${mainItems}`);
{
  // 点弹出层外面的空白处关闭（和真实用户一致）。
  const r = await clipRect();
  await page.mouse.click(r.x + 12 + 900, 120, { label: "点弹出层外空白处" });
}
await sleep(300);
await page.click("[aria-label='打开会话 【GitHub 订阅】界面稿']");
await sleep(500);
await frame("two-sessions", "切到界面稿会话：胶囊 GitHub · 2 · 影子");
await page.click("text=GitHub · 2 · 影子");
await sleep(400);
const uiItems = await page.evaluate(() => document.querySelectorAll("[aria-label='取消订阅']").length);
const uiText = await text();
await frame("two-sessions", "界面稿会话的弹出层：只有自己的 2 个订阅");
check("两个会话：界面稿会话弹出层只有自己的 2 个订阅", uiItems === 2 && uiText.includes("deepseek-harness#1702") && !uiText.includes("sub2api"), `按钮 ${uiItems}`);

// 窄屏：底部面板 + 取消
await open("scene=shadow&layout=compact&theme=light&route=agent:agent-main");
await frame("compact-sheet", "窄屏会话页");
await page.click("text=GitHub · 3 · 影子");
await sleep(400);
await frame("compact-sheet", "窄屏：胶囊变成底部面板");
await page.click("[aria-label='取消订阅'] >> nth=0");
await sleep(500);
await frame("compact-sheet", "窄屏取消一个订阅");
check("窄屏：面板内取消订阅有效", (await report()).pillLabels.includes("GitHub · 2 · 影子"));

// ---------------- 4. 页面取消 → 胶囊同步 ----------------
await open("scene=shadow&layout=wide&theme=light&route=screen:main");
await page.click("loc=role:tab[name='按会话']");
await sleep(300);
await frame("page-cancel", "订阅页（按会话）");
await page.click("[aria-label='取消订阅'] >> nth=0");
await sleep(500);
await frame("page-cancel", "取消主会话的第 1 个订阅");
await page.click("[aria-label='打开会话 【GitHub 订阅】主会话']");
await sleep(500);
await frame("page-cancel", "回到主会话：胶囊数量已同步");
rep = await report();
check("页面取消订阅后，胶囊数量同步", rep.pillLabels[rep.pills.indexOf("agent-main:github")] === "GitHub · 2 · 影子", JSON.stringify(rep.pillLabels));

// ---------------- 5. 令牌输入：密文、清空、不泄露 ----------------
await open("scene=shadow&layout=wide&theme=light&route=screen:settings");
const SECRET = "github_pat_11ZZsecretvalue987654";
check("令牌前缀只带一个省略号（服务端前缀已含 …）", (await text()).includes("githu…（已保存）") && !(await text()).includes("……"));
const inputType = await page.evaluate(() => [...document.querySelectorAll("input")].filter((i) => i.placeholder.includes("令牌")).map((i) => i.type));
check("令牌输入框是密文类型（password）", inputType.length === 1 && inputType[0] === "password", JSON.stringify(inputType));
await page.fill("input[type=password]", SECRET);
await frame("token", "输入令牌：输入框是密文");
await page.click("[aria-label='更换令牌']");
await sleep(700);
await frame("token", "保存成功：输入框清空，只显示前缀和账号");
const afterSave = await page.evaluate(() => ({ value: document.querySelector("input[type=password]").value, html: document.documentElement.outerHTML, text: document.body.innerText }));
check("令牌保存后输入框已清空", afterSave.value === "");
check("令牌保存后页面不含令牌", !afterSave.html.includes(SECRET) && !afterSave.text.includes(SECRET));
rep = await report();
const logs = await page.evaluate(() => window.__ghsub.consoleLog.join("\n"));
check("令牌不在控制台日志里", !logs.includes(SECRET));
check("令牌调用记录只含长度", rep.rpc.some((l) => l.includes("token(") ) && !rep.rpc.join("\n").includes(SECRET), rep.rpc.filter((l) => l.includes("token")).join("|"));
await page.fill("input[type=password]", "bad-token-abcdef123");
await page.click("[aria-label='更换令牌']");
await sleep(700);
await frame("token", "保存失败：错误文字里令牌已替换成 ***");
const failText = await text();
check("令牌保存失败：错误文字不含令牌且已脱敏", !failText.includes("bad-token-abcdef123") && failText.includes("***"));
await page.click("[aria-label='移除令牌']");
await sleep(700);
await frame("token", "移除令牌：提示还没有保存令牌");
check("移除令牌后显示未保存", (await text()).includes("还没有保存令牌"));

// ---------------- 6. 设置保存：影子模式、校验 ----------------
await open("scene=shadow&layout=wide&theme=light&route=screen:settings");
await frame("settings", "设置页：影子模式开启中");
await page.click("loc=role:switch[name='影子模式']");
await sleep(300);
await frame("settings", "关闭影子模式：出现立即发送的警告，保存按钮可用");
check("设置：关闭影子模式后出现警告", (await text()).includes("订阅的会话会立即收到消息"));
await page.fill("input[placeholder='组织名']", "bad org!", { clearFirst: true });
await sleep(200);
await frame("settings", "组织名不合法：提示并禁用保存");
check("设置：非法组织名提示错误", (await text()).includes("组织名只能包含字母、数字和连字符"));
await page.fill("input[placeholder='组织名']", "fliggy-travel-ai", { clearFirst: true });
await page.fill("input[placeholder='仓库名，例如 rea']", "scratch");
await page.click("[aria-label='添加'] >> nth=0");
await sleep(200);
await page.click("[aria-label='保存设置']");
await sleep(700);
await frame("settings", "保存设置：提示已保存");
const prefs = await page.evaluate(() => window.__ghsub.daemon.state.preferences);
check("设置：保存写入了假守护进程", prefs.shadow === false && prefs.excludedRepos.includes("scratch"), JSON.stringify({ shadow: prefs.shadow, excluded: prefs.excludedRepos }));
await page.click("[aria-label='返回订阅页']");
await sleep(400);
check("设置：保存后订阅页显示实际发送", (await text()).includes("送达方式：实际发送"));

// ---------------- 7. 5 秒刷新与清理 ----------------
await open("scene=shadow&layout=wide&theme=light&route=agent:agent-main");
const before = (await report()).pillLabels.length;
await page.evaluate(() => {
  const d = window.__ghsub.daemon;
  d.state = { ...d.state, subscriptions: d.state.subscriptions.filter((s) => s.agentId !== "agent-main") };
});
await sleep(5600);
rep = await report();
check("定时刷新：页面没打开时胶囊也随数据变化（主会话胶囊被移除）", !rep.pills.includes("agent-main:github") && rep.pills.length === before - 1, JSON.stringify(rep.pills));
const pollCount = rep.rpc.filter((l) => l.startsWith("subscriptions.snapshot")).length;
check("定时刷新：只有一个定时器（5.6 秒内最多 3 次 snapshot）", pollCount <= 3, `snapshot 次数 ${pollCount}`);
await page.evaluate(() => window.__ghsub.dispose());
await sleep(300);
rep = await report();
const n0 = rep.rpc.length;
check("清理：胶囊、页面、侧边栏全部移除", rep.pills.length === 0 && rep.screens.length === 0 && rep.sidebar.length === 0, JSON.stringify({ pills: rep.pills, screens: rep.screens, sidebar: rep.sidebar }));
await sleep(5600);
check("清理：停掉后不再轮询", (await report()).rpc.length === n0, `${n0} → ${(await report()).rpc.length}`);

await fs.writeFile(`${OUT}/results.json`, JSON.stringify({ results, labels }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
