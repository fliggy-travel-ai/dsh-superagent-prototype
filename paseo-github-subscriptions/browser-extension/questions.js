(() => {
  globalThis.__paseoQuestions?.destroy?.();
  const MAX_PROMPTS = 10;
  const MAX_OPTIONS = 30;
  const TTL = 5000;
  const EXCLUDED = 'pre,code,blockquote,a,textarea';
  const ROOTS = 'form,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const CONTROLS = 'input,[role="radio"],[role="checkbox"]';
  const BUTTONS = 'button,[role="button"],input';
  const GROUPS = '[role="radiogroup"],[role="group"],fieldset';
  const SUBMIT = /^(?:submit(?: answers?)?|send(?: answers?)?|confirm|continue|done|提交(?:答案)?|发送|确认|继续|完成)$/i;
  const RECOMMENDED = /\s*[(（]\s*(?:recommended|推荐)\s*[)）]\s*$/i;
  const SENSITIVE = /password|passcode|verification code|one-time|\bmfa\b|\b2fa\b|two-factor|captcha|security check|sign in|log in|login|credential|permission|grant access|always allow|allow all|full access|密码|验证码|安全验证|登录|登入|授权|权限/i;
  const attempted = new Map();
  let last = '';
  let timer = null;
  let interval = null;
  let destroyed = false;

  const sessionId = () => location.origin === 'https://claude.ai' ? location.pathname.match(/^\/code\/session_([A-Za-z0-9_-]+)\/?$/)?.[1] : undefined;
  const squeeze = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const attr = (element, name) => element.getAttribute?.(name);
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const disabled = element => Boolean(element.disabled) || attr(element, 'aria-disabled') === 'true';
  const lines = element => String(element.innerText ?? element.textContent ?? '').split('\n').map(squeeze).filter(Boolean);
  const hint = /\s*(?:[⌘⏎⌃⌥⇧⎋↵]+|\b(?:Ctrl|Command|Enter|Esc|Shift|Tab)\b).*$/i;
  const caption = element => squeeze(attr(element, 'aria-label') || (element.tagName === 'INPUT' ? element.value : '') || element.innerText || element.textContent).replace(hint, '').trim();
  function hash(input, seed) {
    let high = 0xdeadbeef ^ seed, low = 0x41c6ce57 ^ seed;
    for (let index = 0; index < input.length; index++) {
      const code = input.charCodeAt(index);
      high = Math.imul(high ^ code, 2654435761);
      low = Math.imul(low ^ code, 1597334677);
    }
    high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
    low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
    return (low >>> 0).toString(16).padStart(8, '0') + (high >>> 0).toString(16).padStart(8, '0');
  }
  const isControl = element => {
    if (element.closest?.(EXCLUDED)) return false;
    const role = attr(element, 'role');
    if (element.tagName === 'INPUT') return ['radio', 'checkbox'].includes(attr(element, 'type'));
    return role === 'radio' || role === 'checkbox';
  };
  const kind = control => control.tagName === 'INPUT' ? attr(control, 'type') : attr(control, 'role');
  const checked = control => control.tagName === 'INPUT' ? Boolean(control.checked) : attr(control, 'aria-checked') === 'true';
  function optionNode(control) {
    if (control.tagName !== 'INPUT') return control;
    return control.closest('label') || (control.id && [...document.querySelectorAll('label')].find(label => attr(label, 'for') === control.id)) || control.parentElement;
  }
  function groupOf(control, root) {
    for (let node = control.parentElement; node && node !== root.parentElement; node = node.parentElement) {
      if (node.matches?.(GROUPS)) return node;
      if (node === root) break;
    }
    return null;
  }
  function groupText(group) {
    const ids = (attr(group, 'aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const referenced = ids.map(id => squeeze(document.getElementById(id)?.innerText ?? document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
    if (referenced) return referenced;
    const label = squeeze(attr(group, 'aria-label'));
    if (label) return label;
    const legend = [...(group.children || [])].find(child => child.tagName === 'LEGEND');
    return legend ? squeeze(legend.innerText ?? legend.textContent) : '';
  }
  function optionOf(control) {
    const node = optionNode(control);
    if (!node || !(visible(control) || visible(node))) return null;
    const rows = lines(node);
    const label = squeeze(attr(control, 'aria-label')) || rows[0] || '';
    if (!label || label.length > 1000) return null;
    const description = (squeeze(attr(control, 'aria-label')) ? rows : rows.slice(1)).join(' ').slice(0, 4000);
    return { label, description, recommended: RECOMMENDED.test(label) };
  }
  function rootsOf(control) {
    const roots = [];
    for (let node = control.parentElement; node; node = node.parentElement) if (node.matches?.(ROOTS)) roots.push(node);
    return roots;
  }
  function submitsIn(root) {
    return [...root.querySelectorAll(BUTTONS)].filter(element => {
      if (element.closest?.(EXCLUDED) || !visible(element)) return false;
      if (element.tagName === 'INPUT' && attr(element, 'type') !== 'submit') return false;
      return SUBMIT.test(caption(element));
    });
  }
  function scan() {
    const id = sessionId();
    if (!id) return [];
    const controls = [...document.querySelectorAll(CONTROLS)].filter(isControl);
    if (!controls.length) return [];
    const byRoot = new Map();
    for (const control of controls) {
      let chosen = null;
      for (const root of rootsOf(control)) {
        if (root.closest?.(EXCLUDED)) break;
        const submits = submitsIn(root);
        if (submits.length > 1) break;
        if (submits.length === 1) { chosen = { root, submit: submits[0] }; break; }
      }
      if (!chosen) continue;
      const entry = byRoot.get(chosen.root) || { ...chosen, controls: [] };
      entry.controls.push(control);
      byRoot.set(chosen.root, entry);
    }
    const found = [];
    for (const { root, submit, controls: members } of byRoot.values()) {
      if (!visible(root)) continue;
      const groups = new Map();
      let valid = true;
      for (const control of members) {
        const group = groupOf(control, root);
        if (!group) { valid = false; break; }
        const list = groups.get(group) || [];
        list.push(control);
        groups.set(group, list);
      }
      if (!valid || !groups.size || groups.size > MAX_PROMPTS) continue;
      const prompts = [];
      const seen = new Set();
      for (const [group, list] of groups) {
        const question = groupText(group);
        const kinds = new Set(list.map(kind));
        const options = list.map(optionOf);
        const labels = options.map(option => option?.label);
        if (!question || question.length > 4000 || seen.has(question) || kinds.size !== 1 || list.length < 2 || list.length > MAX_OPTIONS || options.includes(null) || new Set(labels).size !== labels.length) { valid = false; break; }
        seen.add(question);
        prompts.push({ question, multiSelect: kinds.has('checkbox'), options, controls: list });
      }
      if (!valid) continue;
      const sensitive = SENSITIVE.test(squeeze(`${attr(root, 'aria-label') || ''} ${prompts.map(p => `${p.question} ${p.options.map(o => o.label).join(' ')}`).join(' ')}`));
      const shape = prompts.map(p => ({ question: p.question, multiSelect: p.multiSelect, options: p.options.map(o => o.label) }));
      const fingerprint = hash(JSON.stringify([id, shape]), 1) + hash(JSON.stringify([id, shape]), 2);
      found.push({ sensitive, root, submit, prompts, question: { id: `bq_${fingerprint}`, sessionId: id, fingerprint, prompts: prompts.map(p => ({ question: p.question, multiSelect: p.multiSelect, options: p.options.map(o => ({ label: o.label, description: o.description, recommended: sensitive ? false : o.recommended })) })) } });
    }
    return found;
  }
  const read = () => scan().map(entry => entry.question);
  const pause = delay => new Promise(resolve => setTimeout(resolve, delay));
  async function answer(decision) {
    const now = Date.now();
    if (!decision || typeof decision.id !== 'string' || typeof decision.fingerprint !== 'string' || typeof decision.expiresAt !== 'number' || !decision.answers || typeof decision.answers !== 'object') return 'unknown';
    if (decision.sessionId !== sessionId() || now >= decision.expiresAt || decision.expiresAt - now > TTL + 1000) return 'unknown';
    const key = `${decision.id}\n${decision.fingerprint}`;
    for (const [oldKey, at] of attempted) if (now - at > 600000) attempted.delete(oldKey);
    if (attempted.has(key)) return 'unknown';
    const entry = scan().find(item => item.question.id === decision.id && item.question.fingerprint === decision.fingerprint);
    if (!entry || entry.sensitive) return 'unknown';
    const names = Object.keys(decision.answers);
    if (names.length !== entry.prompts.length || !entry.prompts.every(prompt => Object.hasOwn(decision.answers, prompt.question))) return 'unknown';
    const plan = [];
    for (const prompt of entry.prompts) {
      const picked = decision.answers[prompt.question];
      if (!Array.isArray(picked) || !picked.length || new Set(picked).size !== picked.length || (!prompt.multiSelect && picked.length !== 1)) return 'unknown';
      if (!picked.every(label => prompt.options.some(option => option.label === label))) return 'unknown';
      plan.push({ prompt, picked });
    }
    attempted.set(key, now);
    for (const { prompt, picked } of plan) {
      for (const [index, control] of prompt.controls.entries()) {
        const wanted = picked.includes(prompt.options[index].label);
        if (disabled(control)) { if (wanted !== checked(control)) return 'unknown'; continue; }
        if (checked(control) !== wanted && (wanted || prompt.multiSelect)) control.click();
      }
    }
    await pause(150);
    if (destroyed || Date.now() >= decision.expiresAt) return 'unknown';
    for (const { prompt, picked } of plan) {
      if (!prompt.controls.every((control, index) => checked(control) === picked.includes(prompt.options[index].label))) return 'unknown';
    }
    const { root, submit } = entry;
    if (!root.isConnected || !submit.isConnected || !visible(submit) || disabled(submit) || submitsIn(root).length !== 1 || submitsIn(root)[0] !== submit) return 'unknown';
    submit.click();
    return 'submitted';
  }
  function onMessage(message, sender, respond) {
    if (destroyed || (sender?.id && sender.id !== chrome.runtime?.id)) return;
    if (message?.type === 'read-questions') { respond({ sessionId: sessionId(), questions: read() }); return; }
    if (message?.type === 'answer-question') {
      answer(message.decision).then(status => respond({ status }), () => respond({ status: 'unknown' }));
      return true;
    }
  }
  function notify() {
    timer = null;
    if (destroyed) return;
    const signature = read().map(question => question.id).join('\n');
    if (signature === last) return;
    last = signature;
    try { void chrome.runtime.sendMessage({ type: 'questions-changed' }).catch(() => {}); } catch { destroy(); }
  }
  function queue() { if (!destroyed && timer === null) timer = setTimeout(notify, 250); }
  const observer = new MutationObserver(queue);
  function destroy() {
    destroyed = true;
    observer.disconnect();
    if (interval !== null) clearInterval(interval);
    if (timer !== null) clearTimeout(timer);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    if (globalThis.__paseoQuestions?.destroy === destroy) delete globalThis.__paseoQuestions;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  interval = setInterval(queue, 2000);
  globalThis.__paseoQuestions = { destroy };
  queue();
})();
