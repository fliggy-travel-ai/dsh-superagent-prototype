if (typeof importScripts === 'function') importScripts('usage-reader.js');
const sessionId = value => {
  try {
    const url = new URL(value);
    return url.origin === 'https://claude.ai' ? url.pathname.match(/^\/code\/session_([A-Za-z0-9_-]+)\/?$/)?.[1] : undefined;
  } catch { return undefined; }
};
const PAIR_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/sync$/;
const safeTitle = value => {
  const title = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return !title || /^(claude|claude code|recents|new chat|untitled)$/i.test(title) ? '未命名会话' : title;
};
let inflight = null;
let again = false;
const expected = new Map();
const observed = new Map();
let groupWrites = Promise.resolve();
function changeGroups(change) {
  const next = groupWrites.then(async () => {
    const data = await chrome.storage.local.get('groups');
    const groups = data.groups || {};
    await change(groups);
    await chrome.storage.local.set({ groups });
  });
  groupWrites = next.catch(() => {});
  return next;
}
function saveGroups(candidate) {
  return changeGroups(groups => {
    for (const [key, entry] of Object.entries(candidate)) {
      const current = groups[key];
      if (current?.id === entry.id && current.locked) entry.locked = true;
      groups[key] = entry;
    }
  });
}

const MAX_QUESTIONS = 50;
const MAX_HANDLED = 500;
const str = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;
function cleanQuestion(raw, expectedSession) {
  if (!raw || raw.sessionId !== expectedSession || !str(raw.id, 200, 1) || !str(raw.fingerprint, 128, 1) || !Array.isArray(raw.prompts) || raw.prompts.length < 1 || raw.prompts.length > 10) return null;
  if (raw.toolUseId !== undefined && !str(raw.toolUseId, 200, 1)) return null;
  if (raw.pages !== undefined && (!Number.isInteger(raw.pages) || raw.pages < 1 || raw.pages > 10)) return null;
  const prompts = [];
  for (const prompt of raw.prompts) {
    if (!prompt || !str(prompt.question, 4000, 1) || typeof prompt.multiSelect !== 'boolean' || !Array.isArray(prompt.options) || prompt.options.length > 30) return null;
    if (prompt.header !== undefined && !str(prompt.header, 200)) return null;
    if (prompt.allowOther !== undefined && typeof prompt.allowOther !== 'boolean') return null;
    const options = [];
    for (const option of prompt.options) {
      if (!option || !str(option.label, 1000, 1) || !str(option.description ?? '', 4000) || typeof option.recommended !== 'boolean') return null;
      options.push({ label: option.label, description: option.description ?? '', recommended: option.recommended });
    }
    prompts.push({
      question: prompt.question,
      ...(prompt.header !== undefined ? { header: prompt.header } : {}),
      multiSelect: prompt.multiSelect,
      ...(prompt.allowOther !== undefined ? { allowOther: prompt.allowOther } : {}),
      options,
    });
  }
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    fingerprint: raw.fingerprint,
    ...(raw.toolUseId !== undefined ? { toolUseId: raw.toolUseId } : {}),
    ...(raw.pages !== undefined ? { pages: raw.pages } : {}),
    prompts,
  };
}
function cleanDecision(raw) {
  if (!raw || !str(raw.id, 200, 1) || !str(raw.sessionId, 200, 1) || !str(raw.fingerprint, 128, 1) || typeof raw.expiresAt !== 'number' || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) return null;
  if (raw.source !== undefined && raw.source !== 'automatic' && raw.source !== 'manual') return null;
  let otherAnswers;
  if (raw.otherAnswers !== undefined) {
    if (!raw.otherAnswers || typeof raw.otherAnswers !== 'object' || Array.isArray(raw.otherAnswers)) return null;
    otherAnswers = {};
    for (const [question, text] of Object.entries(raw.otherAnswers)) {
      if (!str(question, 4000, 1) || typeof text !== 'string' || !str(text.trim(), 2000, 1) || text.length > 2000) return null;
      otherAnswers[question] = text.trim();
    }
  }
  const answers = {};
  for (const [question, labels] of Object.entries(raw.answers)) {
    if (!str(question, 4000, 1) || !Array.isArray(labels) || labels.length > 30 || !labels.every(label => str(label, 1000, 1))) return null;
    if (!labels.length && !otherAnswers?.[question]) return null;
    answers[question] = [...labels];
  }
  if (!Object.keys(answers).length && (!otherAnswers || !Object.keys(otherAnswers).length)) return null;
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    fingerprint: raw.fingerprint,
    answers,
    ...(otherAnswers && Object.keys(otherAnswers).length ? { otherAnswers } : {}),
    ...(raw.source !== undefined ? { source: raw.source } : {}),
    expiresAt: raw.expiresAt,
  };
}
async function readQuestions(tabId, expectedSession) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'read-questions' });
    if (reply?.sessionId !== expectedSession || !Array.isArray(reply.questions)) return null;
    const questions = reply.questions.map(raw => cleanQuestion(raw, expectedSession));
    return questions.every(Boolean) ? questions : null;
  } catch { return null; }
}
let questionWrites = Promise.resolve();
function changeQuestionState(change) {
  const next = questionWrites.then(async () => {
    const state = (await chrome.storage.local.get('questionState')).questionState || {};
    state.handled = state.handled && typeof state.handled === 'object' ? state.handled : {};
    state.results = Array.isArray(state.results) ? state.results : [];
    const value = await change(state);
    await chrome.storage.local.set({ questionState: state });
    return value;
  });
  questionWrites = next.catch(() => {});
  return next;
}
const resultKey = result => `${result.id}\n${result.fingerprint}\n${result.status}`;
async function dispatchDecisions(decisions, instanceId, reported) {
  let handled = 0;
  for (const raw of decisions.slice(0, MAX_QUESTIONS)) {
    const decision = cleanDecision(raw);
    if (!decision) continue;
    const key = `${decision.id}\n${decision.fingerprint}`;
    const fresh = await changeQuestionState(state => {
      if (state.handled[key]) return false;
      state.handled[key] = Date.now();
      const extra = Object.entries(state.handled).sort((left, right) => left[1] - right[1]).slice(0, Math.max(0, Object.keys(state.handled).length - MAX_HANDLED));
      for (const [old] of extra) delete state.handled[old];
      return true;
    });
    if (!fresh) continue;
    handled++;
    let status = 'unknown';
    try {
      const target = reported.get(decision.id);
      const remaining = decision.expiresAt - Date.now();
      if (target && target.question.fingerprint === decision.fingerprint && target.question.sessionId === decision.sessionId && remaining > 0 && remaining <= 6000
        && (await chrome.storage.local.get('instanceId')).instanceId === instanceId) {
        const tab = await chrome.tabs.get(target.tabId);
        if (sessionId(tab?.url) === decision.sessionId) {
          const current = await readQuestions(target.tabId, decision.sessionId);
          if (current?.some(question => question.id === decision.id && question.fingerprint === decision.fingerprint) && Date.now() < decision.expiresAt) {
            const reply = await chrome.tabs.sendMessage(target.tabId, { type: 'answer-question', decision });
            if (reply?.status === 'submitted') status = 'submitted';
          }
        }
      }
    } catch {}
    const result = { id: decision.id, sessionId: decision.sessionId, fingerprint: decision.fingerprint, status };
    await changeQuestionState(state => { if (!state.results.some(item => resultKey(item) === resultKey(result))) state.results = [...state.results, result].slice(-MAX_QUESTIONS); });
  }
  return handled;
}
let questionPoll = null;

