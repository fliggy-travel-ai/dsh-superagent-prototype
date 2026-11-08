(() => {
  if (globalThis.__paseoApprovalInstalled) return;
  globalThis.__paseoApprovalInstalled = true;
  let enabled = false;
  let queued = false;
  let busy = false;
  const label = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().replace(/\s*(?:[⌘⏎⌃⌥⇧⎋↵]+|\b(?:Ctrl|Command|Enter|Esc|Shift|Tab)\b).*$/i, '').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const deny = /^(?:deny|deny all|decline|reject|cancel|拒绝|取消|不允许)$/i;
  const once = /^(?:allow once|allow just this once|yes, allow once|允许一次|只允许一次)$/i;
  const allow = /^(?:allow|允许)$/i;
  const permission = /(?:permission|allow claude|授权|权限|允许 Claude)/i;
  const permanent = /always|don't ask again|do not ask again|remember|this session|始终|不再询问|记住|本次会话/i;
  function eligible(button, scope, text) {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !visible(button)) return false;
    if (scope.querySelector('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"],[role="switch"][aria-checked="true"],[aria-pressed="true"]')) return false;
    if (scope.querySelector('input[type="radio"],[role="radio"],[role="radiogroup"],select,[role="listbox"]')) return false;
    const heading = scope.querySelector('h1,h2,h3,[role="heading"]')?.textContent || text.slice(0, 200);
    if (/\bplan\b|\bproceed\b|计划|方案确认/i.test(heading)) return false;
    if (/AskUserQuestion|ExitPlanMode|\(Recommended\)|\(推荐\)|请选择|Which option|Choose an answer/i.test(text)) return false;
    return once.test(label(button)) || (allow.test(label(button)) && permission.test(heading) && !permanent.test(text));
  }
  async function clickOnce(button, scope, text) {
    busy = true;
    try {
      const currentPath = location.pathname;
      const buttonLabel = label(button);
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${currentPath}\n${text}`));
      const digest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
      const reservation = await chrome.runtime.sendMessage({ type: 'approval-reserve', digest, button: buttonLabel });
      if (!reservation?.allowed) return;
      const report = status => chrome.runtime.sendMessage({ type: 'approval-result', digest, reservationId: reservation.reservationId, status });
      if (!enabled || currentPath !== location.pathname || !button.isConnected || (scope.innerText || scope.textContent || '') !== text || !eligible(button, scope, text)) {
        await report('skipped');
        return;
      }
      button.click();
      await new Promise(resolve => setTimeout(resolve, 1500));
      await report(!button.isConnected || !visible(button) ? 'dismissed' : 'still-visible');
    } catch {} finally { busy = false; }
  }
  function scan() {
    queued = false;
    if (busy || !enabled || location.origin !== 'https://claude.ai' || !/^\/code\/session_[A-Za-z0-9_-]+\/?$/.test(location.pathname)) return;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const candidates = buttons.filter(button => once.test(label(button)) || allow.test(label(button))).sort((left, right) => Number(once.test(label(right))) - Number(once.test(label(left))));
    for (const button of candidates) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('a,p,pre,code,blockquote,aside,[role="radiogroup"]')) continue;
      const dialog = button.closest('[role="dialog"],dialog,form');
      let scope = dialog || button.parentElement;
      for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
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
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(schedule, 2000);
})();
