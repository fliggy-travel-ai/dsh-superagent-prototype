(() => {
  if (location.origin !== 'https://claude.ai') return;
  globalThis.__paseoActivityCleanup?.();
  const visible = element => {
    if (!element) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  };
  const read = () => {
    if (!/^\/code\/session_[A-Za-z0-9_-]+\/?$/.test(location.pathname)) return;
    const messages = [...document.querySelectorAll('[data-testid="assistant-message"]')];
    const latest = messages.at(-1);
    const prose = latest ? [...latest.querySelectorAll('[data-cds="Prose"]')].at(-1) : null;
    const lastMessage = (prose?.innerText || '').trim().slice(-2000);
    const observedAt = new Date().toISOString();
    const result = (state, reason) => ({ state, reason, lastMessage, observedAt });
    if (visible(document.querySelector('[data-testid="code-prompt-stop"]')) || messages.some(message => message.getAttribute('data-is-streaming') === 'true')) return result('working', '网页正在输出或执行任务');
    const notices = [...document.querySelectorAll('[role="alert"],[role="status"],[role="dialog"]')].filter(element => visible(element) && !element.closest('[data-testid="assistant-message"],[data-testid="user-message"],pre,code,blockquote'));
    const limited = notices.find(element => /(?:you(?:'|’)ve hit your (?:session|weekly) limit|(?:session|weekly) limit reached|hit your weekly limit|已达到.{0,8}(?:会话|每周|周).{0,8}(?:限额|上限))/i.test(element.innerText.slice(0,800)));
    if (limited) return result('limited', limited.innerText.trim().slice(0,300));
    if (notices.some(element => element.getAttribute('role') === 'dialog')) return result('unknown', '网页有待处理窗口，请在原会话确认');
    const editor = document.querySelector('[data-testid="code-prompt-input"]');
    if (!visible(editor) || editor.getAttribute('contenteditable') !== 'true' || !lastMessage) return result('unknown', '无法确认网页当前状态');
    if (editor.innerText.trim()) return result('unknown', '网页输入框有未发送内容');
    return result('waiting', '网页已停止输出，等待输入；后台子任务和监听需在原会话核对');
  };
  const handler = (message, _sender, respond) => { if (message?.type === 'read-activity') respond(read()); };
  chrome.runtime.onMessage.addListener(handler);
  globalThis.__paseoActivityCleanup = () => chrome.runtime.onMessage.removeListener(handler);
})();
