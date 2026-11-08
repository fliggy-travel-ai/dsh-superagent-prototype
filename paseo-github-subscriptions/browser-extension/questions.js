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
  const NEXT = /^(?:next|下一步|下一题)$/i;
  const RECOMMENDED = /\s*[(（]\s*(?:recommended|推荐)\s*[)）]\s*$/i;
  const SENSITIVE = /password|passcode|verification code|one-time|\bmfa\b|\b2fa\b|two-factor|captcha|security check|sign in|log in|login|credential|permission|grant access|always allow|allow all|full access|密码|验证码|安全验证|登录|登入|授权|权限/i;
  const attempted = new Map();
  let last = '';
  let timer = null;
  let interval = null;
  let destroyed = false;

  const sessionId = () => location.origin === 'https://claude.ai' ? location.pathname.match(/^\/code\/session_([A-Za-z0-9_-]+)\/?$/)?.[1] : undefined;
  const squeeze = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const attr = (element, name) => element?.getAttribute?.(name) ?? null;
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const disabled = element => Boolean(element?.disabled) || attr(element, 'disabled') !== null || attr(element, 'aria-disabled') === 'true';
  const lines = element => String(element.innerText ?? element.textContent ?? '').split('\n').map(squeeze).filter(Boolean);
  const hint = /\s*(?:[⌘⏎⌃⌥⇧⎋↵]+|\b(?:Ctrl|Command|Enter|Esc|Shift|Tab)\b).*$/i;
  const caption = element => squeeze(attr(element, 'aria-label') || (element.tagName === 'INPUT' ? element.value : '') || element.innerText || element.textContent).replace(hint, '').trim();
  const pressed = element => attr(element, 'aria-pressed') === 'true';
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
    if (element.closest?.(EXCLUDED) || element.closest?.('[data-cds="SegmentedControl"]') || element.closest?.('[data-approval-card-root]')) return false;
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
  function cardOptionOf(button) {
    const contentDiv = [...(button.children || [])].find(child => child.tagName === 'DIV');
    const innerDivs = contentDiv ? [...(contentDiv.children || [])].filter(child => child.tagName === 'DIV') : [];
    const label = squeeze(innerDivs[0]?.innerText ?? innerDivs[0]?.textContent);
    if (!label || label.length > 1000) return null;
    const description = squeeze(innerDivs[1]?.innerText ?? innerDivs[1]?.textContent).slice(0, 4000);
    return { label, description, recommended: RECOMMENDED.test(label) };
  }
  function cardSubmitsIn(card, pageNumber, pages) {
    const pattern = pageNumber < pages ? NEXT : SUBMIT;
    return [...card.querySelectorAll('button,[role="button"]')].filter(element => {
      if (element.closest?.(EXCLUDED) || attr(element, 'data-question-answer') !== null || !visible(element)) return false;
      return pattern.test(caption(element));
    });
  }
  function findOtherTextArea(card) {
    return [...card.querySelectorAll('textarea[aria-label="Other option"]')].find(node => visible(node)) || null;
  }
  function readTextArea(textarea) {
    if (typeof textarea.value === 'string') return textarea.value;
    const dotVal = attr(textarea, '.value');
    return dotVal ?? '';
  }
  function writeTextArea(textarea, value) {
    const proto = typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : Object.getPrototypeOf(textarea);
    const setter = (proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set)
      || Object.getOwnPropertyDescriptor(textarea, 'value')?.set;
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    if (textarea.attrs && typeof textarea.attrs === 'object' && '.value' in textarea.attrs) {
      textarea.attrs['.value'] = value;
    }
    const event = typeof Event === 'function' ? new Event('input', { bubbles: true }) : { type: 'input', bubbles: true };
    textarea.dispatchEvent?.(event);
  }
  function readCardState(card) {
    if (!card || attr(card, 'role') !== 'group' || card.closest?.(EXCLUDED) || card.closest?.('[data-cds="SegmentedControl"]') || !visible(card)) return null;
    const question = squeeze(attr(card, 'aria-label'));
    if (!question || question.length > 4000 || /^Permission request:/i.test(question)) return null;
    const answerButtons = [...card.querySelectorAll('button[data-question-answer]')].filter(btn => !btn.closest?.(EXCLUDED) && visible(btn));
    if (!answerButtons.length) return null;
    let otherButton = null;
    const controls = [];
    const options = [];
    for (const btn of answerButtons) {
      if (/^Other$/i.test(squeeze(attr(btn, 'aria-label')))) {
        if (otherButton) return null;
        otherButton = btn;
        continue;
      }
      const parsed = cardOptionOf(btn);
      if (!parsed) return null;
      controls.push(btn);
      options.push(parsed);
    }
    const labels = options.map(o => o.label);
    if (options.length < 2 || options.length > MAX_OPTIONS || new Set(labels).size !== labels.length) return null;
    let pageNumber = 1;
    let pages = 1;
    const hasPager = card.querySelectorAll('button[aria-label="Show previous question"],button[aria-label="Show next question"]').length > 0;
    if (hasPager) {
      const pageSpan = [...card.querySelectorAll('span')].find(node => !(node.children && node.children.length) && /^(\d+)\s+of\s+(\d+)$/i.test(squeeze(node.innerText ?? node.textContent)));
      const match = pageSpan && squeeze(pageSpan.innerText ?? pageSpan.textContent).match(/^(\d+)\s+of\s+(\d+)$/i);
      if (!match) return null;
      pageNumber = Number(match[1]);
      pages = Number(match[2]);
      if (!Number.isInteger(pageNumber) || !Number.isInteger(pages) || pageNumber < 1 || pages < 1 || pageNumber > pages || pages > MAX_PROMPTS) return null;
    }
    if (cardSubmitsIn(card, pageNumber, pages).length !== 1) return null;
    const multiSelect = [...card.querySelectorAll('[role="status"]')].some(node => /^\d+\s+selected$/i.test(squeeze(node.innerText ?? node.textContent)));
    const allowOther = Boolean(otherButton);
    const anchor = card.closest?.('[data-tool-anchor]');
    const toolUseId = squeeze(attr(anchor, 'data-tool-anchor')) || undefined;
    const sensitive = SENSITIVE.test(squeeze(`${question} ${labels.join(' ')}`));
    return {
      card,
      toolUseId,
      pageNumber,
      pages,
      sensitive,
      otherButton,
      controls,
      prompt: {
        question,
        multiSelect,
        allowOther,
        options,
      },
    };
  }
  function scanCards(id) {
    const cards = [...document.querySelectorAll('[data-approval-card-root]')];
    const found = [];
    for (const node of cards) {
      const state = readCardState(node);
      if (!state || state.pageNumber !== 1) continue;
      const shape = [{
        question: state.prompt.question,
        multiSelect: state.prompt.multiSelect,
        allowOther: state.prompt.allowOther,
        options: state.prompt.options.map(o => o.label),
        ...(state.pages > 1 ? { pages: state.pages } : {}),
        ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
      }];
      const fingerprint = hash(JSON.stringify([id, shape]), 1) + hash(JSON.stringify([id, shape]), 2);
      found.push({
        kind: 'card',
        sensitive: state.sensitive,
        toolUseId: state.toolUseId,
        pages: state.pages,
        cardState: state,
        prompts: [state.prompt],
        question: {
          id: `bq_${fingerprint}`,
          sessionId: id,
          fingerprint,
          ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
          ...(state.pages > 1 ? { pages: state.pages } : {}),
          prompts: [{
            question: state.prompt.question,
            multiSelect: state.prompt.multiSelect,
            ...(state.prompt.allowOther ? { allowOther: true } : {}),
            options: state.prompt.options.map(o => ({
              label: o.label,
              description: o.description,
              recommended: state.sensitive ? false : o.recommended,
            })),
          }],
        },
      });
    }
    return found;
  }
  function scanForms(id) {
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
      found.push({
        kind: 'form',
        sensitive,
        root,
        submit,
        prompts,
        question: {
          id: `bq_${fingerprint}`,
          sessionId: id,
          fingerprint,
          prompts: prompts.map(p => ({
            question: p.question,
            multiSelect: p.multiSelect,
            options: p.options.map(o => ({
              label: o.label,
              description: o.description,
              recommended: sensitive ? false : o.recommended,
            })),
          })),
        },
      });
    }
    return found;
  }
  function scan() {
    const id = sessionId();
    if (!id) return [];
    return [...scanCards(id), ...scanForms(id)];
  }
  const read = () => scan().map(entry => entry.question);
  const pause = delay => new Promise(resolve => setTimeout(resolve, delay));
  function findCardPage(entry, pageNo) {
    const states = [...document.querySelectorAll('[data-approval-card-root]')]
      .map(readCardState)
      .filter(state => state && state.pages === entry.pages && state.pageNumber === pageNo && (entry.toolUseId ? state.toolUseId === entry.toolUseId : !state.toolUseId));
    return states.length === 1 ? states[0] : null;
  }
  function normalizeDecision(decision) {
    const answers = {};
    for (const [rawKey, rawList] of Object.entries(decision.answers || {})) {
      const k = squeeze(rawKey);
      if (!k || Object.hasOwn(answers, k) || !Array.isArray(rawList) || rawList.some(item => typeof item !== 'string')) return null;
      answers[k] = rawList.map(squeeze);
    }
    const otherAnswers = {};
    if (decision.otherAnswers !== undefined) {
      for (const [rawKey, rawVal] of Object.entries(decision.otherAnswers)) {
        const k = squeeze(rawKey);
        if (!k || Object.hasOwn(otherAnswers, k) || typeof rawVal !== 'string') return null;
        otherAnswers[k] = rawVal;
      }
    }
    return { answers, otherAnswers };
  }
  function validateCardPagePlan(cardState, expectedPage, totalPages, normalized, allKeys, isManual) {
    if (!cardState || cardState.pageNumber !== expectedPage || cardState.pages !== totalPages) return null;
    if (cardState.sensitive && !isManual) return null;
    const qKey = squeeze(cardState.prompt.question);
    if (!allKeys.has(qKey)) return null;
    const picked = Object.hasOwn(normalized.answers, qKey) ? normalized.answers[qKey] : [];
    const hasOtherKey = Object.hasOwn(normalized.otherAnswers, qKey);
    const rawOther = hasOtherKey ? normalized.otherAnswers[qKey] : undefined;
    const otherText = typeof rawOther === 'string' ? rawOther.trim() : '';
    if (hasOtherKey && !otherText) return null;
    if (!Array.isArray(picked) || new Set(picked).size !== picked.length) return null;
    if (!picked.every(label => cardState.prompt.options.some(option => squeeze(option.label) === label))) return null;
    if (otherText && (!cardState.prompt.allowOther || !cardState.otherButton || otherText.length > 2000)) return null;
    const totalPicked = picked.length + (otherText ? 1 : 0);
    if (!cardState.prompt.multiSelect ? totalPicked !== 1 : totalPicked < 1) return null;
    return { cardState, picked, otherText };
  }
  async function answerCard(entry, decision, normalized, key, now, isManual) {
    const totalPages = entry.pages || 1;
    const allKeys = new Set([
      ...Object.keys(normalized.answers),
      ...Object.keys(normalized.otherAnswers),
    ]);
    if (allKeys.size !== totalPages) return 'unknown';
    const seenQuestions = new Set();
    let currentPlan = validateCardPagePlan(entry.cardState, 1, totalPages, normalized, allKeys, isManual);
    if (!currentPlan) return 'unknown';
    attempted.set(key, now);

    for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
      if (pageNo > 1) {
        const nextState = findCardPage(entry, pageNo);
        currentPlan = validateCardPagePlan(nextState, pageNo, totalPages, normalized, allKeys, isManual);
        if (!currentPlan || seenQuestions.has(squeeze(currentPlan.cardState.prompt.question))) return 'unknown';
      }
      const { cardState, picked, otherText } = currentPlan;
      seenQuestions.add(squeeze(cardState.prompt.question));

      if (!cardState.prompt.multiSelect) {
        if (otherText) {
          if (!cardState.otherButton || disabled(cardState.otherButton)) return 'unknown';
          cardState.otherButton.click();
        } else {
          const targetIdx = cardState.prompt.options.findIndex(option => squeeze(option.label) === picked[0]);
          const targetControl = cardState.controls[targetIdx];
          if (!targetControl || disabled(targetControl)) return 'unknown';
          targetControl.click();
        }
      } else {
        for (const [index, control] of cardState.controls.entries()) {
          const wanted = picked.includes(squeeze(cardState.prompt.options[index].label));
          if (disabled(control)) { if (wanted !== pressed(control)) return 'unknown'; continue; }
          if (pressed(control) !== wanted) control.click();
        }
        if (cardState.otherButton) {
          const wantedOther = Boolean(otherText);
          if (disabled(cardState.otherButton)) { if (wantedOther !== pressed(cardState.otherButton)) return 'unknown'; }
          else if (pressed(cardState.otherButton) !== wantedOther) cardState.otherButton.click();
        }
      }

      if (otherText) {
        let textarea = findOtherTextArea(cardState.card);
        if (!textarea) {
          await pause(50);
          textarea = findOtherTextArea(cardState.card);
        }
        if (!textarea || !visible(textarea) || disabled(textarea)) return 'unknown';
        writeTextArea(textarea, otherText);
      }

      await pause(150);
      if (destroyed || Date.now() >= decision.expiresAt) return 'unknown';

      if (!cardState.controls.every((control, index) => pressed(control) === picked.includes(squeeze(cardState.prompt.options[index].label)))) return 'unknown';
      if (cardState.otherButton && pressed(cardState.otherButton) !== Boolean(otherText)) return 'unknown';
      if (otherText) {
        const textarea = findOtherTextArea(cardState.card);
        if (!textarea || !visible(textarea) || readTextArea(textarea) !== otherText) return 'unknown';
      }

      const actions = cardSubmitsIn(cardState.card, pageNo, totalPages);
      if (!cardState.card.isConnected || actions.length !== 1) return 'unknown';
      const actionBtn = actions[0];
      if (!actionBtn.isConnected || !visible(actionBtn) || disabled(actionBtn)) return 'unknown';
      actionBtn.click();

      if (pageNo < totalPages) {
        await pause(150);
        if (destroyed || Date.now() >= decision.expiresAt) return 'unknown';
      }
    }
    return 'submitted';
  }
  async function answer(decision) {
    const now = Date.now();
    if (!decision || typeof decision.id !== 'string' || typeof decision.fingerprint !== 'string' || typeof decision.expiresAt !== 'number' || !decision.answers || typeof decision.answers !== 'object' || Array.isArray(decision.answers)) return 'unknown';
    if (decision.otherAnswers !== undefined && (!decision.otherAnswers || typeof decision.otherAnswers !== 'object' || Array.isArray(decision.otherAnswers))) return 'unknown';
    if (decision.sessionId !== sessionId() || now >= decision.expiresAt || decision.expiresAt - now > TTL + 1000) return 'unknown';
    const key = `${decision.id}\n${decision.fingerprint}`;
    for (const [oldKey, at] of attempted) if (now - at > 600000) attempted.delete(oldKey);
    if (attempted.has(key)) return 'unknown';
    const normalized = normalizeDecision(decision);
    if (!normalized) return 'unknown';
    const entry = scan().find(item => item.question.id === decision.id && item.question.fingerprint === decision.fingerprint);
    const isManual = decision.source === 'manual';
    if (!entry || (entry.sensitive && !isManual)) return 'unknown';
    if (entry.kind === 'card') {
      return answerCard(entry, decision, normalized, key, now, isManual);
    }
    if (Object.keys(normalized.otherAnswers).length > 0) return 'unknown';
    const names = Object.keys(normalized.answers);
    if (names.length !== entry.prompts.length || !entry.prompts.every(prompt => Object.hasOwn(normalized.answers, squeeze(prompt.question)))) return 'unknown';
    const plan = [];
    for (const prompt of entry.prompts) {
      const picked = normalized.answers[squeeze(prompt.question)];
      if (!Array.isArray(picked) || !picked.length || new Set(picked).size !== picked.length || (!prompt.multiSelect && picked.length !== 1)) return 'unknown';
      if (!picked.every(label => prompt.options.some(option => squeeze(option.label) === label))) return 'unknown';
      plan.push({ prompt, picked });
    }
    attempted.set(key, now);
    for (const { prompt, picked } of plan) {
      for (const [index, control] of prompt.controls.entries()) {
        const wanted = picked.includes(squeeze(prompt.options[index].label));
        if (disabled(control)) { if (wanted !== checked(control)) return 'unknown'; continue; }
        if (checked(control) !== wanted && (wanted || prompt.multiSelect)) control.click();
      }
    }
    await pause(150);
    if (destroyed || Date.now() >= decision.expiresAt) return 'unknown';
    for (const { prompt, picked } of plan) {
      if (!prompt.controls.every((control, index) => checked(control) === picked.includes(squeeze(prompt.options[index].label)))) return 'unknown';
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
