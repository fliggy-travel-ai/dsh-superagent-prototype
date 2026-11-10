import { isUnreadAutomaticAnswer } from '../shared/presence.ts';
import type { useControlState, useStoreState } from './ui.tsx';

let lastNonTodoPage = 'providers';

export function getLastNonTodoPage(): string {
  return lastNonTodoPage;
}

export function setLastNonTodoPage(page: string): void {
  if (page && page !== 'todo') {
    lastNonTodoPage = page;
  }
}

export function computeHasAlert(
  storeState: ReturnType<typeof useStoreState>,
  controlState: ReturnType<typeof useControlState>,
): boolean {
  const { snapshot, error } = storeState;
  const { modules, machineSettings, claudeAccounts, escalation, escalationError } = controlState;
  if (error || snapshot?.error) return true;
  if (snapshot?.preferences.enabled && !snapshot.token.configured) return true;
  if (snapshot?.repositories.some(repo => Boolean(repo.error))) return true;
  if (modules?.config.errors.length || modules?.modules.some(m => m.state === 'error')) return true;
  if (machineSettings?.errors.length) return true;
  if (claudeAccounts?.accounts.some(acc => acc.needsRelogin) || claudeAccounts?.error) return true;
  if (escalationError || escalation?.error || escalation?.status === 'error') return true;
  return false;
}

export function computeTodoCount(controlState: ReturnType<typeof useControlState>): number {
  if (controlState.todo) {
    return controlState.todo.items.length;
  }
  const questions = controlState.presence?.questions ?? [];
  const activeBrowser = questions.filter(q => q.source === 'browser' && q.state === 'pending' && !q.delegatedTo);
  const webQuestions = activeBrowser.length;
  const nativeQuestions = questions.filter(
    q =>
      q.source === 'native' &&
      q.state === 'pending' &&
      !q.delegatedTo &&
      !q.webRetry &&
      !activeBrowser.some(bq => bq.id === q.id || bq.fingerprint === q.fingerprint || bq.delegatedTo === q.id),
  ).length;
  const unreadAuto = questions.filter(q => isUnreadAutomaticAnswer(q)).length;
  const webRetry = questions.filter(q => q.webRetry && q.state !== 'resolved').length;
  const stalled = controlState.stalled?.sessions.length ?? 0;
  const escalations = controlState.escalation?.pendingEvents.length ?? 0;
  return webQuestions + nativeQuestions + unreadAuto + webRetry + stalled + escalations;
}
