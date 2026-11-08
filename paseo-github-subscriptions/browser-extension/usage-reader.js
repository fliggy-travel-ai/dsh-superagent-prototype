(() => {
  const PAIR_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/sync$/;
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function readDialog() {
    const root = document.querySelector('[data-testid="usage-page-pace"]');
    const rows = [...(root?.querySelectorAll('[role="meter"]') ?? [])].map(meter => {
      let row = meter;
      for (let i = 0; i < 6 && row.parentElement && !/Resets /.test(row.textContent); i++) row = row.parentElement;
      return { label: document.getElementById(meter.getAttribute('aria-labelledby'))?.textContent?.trim() ?? '', used: meter.getAttribute('aria-valuenow'), valueText: meter.getAttribute('aria-valuetext') ?? '', reset: row.textContent.match(/Resets (?:at )?[A-Za-z]*\s?\d{1,2}:\d{2} [AP]M/)?.[0] ?? null };
    });
    return { path: location.pathname, title: document.title, rows, now: Date.now(), tzOffset: new Date().getTimezoneOffset() };
  }

  function isUsageUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://claude.ai') return false;
      if (/^\/settings\/usage\/?$/.test(url.pathname)) return true;
      if (/^\/new\/?$/.test(url.pathname) && url.hash.startsWith('#settings/usage')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function isLoginUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://claude.ai' && url.pathname.startsWith('/login');
    } catch {
      return false;
    }
  }

  function parseReset(text, now, tzOffset) {
    if (typeof text !== 'string' || !Number.isFinite(now) || !Number.isFinite(tzOffset)) return null;
    const match = text.trim().match(/^Resets\s+(?:at\s+|(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+)(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    const dayName = match[1]?.toLowerCase() ?? null;
    const hour12 = Number(match[2]);
    const minute = Number(match[3]);
    const meridiem = match[4].toUpperCase();
    if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
    const hour24 = (hour12 % 12) + (meridiem === 'PM' ? 12 : 0);
    const offsetMs = tzOffset * 60_000;
    const localNowMs = now - offsetMs;
    const localNow = new Date(localNowMs);
    const year = localNow.getUTCFullYear();
    const month = localNow.getUTCMonth();
    const date = localNow.getUTCDate();
    let targetLocalMs;
    if (dayName) {
      const targetDay = DAYS.indexOf(dayName);
      const diffDays = (targetDay - localNow.getUTCDay() + 7) % 7;
      targetLocalMs = Date.UTC(year, month, date + diffDays, hour24, minute, 0, 0);
      if (targetLocalMs <= localNowMs) targetLocalMs += 7 * 86_400_000;
    } else {
      targetLocalMs = Date.UTC(year, month, date, hour24, minute, 0, 0);
      if (targetLocalMs <= localNowMs) targetLocalMs += 86_400_000;
    }
    return new Date(targetLocalMs + offsetMs).toISOString();
  }

  function parseWindowRow(row, nowMs, tzOffset, observedAt) {
    if (!row || typeof row.valueText !== 'string' || !/\bused\b/i.test(row.valueText)) return null;
    if (row.used === null || row.used === undefined || String(row.used).trim() === '') return null;
    const usedPct = Number(row.used);
    if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) return null;
    const resetsAt = typeof row.reset === 'string' ? parseReset(row.reset, nowMs, tzOffset) : null;
    return { usedPct, resetsAt, observedAt };
  }

  function parseDialog(data) {
    if (!data || !Array.isArray(data.rows)) return null;
    const nowMs = Number.isFinite(data.now) ? data.now : Date.now();
    const tzOffset = Number.isFinite(data.tzOffset) ? data.tzOffset : 0;
    const observedAt = new Date(nowMs).toISOString();
    const sessionRow = data.rows.find(row => row?.label === 'Current session');
    const weekRow = data.rows.find(row => row?.label === 'This week');
    const fiveHour = parseWindowRow(sessionRow, nowMs, tzOffset, observedAt);
    const weekly = parseWindowRow(weekRow, nowMs, tzOffset, observedAt);
    if (!fiveHour || !weekly) return null;
    return { observedAt, fiveHour, weekly };
  }

  async function readUsagePage(state) {
    let tabId = null;
    if (typeof state.tab?.id === 'number') {
      try {
        const existing = await chrome.tabs.get(state.tab.id);
        if (existing && typeof existing.id === 'number' && isUsageUrl(existing.url)) {
          await chrome.tabs.reload(existing.id);
          tabId = existing.id;
        }
      } catch {}
      if (tabId === null) {
        delete state.tab;
        await chrome.storage.local.set({ usageState: state });
      }
    }
    if (tabId === null) {
      let windows = [];
      try {
        windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      } catch {
        windows = [];
      }
      if (!Array.isArray(windows) || windows.length === 0) {
        return { status: 'failed', reason: 'no_window', observedAt: new Date(Date.now()).toISOString() };
      }
      let created;
      try {
        created = await chrome.tabs.create({ url: 'https://claude.ai/settings/usage', active: false });
      } catch {
        return { status: 'failed', reason: 'tab_closed', observedAt: new Date(Date.now()).toISOString() };
      }
      if (typeof created?.id !== 'number') {
        return { status: 'failed', reason: 'tab_closed', observedAt: new Date(Date.now()).toISOString() };
      }
      tabId = created.id;
      state.tab = { id: tabId, openedAt: Date.now() };
      await chrome.storage.local.set({ usageState: state });
    }

    let sawRows = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000));
      let currentTab;
      try {
        currentTab = await chrome.tabs.get(tabId);
      } catch {
        currentTab = null;
      }
      if (!currentTab || (currentTab.url && !isUsageUrl(currentTab.url) && !isLoginUrl(currentTab.url))) {
        delete state.tab;
        return { status: 'failed', reason: 'tab_closed', observedAt: new Date(Date.now()).toISOString() };
      }
      let results;
      try {
        results = await chrome.scripting.executeScript({ target: { tabId }, func: readDialog });
      } catch {
        delete state.tab;
        return { status: 'failed', reason: 'tab_closed', observedAt: new Date(Date.now()).toISOString() };
      }
      const pageData = Array.isArray(results) ? results[0]?.result : undefined;
      if (!pageData || typeof pageData !== 'object') continue;
      const observedAt = Number.isFinite(pageData.now) ? new Date(pageData.now).toISOString() : new Date(Date.now()).toISOString();
      if (typeof pageData.path === 'string' && pageData.path.startsWith('/login')) {
        return { status: 'signed_out', observedAt };
      }
      if (typeof pageData.title === 'string' && pageData.title.includes('Just a moment')) {
        return { status: 'failed', reason: 'challenge', observedAt };
      }
      const parsed = parseDialog(pageData);
      if (parsed) {
        return { status: 'ok', ...parsed };
      }
      if (Array.isArray(pageData.rows) && pageData.rows.length > 0) {
        sawRows = true;
      }
    }
    return { status: 'failed', reason: sawRows ? 'parse' : 'timeout', observedAt: new Date(Date.now()).toISOString() };
  }

  let running = null;

  async function runTick() {
    const data = await chrome.storage.local.get(['instanceId', 'instanceName', 'pairing', 'usageState']);
    const pairing = data.pairing;
    const match = typeof pairing?.url === 'string' && pairing.url.match(PAIR_RE);
    if (!pairing || !match || Number(match[1]) > 65535 || !/^[a-f0-9]{64}$/.test(pairing?.token || '')) return;
    let instanceId = typeof data.instanceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.instanceId) ? data.instanceId : '';
    if (!instanceId) {
      instanceId = crypto.randomUUID();
      await chrome.storage.local.set({ instanceId });
    }
    const instanceName = typeof data.instanceName === 'string' && data.instanceName.trim() ? data.instanceName.trim().slice(0, 120) : '未命名浏览器环境';
    const rawState = data.usageState && typeof data.usageState === 'object' ? data.usageState : {};
    const state = {
      nextReadAt: typeof rawState.nextReadAt === 'number' ? rawState.nextReadAt : 0,
      failures: typeof rawState.failures === 'number' ? rawState.failures : 0,
      fiveHour: rawState.fiveHour ?? null,
      weekly: rawState.weekly ?? null,
      status: ['pending', 'ok', 'signed_out', 'failed'].includes(rawState.status) ? rawState.status : 'pending',
      ...(rawState.reason ? { reason: rawState.reason } : {}),
      observedAt: typeof rawState.observedAt === 'string' ? rawState.observedAt : new Date(Date.now()).toISOString(),
      ...(rawState.tab && typeof rawState.tab.id === 'number' ? { tab: { id: rawState.tab.id, openedAt: rawState.tab.openedAt ?? Date.now() } } : {}),
    };

    const now = Date.now();
    if (now >= state.nextReadAt) {
      const outcome = await readUsagePage(state);
      const readNow = Date.now();
      state.observedAt = outcome.observedAt || new Date(readNow).toISOString();
      if (outcome.status === 'ok') {
        state.status = 'ok';
        delete state.reason;
        state.failures = 0;
        state.fiveHour = outcome.fiveHour;
        state.weekly = outcome.weekly;
        state.nextReadAt = readNow + 10 * 60_000;
      } else if (outcome.status === 'signed_out') {
        state.status = 'signed_out';
        delete state.reason;
        state.nextReadAt = readNow + 30 * 60_000;
      } else {
        state.status = 'failed';
        state.reason = outcome.reason;
        state.failures = Math.min(3, (state.failures || 0) + 1);
        state.nextReadAt = readNow + state.failures * 20 * 60_000;
      }
      await chrome.storage.local.set({ usageState: state });
    }

    const usageUrl = pairing.url.replace(/\/sync$/, '/usage');
    const body = {
      instanceId,
      instanceName,
      status: state.status,
      ...(state.status === 'failed' && state.reason ? { reason: state.reason } : {}),
      observedAt: state.observedAt,
      fiveHour: state.fiveHour,
      weekly: state.weekly,
    };
    try {
      await fetch(usageUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${pairing.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
        credentials: 'omit',
      });
    } catch {}
  }

  function tick() {
    if (running) return running;
    running = runTick().catch(() => {}).finally(() => { running = null; });
    return running;
  }

  globalThis.paseoUsage = { readDialog, parseReset, parseDialog, isUsageUrl, tick };

  if (typeof chrome !== 'undefined' && chrome?.alarms) {
    chrome.alarms.create('usage', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm?.name === 'usage') void tick(); });
    void tick();
  }
})();
