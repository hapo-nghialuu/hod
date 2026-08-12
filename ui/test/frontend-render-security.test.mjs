import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createDashboardView } from '../public/modules/dashboard-view.mjs';
import { ansiSegments, createTranscriptView } from '../public/modules/transcript-view.mjs';
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
  styleSheets: [{ href: 'http://127.0.0.1/styles/runtime-view.css', cssRules: [], insertRule(rule) { this.cssRules.push(rule); } }],
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

test('compact three-pane layout adapts on medium/mobile and graph motion is reducible', () => {
  const html = readFileSync(indexPath, 'utf8');
  const layoutCss = readFileSync(layoutPath, 'utf8');
  const graphCss = readFileSync(join(publicRoot, 'styles', 'orchestration-graph.css'), 'utf8'); const runtimeCss = readFileSync(join(publicRoot, 'styles', 'runtime-view.css'), 'utf8');
  assert.doesNotMatch(html, /<aside\b[^>]*\bclass=["']rail/);
  assert.doesNotMatch(html, /data-action=["']refresh/); assert.match(html, /<footer\b[^>]*class=["']statusbar["'][^>]*\bhidden\b/); assert.match(layoutCss, /\.statusbar\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(layoutCss, /\.rail\b/);
  assert.match(layoutCss, /\.main\s*\{[\s\S]*grid-template-columns:/);
  assert.match(layoutCss, /@media\s*\(max-width:\s*1040px\)[\s\S]*\.app\s*\{[^}]*overflow:\s*auto[\s\S]*grid-template-rows:/); assert.match(layoutCss, /@media\s*\(max-width:\s*760px\)[\s\S]*\.main\s*\{[^}]*flex-direction:\s*column/);
  assert.match(graphCss, /prefers-reduced-motion/);
  assert.match(graphCss, /\.graph-edge\.is-target-working\s*\{[\s\S]*animation:\s*none/);
  assert.match(graphCss, /\.graph-stage\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-height:\s*340px;[\s\S]*overflow:\s*auto/); assert.match(graphCss, /\.graph-canvas\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*100%/); assert.match(graphCss, /\.graph-node\s*\{[\s\S]*box-sizing:\s*border-box;[\s\S]*height:\s*5\.5rem;[\s\S]*max-height:\s*5\.5rem;[\s\S]*overflow:\s*hidden/);
  assert.match(graphCss, /\.graph-node-name,\s*\.graph-node-meta\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap/);
  assert.match(graphCss, /\.graph-agent-antenna,[\s\S]*\.graph-agent-shell,[\s\S]*stroke:\s*currentColor/); assert.match(graphCss, /\.graph-node-controller[^}]*--node-role-color:\s*var\(--role-coordinator\)[\s\S]*\.graph-node-worker[^}]*--node-role-color:\s*var\(--role-worker\)[\s\S]*\.graph-node-advisor[^}]*--node-role-color:\s*var\(--role-advisor\)/);
  assert.match(graphCss, /\.graph-node\.is-working \.graph-agent-signal[\s\S]*animation:\s*graph-agent-signal/); assert.match(graphCss, /prefers-reduced-motion[\s\S]*\.graph-node\.is-working \.graph-agent-signal[\s\S]*animation:\s*none/); assert.match(runtimeCss, /\.space-button\.is-working \.space-label::before[\s\S]*space-active-pulse[\s\S]*prefers-reduced-motion/);
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
    workspaces: [{ id: 'space-1', status: 'working' }],
    agents: [
      { paneId: 'controller-1', display: 'controller', workspaceId: 'space-1', status: 'idle', orchestration: { role: 'controller', parentPaneId: null, relation: null, task: 'root', runId: 'r1' } },
      { paneId: 'worker-1', display: '<worker>', workspaceId: 'space-1', status: 'working', orchestration: { role: 'worker', parentPaneId: 'controller-1', relation: 'delegate', task: 'ship-task', runId: 'r1' } },
      { paneId: 'reviewer-1', display: 'reviewer', workspaceId: 'space-1', status: 'idle', orchestration: { role: 'reviewer', parentPaneId: 'worker-1', relation: 'verify', task: 'check', runId: 'r1' } },
      { paneId: 'orphan-1', display: '<img>', workspaceId: 'space-1', status: 'idle', orchestration: null },
    ],
  };
  const selected = []; let renderListener = null;
  const dashboardState = { runtime, selectedWorkspace: null, transcript: null };
  const store = {
    getState: () => dashboardState,
    subscribe: (listener) => { renderListener = listener; return () => { renderListener = null; }; },
    dispatch() {},
  };
  const view = createDashboardView({ documentRef: renderDocument, store, agentsRoot: graphRoot, spacesRoot, onSelectPane: async (paneId) => selected.push(paneId) });
  const spaceRows = descendants(spacesRoot).filter((node) => Object.hasOwn(node.attrs, 'data-space-id')); assert.equal(spaceRows.find((node) => node.attrs['data-space-id'] === '').attrs.class, 'space-button is-selected'); assert.equal(spaceRows.find((node) => node.attrs['data-space-id'] === 'space-1').attrs.class, 'space-button is-working');
  const nodes = descendants(graphRoot).filter((node) => node.attrs['data-node-role']);
  const edges = descendants(graphRoot).filter((node) => node.name === 'line' && node.attrs['data-relation']);
  assert.equal(nodes.length, 4);
  assert.equal(edges.length, 4);
  assert.equal(new Set(edges.map((node) => node.attrs['data-relation'])).size, 2);
  assert.equal(edges.some((node) => node.attrs.class.includes('edge-delegate') && node.attrs.class.includes('is-target-working')), true);
  assert.equal(nodes.some((node) => node.attrs['data-node-role'] === 'unmapped'), true);
  assert.equal(descendants(graphRoot).some((node) => node.name === 'img'), false);
  assert.equal(visibleText(graphRoot).includes('<img>'), true);
  assert.match(visibleText(graphRoot), /\[WORKER\]/); assert.match(visibleText(graphRoot), /\[REVIEWER\]/);
  const worker = nodes.find((node) => node.attrs['data-pane-id'] === 'worker-1');
  await graphRoot.listeners.click({ target: { closest: () => worker } });
  assert.deepEqual(selected, ['worker-1']);
  const zoomIn = descendants(graphRoot).find((node) => node.attrs['aria-label'] === 'Zoom in');
  zoomIn.listeners.click();
  const zoomedTransform = descendants(graphRoot).find((node) => node.attrs.class === 'graph-viewport-layer').attrs.transform;
  assert.match(zoomedTransform, /scale\(1\.2\)$/); renderListener(dashboardState);
  assert.equal(descendants(graphRoot).find((node) => node.attrs.class === 'graph-viewport-layer').attrs.transform, zoomedTransform);
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

test('ANSI transcript stays safe and always owns the newest inner scrollback', () => {
  const root = new FakeNode('div', renderDocument); const store = createStore(); const view = createTranscriptView({ documentRef: renderDocument, store, root }); assert.ok(ansiSegments('\u001b[31ma\u001b[32mb'.repeat(20_001)).length <= 20_000);
  const transcript = (revision) => ({ paneId: 'p1', text: `\u001b]52;c;secret\u0007\u001bPprivate\u001b\\\u001b[1;38;2;217;119;87mline ${revision}\u001b[0m <script>\r\n`.repeat(300), revision });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId: 'p1', requestId: 1 });
  store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, requestId: 1, transcript: transcript(1) });
  let pre = descendants(root).find((node) => node.name === 'pre');
  assert.equal(root.scrollHeight - root.clientHeight, 0); assert.equal(root.scrollTop, 0); assert.equal(pre.scrollHeight - pre.clientHeight, 850); assert.equal(pre.scrollTop, 850); assert.equal(pre.attrs.role, 'region'); assert.equal(visibleText(pre).includes('\u001b'), false); assert.equal(visibleText(pre).includes('secret'), false); assert.equal(visibleText(pre).includes('private'), false); assert.equal(visibleText(pre).includes('<script>'), true); assert.equal(descendants(root).some((node) => node.attrs['data-action'] === 'follow-toggle'), false); assert.match(descendants(pre).find((node) => node.name === 'span').attrs.class, /ansi-bold ansi-fg-d97757/); assert.match(renderDocument.styleSheets[0].cssRules.join(''), /\.ansi-fg-d97757\{color:#d97757\}/);
  root.scrollTop = root.scrollHeight; assert.equal(root.scrollTop, 0, 'legacy root-only scrolling cannot move the inner owner');
  pre.scrollTop = 321; store.dispatch({ type: ACTIONS.TRANSCRIPT_PUSH, requestId: 1, transcript: transcript(2) }); pre = descendants(root).find((node) => node.name === 'pre'); assert.equal(pre.scrollTop, 850); view.destroy();
});