async function reconcile() {
  const SYNC_FAILURE_TIMEOUT_MS = 3 * 60 * 1000;
  const data = await chrome.storage.local.get(['instanceId', 'instanceName', 'pairing', 'groups', 'approvalEnabled', 'syncFailureSince']);
  let instanceId = data.instanceId;
  if (!instanceId) { instanceId = crypto.randomUUID(); await chrome.storage.local.set({ instanceId }); }
  const pairing = data.pairing;
  const match = typeof pairing?.url === 'string' && pairing.url.match(PAIR_RE);
  if (pairing && (!match || Number(match[1]) > 65535 || !/^[a-f0-9]{64}$/.test(pairing?.token || ''))) return;
  const noteSyncFailure = async () => {
    const now = Date.now();
    const since = typeof data.syncFailureSince === 'number' && Number.isFinite(data.syncFailureSince) ? data.syncFailureSince : now;
    const updates = {};
    if (data.syncFailureSince !== since) {
      updates.syncFailureSince = since;
      data.syncFailureSince = since;
    }
    if (now - since >= SYNC_FAILURE_TIMEOUT_MS && data.approvalEnabled === true) {
      updates.approvalEnabled = false;
      data.approvalEnabled = false;
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  };
  const tabs = (await chrome.tabs.query({ url: 'https://claude.ai/code/session_*' })).filter(t => sessionId(t.url) && t.id != null);
  const sessions = new Map();
  for (const tab of tabs) {
    const id = sessionId(tab.url);
    let title = '';
    try { title = (await chrome.tabs.sendMessage(tab.id, { type: 'read-title' }))?.title || ''; } catch {}
    if (!title) title = (tab.title || '').replace(/\s*[-|–]\s*Claude\s*$/i, '');
    const found = sessions.get(id) || { sessionId: id, title: safeTitle(title), url: `https://claude.ai/code/session_${id}`, tabCount: 0, tabs: [] };
    if (found.title === '未命名会话') found.title = safeTitle(title);
    found.tabs.push(tab); found.tabCount++; sessions.set(id, found);
  }
  let response = { sessions: [...sessions.values()].map(session => ({ sessionId: session.sessionId, groupTitle: session.title })) };
  const reported = new Map();
  const observedSessionIds = [];
  let sentResults = [];
  if (pairing) try {
    for (const session of sessions.values()) {
      let complete = true;
      const activities = [];
      for (const tab of session.tabs) {
        try {
          const activity = await chrome.tabs.sendMessage(tab.id, { type: 'read-activity' });
          if (['working', 'waiting', 'limited', 'unknown'].includes(activity?.state) && typeof activity.reason === 'string' && typeof activity.lastMessage === 'string' && Number.isFinite(Date.parse(activity.observedAt))) activities.push({ state: activity.state, reason: activity.reason.slice(0,300), lastMessage: activity.lastMessage.slice(-2000), observedAt: new Date().toISOString() });
        } catch {}
        if (data.approvalEnabled === false) { complete = false; continue; }
        const questions = await readQuestions(tab.id, session.sessionId);
        if (!questions) { complete = false; continue; }
        for (const question of questions) {
          if (reported.has(question.id)) continue;
          if (reported.size >= MAX_QUESTIONS) { complete = false; continue; }
          reported.set(question.id, { question, tabId: tab.id });
        }
      }
      session.activity = activities.find(activity => activity.state === 'working') || (activities.length === session.tabs.length ? activities.find(activity => activity.state === 'unknown') || activities.find(activity => activity.state === 'limited') || activities[0] : undefined);
      if (complete) observedSessionIds.push(session.sessionId);
    }
    sentResults = ((await chrome.storage.local.get('questionState')).questionState?.results || []).slice(0, MAX_QUESTIONS);
    const instanceName = typeof data.instanceName === 'string' && data.instanceName.trim() ? data.instanceName.trim().slice(0, 120) : '未命名浏览器环境';
    const storedApprovals = (await chrome.storage.local.get('approvalAudit')).approvalAudit;
    const approvals = (Array.isArray(storedApprovals) ? storedApprovals : []).slice(-30).map(({ sessionId, reservationId, digest, button, at, observedAt, status, readGate }) => ({ sessionId, reservationId, digest, button, at, observedAt, status, ...(readGate ? { readGate } : {}) }));
    response = await fetch(pairing.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pairing.token}` }, body: JSON.stringify({ instanceId, instanceName, sessions: [...sessions.values()].map(({ tabs: _tabs, ...s }) => s), observedSessionIds, approvals, questions: [...reported.values()].map(item => item.question), results: sentResults }), signal: AbortSignal.timeout(5000), redirect: 'error', credentials: 'omit' });
    if (!response.ok) { await noteSyncFailure(); return; }
    response = await response.json();
    const validSessions = Array.isArray(response?.sessions) && response.sessions.length === sessions.size && !response.sessions.some(s => !sessions.has(s.sessionId) || typeof s.groupTitle !== 'string');
    if (typeof response?.approvalEnabled !== 'boolean' && !validSessions) { await noteSyncFailure(); return; }
    if (data.syncFailureSince != null) {
      await chrome.storage.local.set({ syncFailureSince: null });
      data.syncFailureSince = null;
    }
    if (typeof response.approvalEnabled === 'boolean' && data.approvalEnabled !== response.approvalEnabled) {
      await chrome.storage.local.set({ approvalEnabled: response.approvalEnabled });
      data.approvalEnabled = response.approvalEnabled;
      if (response.approvalEnabled) schedule();
    }
    if (!validSessions) return;
  } catch { await noteSyncFailure(); return; }
  if ((await chrome.storage.local.get('instanceId')).instanceId !== instanceId) return;
  if (pairing) {
    if (sentResults.length) { const sent = new Set(sentResults.map(resultKey)); await changeQuestionState(state => { state.results = state.results.filter(item => !sent.has(resultKey(item))); }); }
    if (Array.isArray(response.decisions) && response.decisions.length) { if (await dispatchDecisions(response.decisions, instanceId, reported)) schedule(); }
    if (reported.size && !questionPoll) questionPoll = setTimeout(() => { questionPoll = null; schedule(); }, 2000);
  }
  const groups = data.groups && typeof data.groups === 'object' ? data.groups : {};
  const titles = new Map();
  for (const item of response.sessions) { const title = safeTitle(item.groupTitle); titles.set(title, (titles.get(title) || 0) + 1); }
  for (const item of response.sessions) {
    const session = sessions.get(item.sessionId);
    const windows = new Map();
    for (const tab of session.tabs) { const list = windows.get(tab.windowId) || []; list.push(tab); windows.set(tab.windowId, list); }
    for (const [windowId, list] of windows) {
      if ((await chrome.storage.local.get('instanceId')).instanceId !== instanceId) return;
      const groupKey = `${item.sessionId}:${windowId}`;
      let entry = groups[groupKey];
      let group = null;
      if (entry) { try { group = await chrome.tabGroups.get(entry.id); } catch {} }
      if (group && (group.windowId !== windowId || !list.some(t => t.groupId === group.id))) group = null;
      if (group) {
        const members = await chrome.tabs.query({ groupId: group.id });
        if (members.some(t => sessionId(t.url) !== item.sessionId)) group = null;
      }
      if (!group) {
        const free = list.filter(t => t.groupId === -1);
        if (!free.length) continue;
        const gid = await chrome.tabs.group({ tabIds: free.map(t => t.id) });
        group = await chrome.tabGroups.get(gid); entry = { id: gid, title: group.title || '', locked: false }; groups[groupKey] = entry;
      }
      const free = list.filter(t => t.groupId === -1);
      if (free.length) await chrome.tabs.group({ groupId: group.id, tabIds: free.map(t => t.id) });
      group = await chrome.tabGroups.get(group.id);
      if (group.title !== entry.title) entry.locked = true;
      if (observed.has(group.id) && observed.get(group.id) !== entry.title) entry.locked = true;
      const baseTitle = safeTitle(item.groupTitle);
      if (baseTitle === '未命名会话' && safeTitle(entry.title) !== '未命名会话') continue;
      const suffix = item.sessionId.slice(-6);
      const collides = response.sessions.some(other => other.sessionId !== item.sessionId && safeTitle(other.groupTitle) === baseTitle && other.sessionId.slice(-6) === suffix);
      const title = titles.get(baseTitle) > 1 ? `${baseTitle} · ${collides ? item.sessionId : suffix}` : baseTitle;
      if (!entry.locked && group.title !== title) {
        expected.set(group.id, title); entry.title = title;
        await saveGroups(groups);
        if ((await chrome.storage.local.get('instanceId')).instanceId !== instanceId) { expected.delete(group.id); return; }
        if (entry.locked || (observed.has(group.id) && observed.get(group.id) !== group.title)) { expected.delete(group.id); continue; }
        await chrome.tabGroups.update(group.id, { title });
        observed.set(group.id, title);
        expected.delete(group.id);
      }
    }
  }
  if ((await chrome.storage.local.get('instanceId')).instanceId === instanceId) await saveGroups(groups);
}
function schedule() {
  if (inflight) { again = true; return; }
  inflight = (async () => { do { again = false; try { await reconcile(); } catch {} } while (again); })().finally(() => { inflight = null; });
}
chrome.tabGroups.onUpdated.addListener(group => {
  if (expected.get(group.id) === group.title) return;
  observed.set(group.id, group.title);
  void changeGroups(groups => {
    for (const entry of Object.values(groups)) if (entry.id === group.id && group.title !== entry.title) entry.locked = true;
  });
});
chrome.tabGroups.onRemoved.addListener(groupId => {
  observed.delete(groupId);
  void changeGroups(groups => { for (const [k, entry] of Object.entries(groups)) if (entry.id === groupId) delete groups[k]; });
});
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') schedule(); });
chrome.tabs.onRemoved.addListener(schedule);
const APPROVAL_RETRY_INTERVAL_MS = 5000;
const APPROVAL_MAX_RETRY_DURATION_MS = 3 * 60 * 1000;
const APPROVAL_MAX_CLICKS_PER_CARD = 36;
const APPROVAL_DISMISSED_COOLDOWN_MS = 10000;
const APPROVAL_RESERVED_TIMEOUT_MS = 30 * 1000;
const APPROVAL_LABEL_MIN_INTERVAL_MS = 5000;
const APPROVAL_SESSION_WINDOW_MS = 60 * 1000;
const APPROVAL_MAX_CLICKS_PER_SESSION_WINDOW = 12;
const ALLOW_ONCE_RE = /^(?:allow once|allow just this once|yes, allow once|允许一次|只允许一次)$/i;
const numCfg = (key, fallback, min = 0) => {
  const raw = globalThis.__paseoApprovalConfig?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= min ? raw : fallback;
};
let approvalWrites = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'approval-reserve' || message?.type === 'approval-result') {
    const session = sessionId(sender.tab?.url);
    if (!session || sender.tab?.id == null || !/^[a-f0-9]{64}$/.test(message.digest || '')) return;
    const retryIntervalMs = numCfg('retryIntervalMs', APPROVAL_RETRY_INTERVAL_MS, 1);
    const maxRetryDurationMs = numCfg('maxRetryDurationMs', APPROVAL_MAX_RETRY_DURATION_MS, 1);
    const maxClicksPerCard = numCfg('maxClicksPerCard', APPROVAL_MAX_CLICKS_PER_CARD, 1);
    const dismissedCooldownMs = numCfg('dismissedCooldownMs', APPROVAL_DISMISSED_COOLDOWN_MS, 1);
    const reservedTimeoutMs = numCfg('reservedTimeoutMs', APPROVAL_RESERVED_TIMEOUT_MS, 1);
    const labelMinIntervalMs = numCfg('labelMinIntervalMs', APPROVAL_LABEL_MIN_INTERVAL_MS, 0);
    const sessionWindowMs = numCfg('sessionWindowMs', APPROVAL_SESSION_WINDOW_MS, 1);
    const maxClicksPerSessionWindow = numCfg('maxClicksPerSessionWindow', APPROVAL_MAX_CLICKS_PER_SESSION_WINDOW, 1);
    const cardId = typeof message.cardId === 'string' && message.cardId.trim().length > 0 && message.cardId.length <= 128
      ? message.cardId.trim()
      : undefined;
    const labelDigest = typeof message.labelDigest === 'string' && /^[a-f0-9]{64}$/.test(message.labelDigest)
      ? message.labelDigest
      : undefined;
    const operation = approvalWrites.then(async () => {
      const stored = await chrome.storage.local.get(['approvalAudit', 'approvalEnabled']);
      const audit = Array.isArray(stored.approvalAudit) ? stored.approvalAudit : [];
      const now = Date.now();
      for (const entry of audit) {
        if (entry.status === 'reserved') {
          const atMs = Date.parse(entry.at);
          if (!Number.isFinite(atMs) || now - atMs >= reservedTimeoutMs) {
            entry.status = 'still-visible';
            entry.observedAt = new Date(Number.isFinite(atMs) ? atMs + reservedTimeoutMs : now).toISOString();
          }
        }
      }
      if (message.type === 'approval-reserve') {
        if (stored.approvalEnabled !== true || typeof message.button !== 'string' || message.button.length > 100) return { allowed: false };
        const cardEntries = audit.filter(entry =>
          entry.sessionId === session && (cardId ? entry.cardId === cardId : !entry.cardId && entry.digest === message.digest),
        );
        const lastEntry = cardEntries.at(-1);
        if (lastEntry) {
          if (lastEntry.status === 'reserved') return { allowed: false };
          if (cardEntries.length >= maxClicksPerCard) return { allowed: false };
          const lastObservedMs = Date.parse(lastEntry.observedAt || lastEntry.at);
          const effectivePrevious = cardEntries.findLast(entry => entry.status !== 'skipped');
          if (effectivePrevious?.status === 'dismissed') {
            if (cardId || !Number.isFinite(lastObservedMs) || now - lastObservedMs < dismissedCooldownMs) return { allowed: false };
          } else if (effectivePrevious?.status === 'still-visible' || lastEntry.status === 'skipped') {
            if (!ALLOW_ONCE_RE.test(message.button.trim())) return { allowed: false };
            if (!message.resetRetryWindow) {
              const requiredWait = effectivePrevious?.status === 'still-visible' ? retryIntervalMs : Math.min(retryIntervalMs, dismissedCooldownMs);
              if (!Number.isFinite(lastObservedMs) || now - lastObservedMs < requiredWait) return { allowed: false };
              const windowStartEntry = cardEntries.findLast(entry => entry.retryWindowStartAt) || cardEntries[0];
              const firstMs = Date.parse(windowStartEntry.retryWindowStartAt || windowStartEntry.at || windowStartEntry.observedAt);
              if (!Number.isFinite(firstMs) || now - firstMs > maxRetryDurationMs) return { allowed: false };
            }
          } else {
            return { allowed: false };
          }
        }
        if (labelDigest) {
          const sameLabelEntries = audit.filter(entry => entry.sessionId === session && entry.labelDigest === labelDigest);
          const lastLabelEntry = sameLabelEntries.at(-1);
          if (lastLabelEntry) {
            if (lastLabelEntry.status === 'reserved') return { allowed: false };
            const lastLabelMs = Date.parse(lastLabelEntry.observedAt || lastLabelEntry.at);
            const isSameCardVisibilityReset = Boolean(message.resetRetryWindow && cardId && lastLabelEntry.cardId === cardId);
            if (!isSameCardVisibilityReset && (!Number.isFinite(lastLabelMs) || now - lastLabelMs < labelMinIntervalMs)) {
              return { allowed: false };
            }
          }
        }
        const recentSessionEntries = audit.filter(entry => {
          if (entry.sessionId !== session) return false;
          const entryMs = Date.parse(entry.at || entry.observedAt);
          return Number.isFinite(entryMs) && now - entryMs < sessionWindowMs;
        });
        if (recentSessionEntries.length >= maxClicksPerSessionWindow) return { allowed: false };
        const reservationId = crypto.randomUUID();
        audit.push({
          sessionId: session,
          tabId: sender.tab.id,
          digest: message.digest,
          ...(cardId ? { cardId } : {}),
          ...(labelDigest ? { labelDigest } : {}),
          ...(message.resetRetryWindow ? { retryWindowStartAt: new Date(now).toISOString() } : {}),
          reservationId,
          button: message.button,
          at: new Date(now).toISOString(),
          status: 'reserved',
        });
        await chrome.storage.local.set({ approvalAudit: audit.slice(-300) });
        schedule();
        return { allowed: true, reservationId };
      } else {
        const previous = audit.findLast(entry =>
          entry.sessionId === session && entry.reservationId === message.reservationId && entry.digest === message.digest,
        );
        if (!previous || previous.tabId !== sender.tab.id || previous.status !== 'reserved' || !['dismissed', 'still-visible', 'skipped'].includes(message.status)) return { allowed: false };
        previous.status = message.status;
        previous.observedAt = new Date(now).toISOString();
        if (message.readGate === 'read_gate_scrolled' || message.readGate === 'read_gate_blocked') previous.readGate = message.readGate;
        await chrome.storage.local.set({ approvalAudit: audit.slice(-300) });
        schedule();
        return { allowed: true, reservationId: previous.reservationId };
      }
    });
    approvalWrites = operation.catch(() => {});
    void operation.then(respond, () => respond({ allowed: false }));
    return true;
  }
  if ((message?.type === 'session-title-changed' || message?.type === 'questions-changed') && sender.tab?.id != null && sessionId(sender.tab.url)) schedule();
});
chrome.runtime.onStartup.addListener(schedule);
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    await Promise.all(tabs.filter(tab => tab.id != null).map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['title.js', 'approval.js', 'questions.js', 'activity.js'] }).catch(() => {})));
  } catch {}
  schedule();
});
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') schedule(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.pairing || changes.instanceName || changes.instanceId)) schedule(); });
chrome.alarms.create('sync', { periodInMinutes: 1 });
schedule();
