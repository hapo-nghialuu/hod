import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrchestrationGraphModel,
  renderOrchestrationGraph,
} from '../public/modules/orchestration-graph-view.mjs';

function agent(id, role, options = {}) {
  const controller = role === 'controller';
  return {
    paneId: id,
    workspaceId: 'space',
    display: id,
    status: options.status ?? 'idle',
    orchestration: {
      role,
      parentPaneId: options.parentPaneId ?? (controller ? null : 'controller'),
      relation: options.relation ?? (controller ? null : (role === 'advisor' ? 'consult' : role === 'worker' ? 'delegate' : 'verify')),
      task: options.task ?? 'task',
      runId: options.runId ?? 'run-1',
    },
  };
}

class FakeNode {
  constructor(name, ownerDocument) { this.name = name; this.ownerDocument = ownerDocument; this.attrs = {}; this.children = []; this.nodeType = 1; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
}

const fakeDocument = {
  createElement(name) { return new FakeNode(name, fakeDocument); },
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
};

function descendants(node, result = []) {
  for (const child of node.children ?? []) {
    if (child.nodeType === 1) result.push(child);
    descendants(child, result);
  }
  return result;
}

function visibleText(node) {
  return node.nodeType === 3 ? node.textContent : (node.children ?? []).map(visibleText).join('');
}

test('lane layout fans out a single worker lane and scales for mobile', () => {
  const runtime = {
    agents: [
      agent('controller', 'controller'),
      ...Array.from({ length: 8 }, (_, index) => agent(`worker-${index}`, 'worker')),
      agent('reviewer', 'reviewer'),
      agent('tester', 'tester'),
    ],
  };
  const model = buildOrchestrationGraphModel(runtime, 'space');
  const bottom = model.nodes.filter((node) => node.role === 'reviewer' || node.role === 'tester');
  const workers = model.nodes.filter((node) => node.role === 'worker');
  assert.notDeepEqual(bottom[0].position.desktop, bottom[1].position.desktop);
  assert.equal(new Set(workers.map((node) => `${node.position.desktop.x}:${node.position.desktop.y}`)).size, 8);
  assert.equal(new Set(model.nodes.map((node) => node.position.mobile.y)).size, model.nodes.length);
  assert.equal(new Set(workers.map((node) => node.position.desktop.x)).size, 1);
  assert.ok(model.height > 420);
  assert.ok(model.mobileHeight > model.height);
  for (const count of [1, 3, 8, 20]) {
    const boundaryModel = buildOrchestrationGraphModel({ agents: [
      agent('controller', 'controller'), ...Array.from({ length: count - 1 }, (_, index) => agent(`worker-${index}`, 'worker')),
    ] }, 'space');
    for (const [variant, height] of [['desktop', boundaryModel.height], ['mobile', boundaryModel.mobileHeight]]) {
      const positions = boundaryModel.nodes.map((node) => node.position[variant]);
      const top = Math.min(...positions.map((position) => position.y));
      const bottom = Math.max(...positions.map((position) => position.y + position.height));
      assert.ok(top >= 28, `${count}/${variant} top padding`);
      assert.ok(bottom <= height - 28, `${count}/${variant} bottom padding`);
      assert.equal(top, height - bottom, `${count}/${variant} centered span`);
    }
  }
});

test('role-relation mismatches become unmapped and never create edges', () => {
  const model = buildOrchestrationGraphModel({ agents: [
    agent('controller', 'controller'),
    agent('bad-controller', 'controller', { relation: 'consult' }),
    agent('bad-worker', 'worker', { relation: 'verify' }),
    agent('bad-advisor', 'advisor', { relation: 'delegate' }),
    agent('bad-reviewer', 'reviewer', { relation: 'consult' }),
    agent('bad-tester', 'tester', { relation: 'delegate' }),
  ] }, 'space');
  assert.equal(model.edges.length, 0);
  for (const id of ['bad-controller', 'bad-worker', 'bad-advisor', 'bad-reviewer', 'bad-tester']) {
    const node = model.nodes.find((candidate) => candidate.id === id);
    assert.equal(node.role, 'unmapped', id);
    assert.equal(node.parentPaneId, null, id);
    assert.equal(node.relation, null, id);
    assert.equal(node.disconnected, true, id);
  }
});

test('array/object metadata never coerces into topology roots or edges', () => {
  const cases = [
    ['role', [['controller'], { value: 'controller' }], { parentPaneId: null, relation: null }],
    ['parentPaneId', [['controller'], { value: 'controller' }], {}],
    ['relation', [['delegate'], { value: 'delegate' }], {}],
    ['runId', [['run-1'], { value: 'run-1' }], {}],
  ];
  for (const [field, values, overrides] of cases) for (const value of values) {
    const invalidId = `invalid-${field}`;
    const orchestration = { role: 'worker', parentPaneId: 'controller', relation: 'delegate',
      task: ['not-a-task'], runId: 'run-1', ...overrides, [field]: value };
    const model = buildOrchestrationGraphModel({ agents: [agent('controller', 'controller'),
      { paneId: invalidId, workspaceId: 'space', display: 'invalid', orchestration },
      agent(`dependent-${field}`, 'worker', { parentPaneId: invalidId })] }, 'space');
    const node = model.nodes.find((candidate) => candidate.id === invalidId);
    assert.equal(model.edges.length, 0, `${field} ${JSON.stringify(value)}`);
    assert.equal(node.task, '—');
    if (field === 'runId') {
      assert.equal(node.role, 'worker');
      assert.equal(node.disconnected, true);
    } else {
      assert.equal(node.role, 'unmapped');
      assert.equal(node.parentPaneId, null);
      assert.equal(node.relation, null);
    }
  }
});

test('missing, self, and cross-run parents stay disconnected without inferred edges', () => {
  const runtime = {
    agents: [
      agent('controller', 'controller'),
      agent('valid', 'worker'),
      agent('missing', 'worker', { parentPaneId: 'not-present' }),
      agent('self', 'worker', { parentPaneId: 'self' }),
      agent('other-run', 'worker', { runId: 'run-2' }),
    ],
  };
  const model = buildOrchestrationGraphModel(runtime, 'space');
  assert.deepEqual(model.edges.map((edge) => edge.target.id), ['valid']);
  for (const id of ['missing', 'self', 'other-run']) {
    assert.equal(model.nodes.find((node) => node.id === id).disconnected, true, id);
  }
  assert.equal(model.nodes.find((node) => node.id === 'valid').disconnected, false);
});

test('CSP-safe SVG canvases keep unmapped nodes distinct without inline styles', () => {
  const root = new FakeNode('div', fakeDocument);
  const model = renderOrchestrationGraph(fakeDocument, root, { runtime: { agents: [
    agent('controller', 'controller'),
    agent('worker', 'worker', { status: 'working' }),
    { paneId: 'orphan-a', display: 'orphan-a', status: 'idle', orchestration: null },
    { paneId: 'orphan-b', display: 'orphan-b', status: 'idle', orchestration: null },
  ] } });
  const rendered = [root, ...descendants(root)];
  assert.equal(rendered.some((node) => Object.hasOwn(node.attrs, 'style')), false);
  assert.equal(model.edges.length, 1);
  assert.match(visibleText(root), /\[COORDINATOR\]/);
  const avatars = rendered.filter((node) => node.name === 'svg' && node.attrs.class === 'graph-agent-avatar');
  assert.equal(avatars.length, 8);
  assert.ok(avatars.every((node) => node.attrs.viewBox === '0 0 48 48' && node.attrs['aria-hidden'] === 'true'));
  assert.equal(rendered.filter((node) => node.attrs.class === 'graph-agent-signal').length, 8);
  const workingButtons = rendered.filter((node) => node.attrs.class?.includes('is-working'));
  assert.equal(workingButtons.length, 2);
  assert.ok(workingButtons.every((node) => node.attrs['data-agent-status'] === 'working'));
  const canvases = descendants(root).filter((node) => node.name === 'svg' && node.attrs['data-graph-variant']);
  assert.deepEqual(canvases.map((node) => node.attrs['data-graph-variant']), ['desktop', 'mobile']);
  for (const canvas of canvases) {
    assert.equal(canvas.attrs.width, '100%');
    assert.match(canvas.attrs.height, /^\d+$/);
    const nodes = descendants(canvas).filter((node) => node.name === 'foreignObject' && node.attrs['data-node-layout-role'] === 'unmapped');
    assert.equal(nodes.length, 2);
    assert.equal(new Set(nodes.map((node) => `${node.attrs.x}:${node.attrs.y}`)).size, 2);
    const lines = descendants(canvas).filter((node) => node.name === 'line' && node.attrs['data-relation']);
    assert.equal(lines.length, 1);
    assert.match(lines[0].attrs.x1, /%$/);
    assert.match(lines[0].attrs.x2, /%$/);
    assert.match(lines[0].attrs.y1, /^\d+$/);
    assert.match(lines[0].attrs.y2, /^\d+$/);
    assert.match(lines[0].attrs['marker-end'], /^url\(#graph-arrow-/);
    for (const node of nodes) {
      assert.match(node.attrs.x, /%$/);
      assert.match(node.attrs.width, /%$/);
      assert.match(node.attrs.y, /^\d+$/);
      assert.match(node.attrs.height, /^\d+$/);
    }
  }
});
