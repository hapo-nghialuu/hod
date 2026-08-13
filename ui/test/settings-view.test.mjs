import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsView } from '../public/modules/settings-view.mjs';
import { ACTIONS, createStore } from '../public/modules/ui-store.mjs';

class FakeNode {
  constructor(name, documentRef) {
    this.name = name; this.ownerDocument = documentRef; this.nodeType = 1;
    this.attrs = {}; this.children = []; this.listeners = {};
  }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
  closest(selector) {
    if (selector === '[data-action]' && this.attrs['data-action']) return this;
    if (selector === '[data-action="settings-project"]' && this.attrs['data-action'] === 'settings-project') return this;
    return null;
  }
  querySelector(selector) {
    return descendants(this).find((node) => selector === '[data-setting-input]' && node.attrs['data-setting-input'] !== undefined
      || selector === '[data-setting-key]' && node.attrs['data-setting-key'] !== undefined
      || selector === '.herdr-row' && node.attrs.class?.includes('herdr-row')) ?? null;
  }
  contains() { return true; }
}

const documentRef = {
  createElement(name) { return new FakeNode(name, documentRef); },
  createTextNode(text) { return { nodeType: 3, ownerDocument: documentRef, textContent: String(text) }; },
};

function descendants(node, name, result = []) {
  for (const child of node.children ?? []) {
    if (child.name === name) result.push(child);
    descendants(child, name, result);
  }
  return result;
}

