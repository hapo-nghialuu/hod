import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsView } from '../public/modules/settings-view.mjs';

class FakeNode {
  constructor(name, documentRef) {
    this.name = name; this.ownerDocument = documentRef; this.nodeType = 1;
    this.attrs = {}; this.children = []; this.listeners = {};
  }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'id') this.id = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
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
  const labels = descendants(root, 'label');
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
