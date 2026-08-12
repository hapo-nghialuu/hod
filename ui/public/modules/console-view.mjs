import { setAttribute, textContent } from './dom-helpers.mjs';
import { ACTIONS, canUseCapability } from './ui-store.mjs';

function safeStatus(value, fallback = '—') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return text || fallback;
}

function stateClass(value) {
  if (value === 'connected' || value === 'OK' || value === 'success') return 'status-ok';
  if (value === 'disconnected' || value === 'error' || /^ERR_/.test(value)) return 'status-err';
  return 'status-warn';
}

function setActive(element, active) {
  element.classList?.toggle?.('is-active', active);
  if (!element.classList) {
    const current = element.getAttribute?.('class') ?? '';
    const classes = current.split(/\s+/).filter(Boolean).filter((item) => item !== 'is-active');
    if (active) classes.push('is-active');
    setAttribute(element, 'class', classes.join(' '));
  }
  if (active) setAttribute(element, 'aria-current', 'page');
  else element.removeAttribute?.('aria-current');
}

function setHidden(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) {
    setAttribute(element, 'hidden', '');
    setAttribute(element, 'aria-hidden', 'true');
  } else {
    element.removeAttribute?.('hidden');
    element.removeAttribute?.('aria-hidden');
  }
}

function settingsAvailable(state) {
  return canUseCapability(state, 'settings');
}

function render(documentRef, state) {
  const settingsEnabled = settingsAvailable(state);
  const view = state.view === 'settings' && settingsEnabled ? 'settings' : 'runtime';
  const app = documentRef?.getElementById?.('app');
  const runtimePanes = ['view-spaces', 'view-agents', 'view-transcript']
    .map((id) => documentRef?.getElementById?.(id)).filter(Boolean);
  const settingsPane = documentRef?.getElementById?.('view-settings');
  if (app) setAttribute(app, 'data-view', view);
  for (const pane of runtimePanes) setHidden(pane, view !== 'runtime');
  setHidden(settingsPane, !settingsEnabled || view !== 'settings');
  for (const link of Array.from(documentRef?.querySelectorAll?.('[data-nav-target]') ?? [])) {
    if (link.getAttribute?.('data-nav-target') === 'settings') setHidden(link, !settingsEnabled);
    setActive(link, link.getAttribute?.('data-nav-target') === view);
  }
  const connection = documentRef?.getElementById?.('connection-status');
  const connectionState = safeStatus(state.connection?.status, 'unknown');
  if (connection) {
    textContent(connection, connectionState);
    setAttribute(connection, 'data-connection-state', connectionState);
    connection.classList?.toggle?.('status-ok', connectionState === 'connected');
    connection.classList?.toggle?.('status-err', connectionState === 'disconnected');
  }
  const message = documentRef?.querySelector?.('[data-statusbar-message]');
  const status = documentRef?.querySelector?.('[data-statusbar-status]');
  const messageText = safeStatus(state.statusbar?.message, 'hod UI console');
  const statusText = safeStatus(state.statusbar?.status === '—' ? connectionState : state.statusbar?.status);
  if (message) textContent(message, messageText);
  if (status) {
    textContent(status, statusText);
    status.classList?.remove?.('status-ok', 'status-warn', 'status-err');
    status.classList?.add?.(stateClass(statusText));
  }
}

export function createConsoleView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const store = options.store;
  if (!documentRef || !store) return Object.freeze({ destroy() {} });
  const links = Array.from(documentRef.querySelectorAll?.('[data-nav-target]') ?? []);
  const settingsPane = documentRef.getElementById?.('view-settings');
  const refresh = documentRef.querySelector?.('[data-action="refresh"]');
  const onNavigate = (event) => {
    const link = event.target?.closest?.('[data-nav-target]');
    if (!link) return;
    event.preventDefault?.();
    const view = link.getAttribute('data-nav-target');
    if (view === 'settings' && !settingsAvailable(store.getState())) return;
    store.dispatch({ type: ACTIONS.VIEW_SET, view });
    options.onNavigate?.(view);
  };
  const onSettingsAction = (event) => {
    if (settingsAvailable(store.getState())) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  const onRefresh = () => options.onRefresh?.();
  for (const link of links) link.addEventListener?.('click', onNavigate);
  settingsPane?.addEventListener?.('click', onSettingsAction);
  refresh?.addEventListener?.('click', onRefresh);
  const unsubscribe = store.subscribe((state) => render(documentRef, state));
  render(documentRef, store.getState());
  return Object.freeze({ render: (state) => render(documentRef, state), destroy() {
    unsubscribe();
    for (const link of links) link.removeEventListener?.('click', onNavigate);
    settingsPane?.removeEventListener?.('click', onSettingsAction);
    refresh?.removeEventListener?.('click', onRefresh);
  } });
}

export const mountConsoleView = createConsoleView;
export { safeStatus, render as renderConsole };
