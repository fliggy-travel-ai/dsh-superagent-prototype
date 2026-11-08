(() => {
if (globalThis.__paseoTitleInstalled) return;
globalThis.__paseoTitleInstalled = true;
function readTitle() {
  const match = location.pathname.match(/^\/code\/session_([A-Za-z0-9_-]+)\/?$/);
  if (location.origin !== 'https://claude.ai' || !match) return '';
  const link = [...document.querySelectorAll('a[href]')].find(a => {
    try { return new URL(a.href).origin === location.origin && new URL(a.href).pathname.replace(/\/$/, '') === `/code/session_${match[1]}`; } catch { return false; }
  });
  const label = (link?.querySelector('[data-row-label]') || link)?.cloneNode(true);
  label?.querySelectorAll('[role="status"], [data-find-omitted], .sr-only, [aria-hidden="true"]').forEach(element => element.remove());
  const title = label?.textContent?.trim() || link?.getAttribute('aria-label') || link?.querySelector('[title]')?.getAttribute('title') || document.title.replace(/\s*[-|–]\s*Claude\s*$/i, '');
  return (title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'read-title') respond({ title: readTitle() });
});
let last = '';
let timer = null;
function notifyTitle() {
  timer = null;
  const title = readTitle();
  const signature = `${location.pathname}\n${title}`;
  if (!title || signature === last) return;
  last = signature;
  try { void chrome.runtime.sendMessage({ type: 'session-title-changed' }).catch(() => {}); } catch { observer.disconnect(); }
}
const observer = new MutationObserver(() => {
  if (timer === null) timer = setTimeout(notifyTitle, 250);
});
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'title', 'aria-label'] });
notifyTitle();
})();