test('generated setting controls have stable unique ids and matching labels', () => {
  const root = new FakeNode('main', documentRef); let notify;
  const state = { settings: { hod: { roles: [] }, herdr: { settings: [
    { key: 'theme.name', value: 'terminal', source: 'config', metadata: { type: 'string', enum: ['terminal'] } },
    { key: 'advanced.scrollback_limit_bytes', value: 262144, source: 'default', metadata: { type: 'integer' } },
  ] } } };
  const store = { getState: () => state, subscribe(callback) { notify = callback; return () => {}; } };
  const view = createSettingsView({ documentRef, root, store, confirmDialog: { confirm: async () => false, destroy() {} } });
  const controls = descendants(root, 'select').concat(descendants(root, 'input')).filter((node) => node.attrs['data-setting-input'] !== undefined);
  const labels = descendants(root, 'label').filter((node) => node.attrs.for && node.attrs.for !== 'settings-workspace-selector');
  const ids = controls.map((control) => control.attrs.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(labels.length, controls.length);
  assert.deepEqual(labels.map((label) => label.attrs.for), ids);
  for (const [index, label] of labels.entries()) {
    if ('htmlFor' in label) assert.equal(label.htmlFor, ids[index]);
  }
  const firstIds = [...ids]; notify();
  const secondIds = descendants(root, 'select').concat(descendants(root, 'input'))
    .filter((node) => node.attrs['data-setting-input'] !== undefined).map((node) => node.attrs.id);
  assert.deepEqual(secondIds, firstIds);
  view.destroy();
});

const settings = (selectedWorkspaceId = null) => ({
  projects: [{ workspaceId: 'w1', label: 'One' }, { workspaceId: 'w2', label: 'Two' }],
  selectedWorkspaceId,
  hod: { roles: [{ role: 'impl', status: 'different', unsafe: false }] },
  herdr: { settings: [] },
});

const flush = async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('selector ignores stale out-of-order responses and preserves the last valid selection on error', async () => {
  const root = new FakeNode('main', documentRef); const store = createStore({ settings: settings() });
  const pending = new Map(); const loaded = []; const errors = []; const started = [];
  const view = createSettingsView({
    documentRef, root, store,
    onWorkspaceStart: (workspaceId) => started.push(workspaceId),
    onWorkspaceSelect: (workspaceId) => new Promise((resolve, reject) => pending.set(workspaceId, { resolve, reject })),
    onWorkspaceLoaded: (workspaceId) => loaded.push(workspaceId),
    onWorkspaceError: (error) => errors.push(error.code),
    confirmDialog: { confirm: async () => false, destroy() {} },
  });
  let selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
  assert.equal(selector.attrs['aria-label'], 'Project or space');
  assert.equal(descendants(root, 'label').some((node) => node.attrs.for === 'settings-workspace-selector'), true);
  assert.equal(descendants(root, 'button').find((node) => node.attrs['data-role'] === 'impl').attrs.disabled, '');
  selector.value = 'w1'; root.listeners.change({ target: selector });
  selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
  selector.value = 'w2'; root.listeners.change({ target: selector });
  pending.get('w2').resolve(settings('w2')); await flush();
  pending.get('w1').resolve(settings('w1')); await flush();
  assert.deepEqual(started, ['w1', 'w2']);
  assert.deepEqual(loaded, ['w2']);
  assert.deepEqual(errors, []);
  assert.equal(store.getState().selectedWorkspace, 'w2');
  assert.equal(store.getState().settings.selectedWorkspaceId, 'w2');

  selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
  selector.value = 'unknown'; root.listeners.change({ target: selector });
  pending.get('unknown').reject(Object.assign(new Error('stale'), { code: 'ERR_WORKSPACE_NOT_FOUND' })); await flush();
  assert.deepEqual(errors, ['ERR_WORKSPACE_NOT_FOUND']);
  assert.equal(store.getState().selectedWorkspace, 'w2');
  view.destroy();
});

test('reconnect invalidates pending workspace responses and clears selector pending state', async () => {
  const reconnectActions = [
    { type: ACTIONS.RECONNECTING },
    { type: ACTIONS.CONNECTION, connection: { status: 'connecting' } },
    { type: ACTIONS.CONNECTION, connection: { status: 'reconnecting' } },
    { type: ACTIONS.CONNECTION, connection: { status: 'disconnected' } },
  ];
  for (const action of reconnectActions) {
    const root = new FakeNode('main', documentRef); const store = createStore({ settings: settings() });
    let resolveSettings; const loaded = []; const errors = [];
    const view = createSettingsView({
      documentRef, root, store,
      onWorkspaceSelect: () => new Promise((resolve) => { resolveSettings = resolve; }),
      onWorkspaceLoaded: (workspaceId) => loaded.push(workspaceId),
      onWorkspaceError: (error) => errors.push(error),
      confirmDialog: { confirm: async () => false, destroy() {} },
    });
    let selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
    selector.value = 'w1'; root.listeners.change({ target: selector });
    selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
    assert.equal(selector.attrs.disabled, '');
    store.dispatch(action);
    selector = descendants(root, 'select').find((node) => node.attrs['data-action'] === 'settings-project');
    assert.equal(selector.attrs.disabled, undefined);
    resolveSettings(settings('w1')); await flush();
    assert.equal(store.getState().selectedWorkspace, null);
    assert.equal(store.getState().settings.selectedWorkspaceId, null);
    assert.deepEqual(loaded, []);
    assert.deepEqual(errors, []);
    view.destroy();
  }
});

test('role confirmation captures the selected workspace at click time', async () => {
  const root = new FakeNode('main', documentRef); const store = createStore({ settings: settings('w2'), selectedWorkspace: 'w2' });
  let resolveConfirm; const saved = [];
  const view = createSettingsView({
    documentRef, root, store,
    onHodSave: async (request) => saved.push(request),
    confirmDialog: { confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }), destroy() {} },
  });
  const button = descendants(root, 'button').find((node) => node.attrs['data-action'] === 'role-save' && node.attrs['data-role'] === 'impl');
  assert.equal(button.attrs.disabled, undefined);
  root.listeners.click({ target: button });
  store.dispatch({ type: ACTIONS.WORKSPACE_SET, selectedWorkspace: 'w1' });
  resolveConfirm(true); await flush();
  assert.deepEqual(saved, [{ workspaceId: 'w2', role: 'impl', force: true, confirmation: 'OVERWRITE HOD ROLE' }]);
  view.destroy();
});

test('legacy project settings keep an implicit project target and old mutation shape', async () => {
  const root = new FakeNode('main', documentRef); const store = createStore({ settings: {
    hod: { roles: [{ role: 'impl', status: 'different', unsafe: false }] }, herdr: { settings: [] },
  } }); const saved = [];
  const view = createSettingsView({
    documentRef, root, store, onHodSave: async (request) => saved.push(request),
    confirmDialog: { confirm: async () => true, destroy() {} },
  });
  assert.equal(descendants(root, 'select').some((node) => node.attrs['data-action'] === 'settings-project'), false);
  const button = descendants(root, 'button').find((node) => node.attrs['data-role'] === 'impl');
  assert.equal(button.attrs.disabled, undefined); root.listeners.click({ target: button }); await flush();
  assert.deepEqual(saved, [{ role: 'impl', force: true, confirmation: 'OVERWRITE HOD ROLE' }]);
  view.destroy();
});
