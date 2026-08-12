import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { createDashboardView } from '../public/modules/dashboard-view.mjs';
import { createTranscriptView } from '../public/modules/transcript-view.mjs';
import { ACTIONS, createStore } from '../public/modules/ui-store.mjs';

const uiRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const publicRoot = join(uiRoot, 'public');
const indexPath = join(publicRoot, 'index.html');
const layoutPath = join(publicRoot, 'styles', 'layout.css');

class FakeNode {
  constructor(name, documentRef) {
    this.name = name; this.ownerDocument = documentRef; this.nodeType = 1;
    this.attrs = {}; this.children = []; this.listeners = {}; this.clientHeight = name === 'pre' ? 854 : 944; this.scrollHeight = name === 'pre' ? 1704 : 944; this._scrollTop = 0;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
  contains() { return true; } querySelector(selector) { return descendants(this).find((node) => node.attrs.class === selector.slice(1)) ?? null; }
  get scrollTop() { return this._scrollTop; } set scrollTop(value) { this._scrollTop = Math.min(Math.max(Number(value) || 0, 0), Math.max(0, this.scrollHeight - this.clientHeight)); }
}

const renderDocument = {
  createElement(name) { return new FakeNode(name, renderDocument); },
  createTextNode(text) { return { nodeType: 3, ownerDocument: renderDocument, textContent: String(text) }; },
};

function descendants(node, result = []) {
  for (const child of node.children ?? []) {
    if (child.nodeType === 1) result.push(child);
    descendants(child, result);
  }
  return result;
}

function visibleText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (typeof node.textContent === 'string' && !(node.children?.length)) return node.textContent;
  return (node.children ?? []).map((child) => visibleText(child)).join('');
}

