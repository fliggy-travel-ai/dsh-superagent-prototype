(() => {
  if (globalThis.__paseoApprovalInstalled) return;
  globalThis.__paseoApprovalInstalled = true;
  const APPROVAL_INITIAL_DELAY_MS = 300;
  const APPROVAL_OBSERVE_DELAY_MS = 1500;
  const APPROVAL_RETRY_INTERVAL_MS = 5000;
  const APPROVAL_MAX_RETRY_DURATION_MS = 3 * 60 * 1000;
  const APPROVAL_MAX_CLICKS_PER_CARD = 36;
  const cfg = () => globalThis.__paseoApprovalConfig || {};
  const initialDelayMs = () => cfg().initialDelayMs ?? APPROVAL_INITIAL_DELAY_MS;
  const observeDelayMs = () => cfg().observeDelayMs ?? APPROVAL_OBSERVE_DELAY_MS;
  const retryIntervalMs = () => cfg().retryIntervalMs ?? APPROVAL_RETRY_INTERVAL_MS;
  const maxRetryDurationMs = () => cfg().maxRetryDurationMs ?? APPROVAL_MAX_RETRY_DURATION_MS;
  const maxClicksPerCard = () => cfg().maxClicksPerCard ?? APPROVAL_MAX_CLICKS_PER_CARD;
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
  function getCardRoot(scope) {
    return scope?.closest?.('[data-approval-card-root]') || scope;
  }
  function ensureCardId(scope) {
    const root = getCardRoot(scope);
    if (typeof root?.getAttribute !== 'function' || typeof root?.setAttribute !== 'function') return '';
    let id = (root.getAttribute('data-ddev-card-id') || '').trim();
    if (!id) {
      id = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      root.setAttribute('data-ddev-card-id', id);
    }
    return id;
  }
  function getCardAriaLabel(scope) {
    const root = getCardRoot(scope);
    return (root?.getAttribute?.('aria-label') || scope?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  }
  async function buildCardFingerprint(currentPath, scope, text) {
    const cardId = ensureCardId(scope);
    const ariaLabel = getCardAriaLabel(scope);
    const raw = `v2\n${currentPath}\n${cardId}\n${ariaLabel}\n${text}`;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const digest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    return { digest, cardId, ariaLabel };
  }
  function canAttemptCard(cardId, buttonLabel) {
    if (!pageVisible()) return false;
    if (!cardId) return true;
    const state = cardHistory.get(cardId);
    if (!state) return true;
    if (state.status === 'dismissed') return false;
    if (state.clicks >= maxClicksPerCard()) return false;
    if (state.status === 'still-visible') {
      if (!once.test(buttonLabel)) return false;
      const now = Date.now();
      if (now - state.lastObservedAt < retryIntervalMs()) return false;
      if (now - state.firstAttemptAt > maxRetryDurationMs()) return false;
    }
    return true;
  }
  function recordCardClick(cardId) {
    if (!cardId) return;
    const now = Date.now();
    const prev = cardHistory.get(cardId);
    cardHistory.set(cardId, {
      clicks: (prev?.clicks || 0) + 1,
      firstAttemptAt: prev?.firstAttemptAt ?? now,
      lastObservedAt: prev?.lastObservedAt ?? now,
      pendingVisibilityReset: false,
      status: 'reserved',
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
    const heading = scope.querySelector?.('h1,h2,h3,[role="heading"]')?.textContent || text.slice(0, 200);
    return once.test(label(button)) || (allow.test(label(button)) && permission.test(heading) && !permanent.test(text));
  }
  function closeMenu(target) {
    const event = typeof KeyboardEvent === 'function'
      ? new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
      : { type: 'keydown', key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    for (const node of [document.activeElement, target, document.body, document]) {
      try { node?.dispatchEvent?.(event); } catch {}
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
      if (root && typeof root === 'object' && !initializedCards.has(root)) {
        const delay = initialDelayMs();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (!enabled || !pageVisible() || currentPath !== location.pathname || scope.isConnected === false || !button.isConnected || !visible(button)) return;
        initializedCards.set(root, true);
        text = scope.innerText || scope.textContent || '';
        if (!eligible(button, scope, text)) return;
      }
      if (!canAttemptCard(cardId, buttonLabel)) return;
      const { digest } = await buildCardFingerprint(currentPath, scope, text);
      const resetRetryWindow = Boolean(cardId && cardHistory.get(cardId)?.pendingVisibilityReset);
      const reservation = await chrome.runtime.sendMessage({
        type: 'approval-reserve',
        digest,
        ...(cardId ? { cardId } : {}),
        ...(resetRetryWindow ? { resetRetryWindow: true } : {}),
        button: buttonLabel,
      });
      if (!reservation?.allowed) return;
      const report = status => chrome.runtime.sendMessage({ type: 'approval-result', digest, reservationId: reservation.reservationId, status });
      if (!enabled || !pageVisible() || currentPath !== location.pathname || !button.isConnected || (scope.innerText || scope.textContent || '') !== text || !eligible(button, scope, text)) {
        await report('skipped');
        return;
      }
      recordCardClick(cardId);
      triggerApprovalClick(button);
      await new Promise(resolve => setTimeout(resolve, observeDelayMs()));
      const status = scope.isConnected === false || !button.isConnected || !visible(button) ? 'dismissed' : 'still-visible';
      recordCardResult(cardId, status);
      await report(status);
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
      if (card && typeof card === 'object' && !initializedCards.has(card)) {
        const delay = initialDelayMs();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (!enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected || !moreButton.isConnected || !visible(moreButton)) return;
        initializedCards.set(card, true);
        text = card.innerText || card.textContent || '';
        if (!cardSafe(card, text)) return;
      }
      if (!canAttemptCard(cardId, 'Allow once')) return;
      const { digest } = await buildCardFingerprint(currentPath, card, text);
      const resetRetryWindow = Boolean(cardId && cardHistory.get(cardId)?.pendingVisibilityReset);
      const reservation = await chrome.runtime.sendMessage({
        type: 'approval-reserve',
        digest,
        ...(cardId ? { cardId } : {}),
        ...(resetRetryWindow ? { resetRetryWindow: true } : {}),
        button: 'Allow once',
      });
      if (!reservation?.allowed) return;
      const report = status => chrome.runtime.sendMessage({ type: 'approval-result', digest, reservationId: reservation.reservationId, status });
      if (!enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected || !moreButton.isConnected || moreButton.disabled || moreButton.getAttribute?.('aria-disabled') === 'true' || !visible(moreButton) || (card.innerText || card.textContent || '') !== text || !cardSafe(card, text)) {
        await report('skipped');
        return;
      }
      triggerApprovalClick(moreButton);
      let item = findAllowOnceMenuItem(moreButton);
      if (!item) {
        await new Promise(resolve => setTimeout(resolve, 50));
        item = findAllowOnceMenuItem(moreButton);
      }
      if (!item || !enabled || !pageVisible() || currentPath !== location.pathname || !card.isConnected) {
        closeMenu(moreButton);
        await report('skipped');
        return;
      }
      recordCardClick(cardId);
      triggerApprovalClick(item);
      await new Promise(resolve => setTimeout(resolve, observeDelayMs()));
      const status = !card.isConnected || !visible(card) || !moreButton.isConnected || !visible(moreButton) ? 'dismissed' : 'still-visible';
      recordCardResult(cardId, status);
      await report(status);
      if (status === 'still-visible' && pageVisible() && (!cardId || (cardHistory.get(cardId)?.clicks || 0) < maxClicksPerCard())) {
        setTimeout(schedule, retryIntervalMs());
      }
    } catch {} finally { busy = false; }
  }
  function scan() {
    queued = false;
    if (busy || !enabled || !pageVisible() || location.origin !== 'https://claude.ai' || !/^\/code\/session_[A-Za-z0-9_-]+\/?$/.test(location.pathname)) return;
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
      if (!moreButton) continue;
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
  document.addEventListener?.('visibilitychange', () => {
    if (!pageVisible()) return;
    const now = Date.now();
    for (const state of cardHistory.values()) {
      if (state.status === 'still-visible') {
        state.firstAttemptAt = now;
        state.lastObservedAt = 0;
        state.pendingVisibilityReset = true;
      }
    }
    if (busy) schedule();
    else scan();
  });
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(schedule, 2000);
})();
