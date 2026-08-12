import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient, readBootstrapToken } from '../public/modules/api-client.mjs';
import { ownsTranscriptRequest } from '../public/app.mjs';
import { createConsoleView } from '../public/modules/console-view.mjs';
import { createElement, setAttribute, textContent } from '../public/modules/dom-helpers.mjs';
import { ACTIONS, createStore } from '../public/modules/ui-store.mjs';

function response(value, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => value };
}

function consoleElement(attributes = {}) {
  const listeners = {};
  return {
    nodeType: 1, hidden: false, attributes: { ...attributes },
    classList: { toggle() {}, remove() {}, add() {} },
    getAttribute(name) { return this.attributes[name] ?? null; },
    closest() { return this; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, listener) { listeners[name] = listener; },
    removeEventListener(name) { delete listeners[name]; },
    click() { let prevented = false; listeners.click?.({ target: this, preventDefault() { prevented = true; } }); return prevented; },
  };
}

test('bootstrap clears the token fragment after both failed and successful exchanges', async () => {
  const locationRef = { hash: '#token=boot-secret', pathname: '/ui', search: '?x=1' };
  const replaced = [];
  let shouldFail = true;
  const calls = [];
  const client = createApiClient({
    locationRef,
    historyRef: { replaceState: (...args) => replaced.push(args) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return shouldFail ? response({}, 401) : response({ ok: true });
    },
  });

  await assert.rejects(client.bootstrapSession(), /API request failed/);
  assert.deepEqual(replaced[0], [null, '', '/ui?x=1']);
  assert.equal(readBootstrapToken(locationRef), 'boot-secret');

  shouldFail = false;
  await client.bootstrapSession();
  assert.equal(replaced.length, 2);
  assert.equal(calls[0].url, '/api/session');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['X-HOD-Bootstrap'], 'boot-secret');
});

test('custom SSE events use injected EventSource and JSON payloads', () => {
  class FakeEventSource {
    constructor(url, options) { this.url = url; this.options = options; this.listeners = {}; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    emit(name, data) { this.listeners[name]?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const seen = [];
  const client = createApiClient({ EventSourceImpl: FakeEventSource, fetchImpl: async () => response({}) });
  const source = client.openEvents({ onEvent: (name, payload) => seen.push([name, payload]) });
  source.emit('state', { agents: [] });
  assert.equal(source.url, '/api/events');
  assert.equal(source.options.withCredentials, true);
  assert.deepEqual(seen, [['state', { agents: [] }]]);
});

test('runtime-only capabilities hide and block Settings while legacy state stays enabled', () => {
  const app = consoleElement(); const spaces = consoleElement(); const agents = consoleElement();
  const transcript = consoleElement(); const settingsPane = consoleElement(); const runtimeLink = consoleElement({ 'data-nav-target': 'runtime' });
  const settingsLink = consoleElement({ 'data-nav-target': 'settings' }); const connection = consoleElement();
  const message = consoleElement(); const status = consoleElement();
  const documentRef = {
    getElementById(id) { return { app, 'view-spaces': spaces, 'view-agents': agents, 'view-transcript': transcript,
      'view-settings': settingsPane, 'connection-status': connection }[id]; },
    querySelectorAll() { return [runtimeLink, settingsLink]; },
    querySelector(selector) { return selector.includes('message') ? message : status; },
  };
  const legacyStore = createStore(); const legacyView = createConsoleView({ documentRef, store: legacyStore });
  assert.equal(settingsLink.hidden, false); legacyView.destroy();
  const store = createStore();
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { capabilities: { settings: false }, agents: [] } });
  const view = createConsoleView({ documentRef, store });
  assert.equal(settingsLink.hidden, true); assert.equal(settingsPane.hidden, true); assert.equal(settingsLink.click(), true);
  assert.equal(store.getState().view, 'runtime');
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { agents: [] } });
  assert.equal(settingsLink.hidden, false);
  store.dispatch({ type: ACTIONS.VIEW_SET, view: 'settings' });
  assert.equal(store.getState().view, 'settings');
  view.destroy();
});

test('store normalizes nested and partial capability shapes without weakening false', () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { runtime: { capabilities: { settings: false } }, agents: [] } });
  assert.deepEqual(store.getState().capabilities, { settings: false, control: true, mutation: true });
});