function filesUnder(root, extensions) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path, extensions));
    else if (extensions.some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

test('frontend asset references, markup, and source boundaries stay local and safe', () => {
  const html = readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const reference of refs) {
    if (reference.startsWith('#') || /^[a-z]+:/i.test(reference)) continue;
    const localPath = resolve(publicRoot, reference.split(/[?#]/, 1)[0]);
    assert.equal(statSync(localPath).isFile(), true, `missing local asset: ${reference}`);
  }
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b|\bstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//i);

  for (const file of filesUnder(publicRoot, ['.mjs'])) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function|document\.write/);
    assert.doesNotMatch(source, /https?:\/\//i, relative(uiRoot, file));
  }
});

test('favicon reference points to an existing local SVG', () => {
  const html = readFileSync(indexPath, 'utf8');
  const faviconLink = html.match(/<link\b[^>]*\brel=["']icon["'][^>]*>/i)?.[0];
  assert.ok(faviconLink, 'missing favicon link');
  assert.match(faviconLink, /\btype=["']image\/svg\+xml["']/i);
  const faviconReference = faviconLink.match(/\bhref=["']([^"']+)["']/i)?.[1];
  assert.equal(faviconReference, 'favicon.svg');
  assert.equal(statSync(join(publicRoot, faviconReference)).isFile(), true);
});

test('rail is removed, three columns stack on mobile, and graph motion is reducible', () => {
  const html = readFileSync(indexPath, 'utf8');
  const layoutCss = readFileSync(layoutPath, 'utf8');
  const graphCss = readFileSync(join(publicRoot, 'styles', 'orchestration-graph.css'), 'utf8');
  assert.doesNotMatch(html, /<aside\b[^>]*\bclass=["']rail/);
  assert.doesNotMatch(html, /data-action=["']refresh/);
  assert.doesNotMatch(layoutCss, /\.rail\b/);
  assert.match(layoutCss, /\.main\s*\{[\s\S]*grid-template-columns:/);
  assert.match(layoutCss, /@media\s*\(max-width:\s*1160px\)[\s\S]*\.main\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(graphCss, /prefers-reduced-motion/);
  assert.match(graphCss, /\.graph-edge\.is-target-working\s*\{[\s\S]*animation:\s*none/);
  assert.match(graphCss, /\.graph-node\s*\{[\s\S]*box-sizing:\s*border-box;[\s\S]*height:\s*7rem;[\s\S]*max-height:\s*7rem;[\s\S]*overflow:\s*hidden/);
  assert.match(graphCss, /\.graph-node-name,\s*\.graph-node-meta\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap/);
  assert.doesNotMatch(graphCss, /\.graph-node:focus-visible[^{}]*\.graph-node-name/); assert.match(graphCss, /\.graph-node\.is-disconnected \.graph-node-role[\s\S]*\.graph-node:focus-visible\s*\{[\s\S]*color:\s*var\(--bg\)[\s\S]*background:\s*var\(--accent\)[\s\S]*\}[\s\S]*\.graph-node:focus-visible \.graph-node-role,\s*\.graph-node:focus-visible \.graph-node-status,\s*\.graph-node:focus-visible \.graph-node-meta\s*\{\s*color:\s*var\(--bg\);\s*\}/);
  assert.match(html, /data-nav-target=["']runtime["']/);
});

test('all owned frontend code and styles stay below the 200-line limit', () => {
  const files = [
    ...filesUnder(publicRoot, ['.mjs', '.css']),
    join(uiRoot, 'test', 'view-models.test.mjs'),
    join(uiRoot, 'test', 'frontend-render-security.test.mjs'),
  ];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').length;
    assert.ok(lines < 200, `${relative(uiRoot, file)} has ${lines} lines`);
  }
});

test('every CSS custom property reference has a token definition', () => {
  const css = filesUnder(join(publicRoot, 'styles'), ['.css'])
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  const definitions = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const references = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
  for (const name of references) assert.equal(definitions.has(name), true, `undefined CSS var: --${name}`);
});

test('observer Settings surfaces are capability-gated and Claude-orange tokens remain intact', () => {
  const html = readFileSync(indexPath, 'utf8');
  assert.equal((html.match(/data-capability="settings"/g) ?? []).length, 2);
  assert.match(readFileSync(join(publicRoot, 'styles', 'tokens.css'), 'utf8'), /--color-primary:\s*#D97757/);
  assert.match(readFileSync(join(publicRoot, 'modules', 'orchestration-graph-view.mjs'), 'utf8'), /marker-end[\s\S]*data-relation/);
});

test('dashboard renders DAG nodes and native edges, preserves escaping, and selects a pane', async () => {
  const spacesRoot = new FakeNode('div', renderDocument);
  const graphRoot = new FakeNode('div', renderDocument);
  const runtime = {
    workspaces: [{ id: 'space-1' }],
    agents: [
      { paneId: 'controller-1', display: 'controller', workspaceId: 'space-1', status: 'idle', orchestration: { role: 'controller', parentPaneId: null, relation: null, task: 'root', runId: 'r1' } },
      { paneId: 'worker-1', display: '<worker>', workspaceId: 'space-1', status: 'working', orchestration: { role: 'worker', parentPaneId: 'controller-1', relation: 'delegate', task: 'ship-task', runId: 'r1' } },
      { paneId: 'reviewer-1', display: 'reviewer', workspaceId: 'space-1', status: 'idle', orchestration: { role: 'reviewer', parentPaneId: 'worker-1', relation: 'verify', task: 'check', runId: 'r1' } },
      { paneId: 'orphan-1', display: '<img>', workspaceId: 'space-1', status: 'idle', orchestration: null },
    ],
  };
  const selected = [];
  const store = {
    getState: () => ({ runtime, selectedWorkspace: null, transcript: null }),
    subscribe: () => () => {},
    dispatch() {},
  };
  const view = createDashboardView({ documentRef: renderDocument, store, agentsRoot: graphRoot, spacesRoot, onSelectPane: async (paneId) => selected.push(paneId) });
  const nodes = descendants(graphRoot).filter((node) => node.attrs['data-node-role']);
  const edges = descendants(graphRoot).filter((node) => node.name === 'line' && node.attrs['data-relation']);
  assert.equal(nodes.length, 4);
  assert.equal(edges.length, 4);
  assert.equal(new Set(edges.map((node) => node.attrs['data-relation'])).size, 2);
  assert.equal(edges.some((node) => node.attrs.class.includes('edge-delegate') && node.attrs.class.includes('is-target-working')), true);
  assert.equal(nodes.some((node) => node.attrs['data-node-role'] === 'unmapped'), true);
  assert.equal(descendants(graphRoot).some((node) => node.name === 'img'), false);
  assert.equal(visibleText(graphRoot).includes('<img>'), true);
  const worker = nodes.find((node) => node.attrs['data-pane-id'] === 'worker-1');
  await graphRoot.listeners.click({ target: { closest: () => worker } });
  assert.deepEqual(selected, ['worker-1']);
  view.destroy();
});

test('transcript renders loading/error states without an empty success pre', () => {
  const root = new FakeNode('div', renderDocument); const store = createStore();
  const view = createTranscriptView({ documentRef: renderDocument, store, root });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p1', requestId: 1 });
  assert.equal(descendants(root).some((node) => node.name === 'pre'), false);
  const loading = descendants(root).find((node) => node.attrs['aria-live']);
  assert.equal(loading.attrs.role, 'status'); assert.equal(loading.attrs['aria-live'], 'polite');
  assert.match(visibleText(root), /LOADING/);
  store.dispatch({ type: ACTIONS.TRANSCRIPT_ERROR, paneId: 'p1', requestId: 1, errorCode: 'ERR_SELECT' });
  assert.equal(descendants(root).some((node) => node.name === 'pre'), false);
  const error = descendants(root).find((node) => node.attrs['aria-live']);
  assert.equal(error.attrs.role, 'alert'); assert.equal(error.attrs['aria-live'], 'assertive');
  assert.match(visibleText(root), /ERR_SELECT/);
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p1', requestId: 2 });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 2, transcript: { paneId: 'p1', text: '', revision: 0 } });
  const pre = descendants(root).find((node) => node.name === 'pre');
  assert.ok(pre); assert.equal(pre.textContent, ''); assert.match(visibleText(root), /REVISION 0/);
  view.destroy();
});

test('transcript follow owns inner scrollback and preserves it while off', () => {
  const root = new FakeNode('div', renderDocument); const store = createStore(); const view = createTranscriptView({ documentRef: renderDocument, store, root });
  const transcript = (revision) => ({ paneId: 'p1', text: 'line\n'.repeat(300), revision });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p1', requestId: 1 });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 1, transcript: transcript(1) });
  let pre = descendants(root).find((node) => node.name === 'pre');
  assert.equal(root.scrollHeight - root.clientHeight, 0); assert.equal(root.scrollTop, 0); assert.equal(pre.scrollHeight - pre.clientHeight, 850); assert.equal(pre.scrollTop, 850);
  root.scrollTop = root.scrollHeight; assert.equal(root.scrollTop, 0, 'legacy root-only scrolling cannot move the inner owner');
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, requestId: 1, transcript: transcript(2) }); pre = descendants(root).find((node) => node.name === 'pre'); assert.equal(pre.scrollTop, 850); pre.scrollTop = 321;
  store.dispatch({ type: ACTIONS.FOLLOW_TAIL_SET, followTail: false }); pre = descendants(root).find((node) => node.name === 'pre'); assert.equal(pre.scrollTop, 321);
  store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, requestId: 1, transcript: transcript(3) }); pre = descendants(root).find((node) => node.name === 'pre'); assert.equal(pre.scrollTop, 321);
  store.dispatch({ type: ACTIONS.FOLLOW_TAIL_SET, followTail: true }); pre = descendants(root).find((node) => node.name === 'pre'); assert.equal(pre.scrollTop, 850); view.destroy();
});
