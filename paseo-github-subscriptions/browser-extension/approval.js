(() => {
  if (globalThis.__paseoApprovalInstalled) return;
  globalThis.__paseoApprovalInstalled = true;
  const APPROVAL_INITIAL_DELAY_MS = 800;
  const APPROVAL_OBSERVE_DELAY_MS = 1500;
  const APPROVAL_RETRY_INTERVAL_MS = 5000;
  const APPROVAL_MAX_RETRY_DURATION_MS = 3 * 60 * 1000;
  const APPROVAL_MAX_CLICKS_PER_CARD = 36;
  const APPROVAL_HISTORY_TTL_MS = 10 * 60 * 1000;
  const APPROVAL_HISTORY_MAX_ENTRIES = 200;
  const numCfg = (key, fallback, min = 0) => {
    const raw = globalThis.__paseoApprovalConfig?.[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= min ? raw : fallback;
  };
  const initialDelayMs = () => numCfg('initialDelayMs', APPROVAL_INITIAL_DELAY_MS, 0);
  const observeDelayMs = () => numCfg('observeDelayMs', APPROVAL_OBSERVE_DELAY_MS, 1);
  const retryIntervalMs = () => numCfg('retryIntervalMs', APPROVAL_RETRY_INTERVAL_MS, 1);
  const maxRetryDurationMs = () => numCfg('maxRetryDurationMs', APPROVAL_MAX_RETRY_DURATION_MS, 1);
  const maxClicksPerCard = () => numCfg('maxClicksPerCard', APPROVAL_MAX_CLICKS_PER_CARD, 1);
  const pageVisible = () => (document.visibilityState || 'visible') === 'visible';

  let enabled = false;
  let queued = false;
  let busy = false;
  const initializedCards = new WeakMap();
  const cardHistory = new Map();
  const label = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().replace(/\s*(?:[⌘⏎⌃⌥⇧⎋↵]+|\b(?:Ctrl|Command|Enter|Esc|Shift|Tab)\b).*$/i, '').trim();
  const visible = element => {
    if (element.isConnected === false) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const deny = /^(?:deny|deny all|decline|reject|cancel|拒绝|取消|不允许)$/i;
  const once = /^(?:allow once|allow just this once|yes, allow once|允许一次|只允许一次)$/i;
  const allow = /^(?:allow|允许)$/i;
  const permission = /(?:permission|allow claude|授权|权限|允许 Claude)/i;
  const permanent = /always|don't ask again|do not ask again|remember|this session|始终|不再询问|记住|本次会话/i;
  function triggerApprovalClick(target) {
    target.click();
  }
  // 阅读门槛：claude.ai 部分权限卡片要求先把参数区滚到底（提示“Scroll to the end to allow this.”），
  // 否则点“允许”无效。用户决定（#1704 评论 6732392628）：对原本就会自动批准的卡片先滚到底，提示消失后再点。
  const READ_GATE_TEXT = /scroll to the end to allow/i;
  const READ_GATE_SETTLE_MS = 300;
  function readGateHint(scope) {
    const root = getCardRoot(scope);
    const hint = root?.querySelector?.('[data-testid="approval-read-hint"]');
    return hint && visible(hint) && READ_GATE_TEXT.test(hint.innerText || hint.textContent || '') ? hint : null;
  }
  async function passReadGate(scope) {
    const root = getCardRoot(scope);
    for (const node of [root, ...(root?.querySelectorAll?.('*') || [])]) {
      if (!(node?.scrollHeight - node?.clientHeight > 1)) continue;
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent?.(new Event('scroll'));
    }
    const rows = [...(root?.querySelectorAll?.('[data-testid="approval-read-rows"] li') || [])];
    rows.at(-1)?.scrollIntoView?.({ block: 'end' });
    await new Promise(resolve => setTimeout(resolve, READ_GATE_SETTLE_MS));
    return !readGateHint(scope);
  }
  function pruneCardHistory(now = Date.now()) {
    const ttl = Math.max(APPROVAL_HISTORY_TTL_MS, maxRetryDurationMs() * 2);
    for (const [key, state] of cardHistory) {
      if (now - (state.lastObservedAt || state.firstAttemptAt || 0) > ttl) {
        cardHistory.delete(key);
      }
    }
    while (cardHistory.size > APPROVAL_HISTORY_MAX_ENTRIES) {
      const oldestKey = cardHistory.keys().next().value;
      if (oldestKey === undefined) break;
      cardHistory.delete(oldestKey);
    }
  }
  function getCardRoot(scope) {
    return scope?.closest?.('[data-approval-card-root]') || scope;
  }
  function getCardAriaLabel(scope) {
    const root = getCardRoot(scope);
    return (root?.getAttribute?.('aria-label') || scope?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  }
  function clearCardId(scope) {
    const root = getCardRoot(scope);
    if (!root || typeof root !== 'object') return;
    initializedCards.delete(root);
    if (typeof root.removeAttribute === 'function') {
      root.removeAttribute('data-ddev-card-id');
      root.removeAttribute('data-ddev-card-label');
    } else if (typeof root.setAttribute === 'function') {
      root.setAttribute('data-ddev-card-id', '');
      root.setAttribute('data-ddev-card-label', '');
    }
  }
  function ensureCardId(scope) {
    const root = getCardRoot(scope);
    if (typeof root?.getAttribute !== 'function' || typeof root?.setAttribute !== 'function') return '';
    const currentLabel = getCardAriaLabel(scope);
    let id = (root.getAttribute('data-ddev-card-id') || '').trim();
    const savedLabel = (root.getAttribute('data-ddev-card-label') || '').trim();
    const labelChanged = Boolean(currentLabel && savedLabel && currentLabel !== savedLabel);
    const prevDismissed = Boolean(id && cardHistory.get(id)?.status === 'dismissed');
    if (!id || labelChanged || prevDismissed) {
      id = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      root.setAttribute('data-ddev-card-id', id);
      if (currentLabel) root.setAttribute('data-ddev-card-label', currentLabel);
      initializedCards.delete(root);
    } else if (currentLabel && !savedLabel) {
      root.setAttribute('data-ddev-card-label', currentLabel);
    }
    return id;
  }
  async function sha256Hex(input) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  async function buildCardFingerprint(currentPath, scope, text) {
    const cardId = ensureCardId(scope);
    const ariaLabel = getCardAriaLabel(scope);
    const digest = await sha256Hex(`v2\n${currentPath}\n${cardId}\n${ariaLabel}\n${text}`);
    const labelSource = ariaLabel || text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const labelDigest = labelSource ? await sha256Hex(`v2-label\n${currentPath}\n${labelSource}`) : '';
    return { digest, cardId, ariaLabel, labelDigest };
  }
  function canAttemptCard(cardId, buttonLabel) {
    if (!pageVisible()) return false;
    if (!cardId) return true;
    const state = cardHistory.get(cardId);
    if (!state) return true;
    const now = Date.now();
    if (state.rejectedUntil && now < state.rejectedUntil) return false;
    if (state.status === 'dismissed' || state.status === 'reserved') return false;
    if (state.clicks >= maxClicksPerCard()) return false;
    if (state.status === 'still-visible' || state.status === 'skipped') {
      if (!once.test(buttonLabel)) return false;
      if (now - state.lastObservedAt < retryIntervalMs()) return false;
      if (now - state.firstAttemptAt > maxRetryDurationMs()) return false;
    }
    return true;
  }
  function recordCardRejected(cardId) {
    if (!cardId) return;
    const now = Date.now();
    pruneCardHistory(now);
    const prev = cardHistory.get(cardId);
    cardHistory.set(cardId, {
      clicks: prev?.clicks || 0,
      firstAttemptAt: prev?.firstAttemptAt ?? now,
      lastObservedAt: prev?.lastObservedAt ?? now,
      pendingVisibilityReset: prev?.pendingVisibilityReset || false,
      status: prev?.status || 'rejected',
      rejectedUntil: now + retryIntervalMs(),
    });
  }
  function recordCardAttempt(cardId) {
    if (!cardId) return;
    const now = Date.now();
    pruneCardHistory(now);
    const prev = cardHistory.get(cardId);
    cardHistory.set(cardId, {
      clicks: (prev?.clicks || 0) + 1,
      firstAttemptAt: prev?.pendingVisibilityReset ? now : (prev?.firstAttemptAt ?? now),
      lastObservedAt: prev?.lastObservedAt ?? now,
      pendingVisibilityReset: false,
      status: 'reserved',
      rejectedUntil: 0,
    });
  }
  function recordCardResult(cardId, status) {
    if (!cardId) return;
    const now = Date.now();
    const prev = cardHistory.get(cardId);
    if (!prev) return;
    prev.status = status;
    prev.lastObservedAt = now;
  }
  function cardSafe(scope, text) {
    if (scope.querySelector?.('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"],[role="switch"][aria-checked="true"],[aria-pressed="true"]')) return false;
    if (scope.querySelector?.('input[type="radio"],[role="radio"],[role="radiogroup"],select,[role="listbox"]')) return false;
    const heading = scope.querySelector?.('h1,h2,h3,[role="heading"]')?.textContent || text.slice(0, 200);
    if (/\bplan\b|\bproceed\b|计划|方案确认/i.test(heading)) return false;
    if (/AskUserQuestion|ExitPlanMode|\(Recommended\)|\(推荐\)|请选择|Which option|Choose an answer/i.test(text)) return false;
    return true;
  }
  function eligible(button, scope, text) {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !visible(button) || !cardSafe(scope, text)) return false;
    const peers = [...(scope.querySelectorAll?.('button,[role="button"]') || [])].filter(visible);
    if (!peers.some(peer => deny.test(label(peer)))) return false;
    const heading = scope.querySelector?.('h1,h2,h3,[role="heading"]')?.textContent || text.slice(0, 200);
    return once.test(label(button)) || (allow.test(label(button)) && permission.test(heading) && !permanent.test(text));
  }
  function menuCardEligible(moreButton, card, text) {
    if (!card || !card.isConnected || !visible(card) || card.getAttribute?.('role') !== 'group') return false;
    if (!/^Permission request:/i.test((card.getAttribute?.('aria-label') || '').trim())) return false;
    if (text.length > 16000 || !cardSafe(card, text)) return false;
    if (!moreButton || !moreButton.isConnected || moreButton.disabled || moreButton.getAttribute?.('aria-disabled') === 'true' || !visible(moreButton)) return false;
    if ((moreButton.getAttribute?.('aria-label') || '').trim() !== 'More allow options') return false;
    if (permanent.test(label(moreButton)) || deny.test(label(moreButton))) return false;
    const peers = [...(card.querySelectorAll?.('button,[role="button"]') || [])].filter(visible);
    if (peers.some(peer => once.test(label(peer))) || !peers.some(peer => deny.test(label(peer)))) return false;
    return true;
  }
  function hasVisibleMenu(moreButton) {
    const buttonId = (moreButton?.getAttribute?.('id') || '').trim();
    if (!buttonId) return false;
    return [...(document.querySelectorAll?.('[role="menu"]') || [])].some(
      menu => (menu.getAttribute?.('aria-labelledby') || '').trim() === buttonId && visible(menu),
    );
  }
  function closeMenu(moreButton) {
    if (moreButton?.isConnected && visible(moreButton) && hasVisibleMenu(moreButton)) {
      triggerApprovalClick(moreButton);
    }
  }
  function findAllowOnceMenuItem(moreButton) {
    const buttonId = (moreButton?.getAttribute?.('id') || '').trim();
    if (!buttonId) return null;
    const menus = [...(document.querySelectorAll?.('[role="menu"]') || [])].filter(
      menu => (menu.getAttribute?.('aria-labelledby') || '').trim() === buttonId && visible(menu),
    );
    const items = menus.flatMap(menu => [...(menu.querySelectorAll?.('[role="menuitem"]') || [])]).filter(
      item => !item.disabled && item.getAttribute?.('aria-disabled') !== 'true' && visible(item),
    );
    return items.find(item => label(item) === 'Allow once') || null;
  }
  async function clickOnce(button, scope, text) {
    busy = true;
    try {
      const currentPath = location.pathname;
      const root = getCardRoot(scope);
      const cardId = ensureCardId(scope);
      const buttonLabel = label(button);
      if (!canAttemptCard(cardId, buttonLabel)) return;
      const resetRetryWindow = Boolean(cardId && cardHistory.get(cardId)?.pendingVisibilityReset);
      if ((root && typeof root === 'object' && !initializedCards.has(root)) || resetRetryWindow) {
        const delay = initialDelayMs();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (!enabled || !pageVisible() || currentPath !== location.pathname || scope.isConnected === false || !button.isConnected || !visible(button)) return;
        if (ensureCardId(scope) !== cardId) return;
        text = scope.innerText || scope.textContent || '';
        if (label(button) !== buttonLabel || !eligible(button, scope, text)) return;
        if (root && typeof root === 'object') initializedCards.set(root, true);
      }
      if (!canAttemptCard(cardId, buttonLabel)) return;
      const { digest, labelDigest } = await buildCardFingerprint(currentPath, scope, text);
      const reservation = await chrome.runtime.sendMessage({
        type: 'approval-reserve',
        digest,
        ...(cardId ? { cardId } : {}),
        ...(labelDigest ? { labelDigest } : {}),
        ...(resetRetryWindow ? { resetRetryWindow: true } : {}),
        button: buttonLabel,
      });
      if (!reservation?.allowed) {
        if (cardId) {
          recordCardRejected(cardId);
          schedule();
        }
        return;
      }
      const report = (status, readGate) => chrome.runtime.sendMessage({ type: 'approval-result', digest, reservationId: reservation.reservationId, status, ...(readGate ? { readGate } : {}) });
      if (!enabled || !pageVisible() || currentPath !== location.pathname || scope.isConnected === false || !button.isConnected || ensureCardId(scope) !== cardId || label(button) !== buttonLabel || (scope.innerText || scope.textContent || '') !== text || !eligible(button, scope, text)) {
        recordCardAttempt(cardId);
        recordCardResult(cardId, 'skipped');
        await report('skipped');
        return;
      }
      let readGate;
      if (readGateHint(scope)) {
        const passed = await passReadGate(scope);
        if (!passed || !enabled || !pageVisible() || currentPath !== location.pathname || scope.isConnected === false || !button.isConnected || !visible(button) || button.disabled || ensureCardId(scope) !== cardId || label(button) !== buttonLabel) {
          recordCardAttempt(cardId);
          recordCardResult(cardId, 'skipped');
          await report('skipped', 'read_gate_blocked');
          if (pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) setTimeout(schedule, retryIntervalMs());
          return;
        }
        // 滚动期间卡片可能继续流式更新：按新文字重做完整资格复核（含 cardSafe 敏感判断）。
        const latest = scope.innerText || scope.textContent || '';
        if (latest.length > 16000 || !eligible(button, scope, latest)) {
          recordCardAttempt(cardId);
          recordCardResult(cardId, 'skipped');
          await report('skipped');
          return;
        }
        readGate = 'read_gate_scrolled';
      }
      recordCardAttempt(cardId);
      triggerApprovalClick(button);
      await new Promise(resolve => setTimeout(resolve, observeDelayMs()));
      const status = scope.isConnected === false || !button.isConnected || !visible(button) ? 'dismissed' : 'still-visible';
      recordCardResult(cardId, status);
      if (status === 'dismissed') clearCardId(scope);
      await report(status, readGate);
      if (status === 'still-visible' && pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) {
        setTimeout(schedule, retryIntervalMs());
      }
    } catch {} finally { busy = false; }
  }
  async function clickMenuOnce(moreButton, card, text) {
    busy = true;
    try {
      const currentPath = location.pathname;
      const cardId = ensureCardId(card);
      if (!canAttemptCard(cardId, 'Allow once')) return;
      const resetRetryWindow = Boolean(cardId && cardHistory.get(cardId)?.pendingVisibilityReset);
      if ((card && typeof card === 'object' && !initializedCards.has(card)) || resetRetryWindow) {
        const delay = initialDelayMs();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (!enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected || !moreButton.isConnected || !visible(moreButton)) return;
        if (ensureCardId(card) !== cardId) return;
        text = card.innerText || card.textContent || '';
        if (!menuCardEligible(moreButton, card, text)) return;
        if (card && typeof card === 'object') initializedCards.set(card, true);
      }
      if (!canAttemptCard(cardId, 'Allow once')) return;
      const { digest, labelDigest } = await buildCardFingerprint(currentPath, card, text);
      const reservation = await chrome.runtime.sendMessage({
        type: 'approval-reserve',
        digest,
        ...(cardId ? { cardId } : {}),
        ...(labelDigest ? { labelDigest } : {}),
        ...(resetRetryWindow ? { resetRetryWindow: true } : {}),
        button: 'Allow once',
      });
      if (!reservation?.allowed) {
        if (cardId) {
          recordCardRejected(cardId);
          schedule();
        }
        return;
      }
      const report = (status, readGate) => chrome.runtime.sendMessage({ type: 'approval-result', digest, reservationId: reservation.reservationId, status, ...(readGate ? { readGate } : {}) });
      if (!enabled || !pageVisible() || currentPath !== location.pathname || ensureCardId(card) !== cardId || (card.innerText || card.textContent || '') !== text || !menuCardEligible(moreButton, card, text)) {
        recordCardAttempt(cardId);
        recordCardResult(cardId, 'skipped');
        await report('skipped');
        return;
      }
      let readGate;
      if (readGateHint(card)) {
        const passed = await passReadGate(card);
        if (!passed || !enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected || !moreButton.isConnected || !visible(moreButton) || ensureCardId(card) !== cardId) {
          recordCardAttempt(cardId);
          recordCardResult(cardId, 'skipped');
          await report('skipped', 'read_gate_blocked');
          if (pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) setTimeout(schedule, retryIntervalMs());
          return;
        }
        const latest = card.innerText || card.textContent || '';
        if (!menuCardEligible(moreButton, card, latest)) {
          recordCardAttempt(cardId);
          recordCardResult(cardId, 'skipped');
          await report('skipped');
          return;
        }
        readGate = 'read_gate_scrolled';
      }
      triggerApprovalClick(moreButton);
      let item = findAllowOnceMenuItem(moreButton);
      if (!item) {
        await new Promise(resolve => setTimeout(resolve, 50));
        item = findAllowOnceMenuItem(moreButton);
      }
      if (!item || label(item) !== 'Allow once' || !enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected || ensureCardId(card) !== cardId) {
        closeMenu(moreButton);
        recordCardAttempt(cardId);
        recordCardResult(cardId, 'skipped');
        await report('skipped');
        if (pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) {
          setTimeout(schedule, retryIntervalMs());
        }
        return;
      }
      recordCardAttempt(cardId);
      triggerApprovalClick(item);
      await new Promise(resolve => setTimeout(resolve, observeDelayMs()));
      const status = !card.isConnected || !visible(card) || !moreButton.isConnected || !visible(moreButton) ? 'dismissed' : 'still-visible';
      recordCardResult(cardId, status);
      if (status === 'dismissed') clearCardId(card);
      await report(status, readGate);
      if (status === 'still-visible' && pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) {
        setTimeout(schedule, retryIntervalMs());
      }
    } catch {} finally { busy = false; }
  }
  function scan() {
    queued = false;
    if (busy || !enabled || !pageVisible() || location.origin !== 'https://claude.ai' || !/^\/code\/session_[A-Za-z0-9_-]+\/?$/.test(location.pathname)) return;
    for (const tagged of document.querySelectorAll?.('[data-ddev-card-id]') || []) {
      if (tagged?.getAttribute?.('data-ddev-card-id') && !visible(tagged)) clearCardId(tagged);
    }
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const candidates = buttons.filter(button => once.test(label(button)) || allow.test(label(button))).sort((left, right) => Number(once.test(label(right))) - Number(once.test(label(left))));
    for (const button of candidates) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('a,p,pre,code,blockquote,aside,[role="radiogroup"]')) continue;
      const cardRoot = button.closest('[data-approval-card-root]');
      const dialog = cardRoot || button.closest('[role="dialog"],dialog,form');
      let scope = dialog || button.parentElement;
      for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
        if (scope === document.body) break;
        const text = scope.innerText || scope.textContent || '';
        if (text.length > 16000 || /AskUserQuestion|ExitPlanMode|\(Recommended\)|\(推荐\)|请选择|Which option|Choose an answer/i.test(text)) break;
        const peers = [...scope.querySelectorAll('button,[role="button"]')].filter(visible);
        if (!peers.some(peer => deny.test(label(peer)))) { if (dialog) break; continue; }
        if (!eligible(button, scope, text)) break;
        const cardId = ensureCardId(scope);
        if (!canAttemptCard(cardId, label(button))) break;
        void clickOnce(button, scope, text);
        return;
      }
    }
    const cards = [...(document.querySelectorAll('[data-approval-card-root]') || [])].filter(
      card => card.getAttribute?.('role') === 'group' && /^Permission request:/i.test((card.getAttribute?.('aria-label') || '').trim()) && visible(card),
    );
    for (const card of cards) {
      const text = card.innerText || card.textContent || '';
      if (text.length > 16000 || !cardSafe(card, text)) continue;
      const peers = [...card.querySelectorAll('button,[role="button"]')].filter(visible);
      if (peers.some(peer => once.test(label(peer))) || !peers.some(peer => deny.test(label(peer)))) continue;
      const moreButton = peers.find(peer => (peer.getAttribute?.('aria-label') || '').trim() === 'More allow options' && !peer.disabled && peer.getAttribute?.('aria-disabled') !== 'true');
      if (!moreButton || !menuCardEligible(moreButton, card, text)) continue;
      const cardId = ensureCardId(card);
      if (!canAttemptCard(cardId, 'Allow once')) continue;
      void clickMenuOnce(moreButton, card, text);
      return;
    }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(scan, 150);
  }
  chrome.storage.local.get('approvalEnabled').then(data => { enabled = data.approvalEnabled !== false; schedule(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.approvalEnabled) { enabled = changes.approvalEnabled.newValue !== false; schedule(); }
  });
  document.addEventListener?.('visibilitychange', event => {
    if (!event?.isTrusted || !pageVisible()) return;
    const now = Date.now();
    for (const tagged of document.querySelectorAll?.('[data-approval-card-root],[data-ddev-card-id]') || []) {
      if (tagged && typeof tagged === 'object') initializedCards.delete(tagged);
    }
    for (const state of cardHistory.values()) {
      if (state.status === 'still-visible' || state.status === 'skipped') {
        state.firstAttemptAt = now;
        state.lastObservedAt = 0;
        state.rejectedUntil = 0;
        state.pendingVisibilityReset = true;
      }
    }
    if (busy) schedule();
    else scan();
  });
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(schedule, 2000);
})();