test('authoritative snapshots and reconnects clear stale runtime data but keep settings', () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.VIEW_SET, view: 'settings' });
  store.dispatch({ type: ACTIONS.FOLLOW_TAIL_SET, followTail: false });
  store.dispatch({ type: ACTIONS.SETTINGS_REPLACE, settings: { values: { enabled: true } } });
  store.dispatch({
    type: ACTIONS.STATE_REPLACE,
    state: { selectedPaneId: 'pane-1', agents: [{ paneId: 'pane-1', status: 'working' }] },
  });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, transcript: { paneId: 'pane-1', lines: ['one'] } });
  store.dispatch({ type: ACTIONS.WORKSPACE_SET, selectedWorkspace: 'workspace-1' });

  store.dispatch({ type: ACTIONS.CONNECTION, connection: { status: 'reconnecting', errorCode: 'ERR_SOCKET' } });
  let state = store.getState();
  assert.equal(state.runtime, null);
  assert.equal(state.transcript, null);
  assert.equal(state.selectedWorkspace, null);
  assert.deepEqual(state.settings, { values: { enabled: true } });
  assert.equal(state.connection.errorCode, 'ERR_SOCKET');
  assert.equal(state.view, 'settings');
  assert.equal(state.followTail, false);

  store.dispatch({ type: ACTIONS.CONNECTION, connection: { status: 'disconnected', error: 'raw secret' } });
  state = store.getState();
  assert.equal(state.settings.values.enabled, true);
  assert.equal(state.connection.errorCode, null);
});

test('state replacement drops a transcript whose pane is no longer authoritative', () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { selectedPaneId: 'pane-1', agents: [{ paneId: 'pane-1' }] } });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, transcript: { paneId: 'pane-1', lines: [] } });
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { selectedPaneId: 'pane-2', agents: [{ paneId: 'pane-2' }] } });
  assert.equal(store.getState().transcript, null);
});

test('store updates are immutable and unsubscribe stops notifications', () => {
  const store = createStore();
  const source = { agents: [] };
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: source });
  source.agents.push({ id: 'later' });
  assert.deepEqual(store.getState().runtime, { agents: [] });
  assert.equal(calls, 1);
  unsubscribe();
  store.dispatch({ type: ACTIONS.WORKSPACE_SET, selectedWorkspace: 'x' });
  assert.equal(calls, 1);
});

test('transcript request ownership rejects stale, missing, and regressing updates', () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p1', requestId: 1 }); assert.equal(store.getState().transcript.status, 'loading');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, transcript: { paneId: 'p1', text: 'missing', revision: 1 } });
  assert.equal(store.getState().transcript.status, 'loading');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, transcript: { paneId: 'p1', text: 'push', revision: 1 } });
  assert.equal(store.getState().transcript.status, 'loading');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p2', requestId: 2 });
  assert.equal(ownsTranscriptRequest(store, 'p2', 2), true);
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, transcript: { paneId: 'p1', text: 'cross-pane', revision: 2 } }); assert.equal(store.getState().transcript.paneId, 'p2');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 1, transcript: { paneId: 'p1', text: 'stale', revision: 1 } });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_ERROR, paneId: 'p2', errorCode: 'ERR_MISSING' });
  assert.equal(store.getState().transcript.status, 'loading');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 2, transcript: { paneId: 'p2', text: '', revision: 2 } });
  assert.equal(store.getState().transcript.status, 'success');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, transcript: { paneId: 'p2', text: 'regression', revision: 1 } });
  assert.equal(store.getState().transcript.text, '');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, transcript: { paneId: 'p2', text: 'live', revision: 2 } });
  assert.equal(store.getState().transcript.text, 'live');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p3', requestId: 3 });
  store.dispatch({ type: ACTIONS.STATE_REPLACE, state: { selectedPaneId: null, agents: [{ paneId: 'p3' }] } });
  assert.equal(ownsTranscriptRequest(store, 'p3', 3), false);
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 3, transcript: { paneId: 'p3', text: 'late', revision: 3 } });
  assert.equal(store.getState().transcript, null);
});

test('DOM helpers accept text nodes and reject executable attributes', () => {
  const documentRef = {
    createElement(name) {
      return {
        nodeType: 1,
        ownerDocument: documentRef,
        name,
        attrs: {},
        children: [],
        setAttribute(key, value) { this.attrs[key] = value; },
        appendChild(child) { this.children.push(child); },
      };
    },
    createTextNode(value) { return { nodeType: 3, ownerDocument: documentRef, textContent: value }; },
  };
  const element = createElement('div', { 'data-safe': 'yes' }, ['<not-markup>'], documentRef);
  textContent(element.children[0], 'plain text');
  assert.equal(element.attrs['data-safe'], 'yes');
  assert.equal(element.children[0].textContent, 'plain text');
  assert.throws(() => setAttribute(element, 'onclick', 'bad'), /unsafe attribute/);
  assert.throws(() => setAttribute(element, 'srcdoc', 'bad'), /unsafe attribute/);
});
