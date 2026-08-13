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
    workspaceId: options.workspaceId ?? 'space',
    display: id,
    agentKind: options.agentKind ?? null,
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
function descendants(node, result = []) { for (const child of node.children ?? []) { if (child.nodeType === 1) result.push(child); descendants(child, result); } return result; }
function visibleText(node) {
  return node.nodeType === 3 ? node.textContent : (node.children ?? []).map(visibleText).join('');
}
function assertBandContainment(model) {
  for (const variant of ['desktop', 'mobile']) {
    const sections = model.sections.map((section) => section.bounds[variant]);
    for (let index = 1; index < sections.length; index += 1) assert.ok(sections[index - 1].bottom < sections[index].top, `${variant} band gap`);
    for (const node of model.nodes) { const bounds = model.sections.find((section) => section.workspaceId === node.workspaceId).bounds[variant]; const position = node.position[variant]; assert.ok(position.y >= bounds.top && position.y + position.height <= bounds.bottom, `${variant} node containment`); }
  }
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
  const unknown = buildOrchestrationGraphModel({ agents: [{ ...agent('unknown-controller', 'controller'), workspaceId: null }, { ...agent('unknown-worker', 'worker', { parentPaneId: 'unknown-controller' }), workspaceId: null }, { ...agent('empty-controller', 'controller'), workspaceId: '' }, { ...agent('empty-worker', 'worker', { parentPaneId: 'empty-controller' }), workspaceId: '' }] }); assert.equal(unknown.edges.length, 0); assert.equal(unknown.nodes.find((node) => node.id === 'unknown-worker').disconnected, true); assert.equal(unknown.nodes.find((node) => node.id === 'empty-worker').workspaceId, null); assert.equal(unknown.nodes.find((node) => node.id === 'empty-worker').disconnected, true);
});
test('ALL isolates labeled workspace bands and rejects cross-workspace parents', () => {
  const runtime = { workspaces: [{ id: 'wD', label: 'cafekit' }, { id: 'wB', label: 'ngeax' }], agents: [
    agent('controller', 'controller', { workspaceId: 'wD' }), agent('d-worker', 'worker', { workspaceId: 'wD', parentPaneId: 'controller' }), agent('controller', 'controller', { workspaceId: 'wB' }), agent('b-advisor', 'advisor', { workspaceId: 'wB', parentPaneId: 'controller' }), agent('cross-worker', 'worker', { workspaceId: 'wD', parentPaneId: 'b-advisor' }),
  ] };
  const model = buildOrchestrationGraphModel(runtime); assert.equal(model.sections.length, 2);
  assert.deepEqual(new Set(model.sections.map((section) => section.label)), new Set(['cafekit', 'ngeax']));
  assert.equal(model.edges.length, 2); assert.equal(model.nodes.find((node) => node.id === 'b-advisor').disconnected, false); assert.equal(model.nodes.find((node) => node.id === 'cross-worker').disconnected, true); assertBandContainment(model);
  const root = new FakeNode('div', fakeDocument); renderOrchestrationGraph(fakeDocument, root, { runtime }); const desktop = descendants(root).find((node) => node.name === 'svg' && node.attrs['data-graph-variant'] === 'desktop'); const laneItems = descendants(desktop).filter((node) => node.attrs.class?.includes('graph-lane-container')); const lanesByWorkspace = new Map();
  for (const lane of laneItems) { const workspaceId = lane.attrs['data-workspace-id']; const labels = lanesByWorkspace.get(workspaceId) ?? []; labels.push(visibleText(lane)); lanesByWorkspace.set(workspaceId, labels); const bounds = model.sections.find((section) => String(section.workspaceId) === workspaceId).bounds.desktop; const y = Number(lane.attrs.y); assert.ok(y >= bounds.top && y + Number(lane.attrs.height) <= bounds.bottom, `${workspaceId} lane containment`); }
  assert.deepEqual(new Set(lanesByWorkspace.get('wD')), new Set(['COORDINATOR', 'WORKER'])); assert.deepEqual(new Set(lanesByWorkspace.get('wB')), new Set(['COORDINATOR', 'ADVISOR']));
  const selectedRoot = new FakeNode('div', fakeDocument); const selected = renderOrchestrationGraph(fakeDocument, selectedRoot, { runtime, selectedWorkspace: 'wB' }); assert.equal(selected.sections.length, 1); assert.equal(selected.height, 340); assert.equal(selected.mobileHeight, 340); assert.equal(descendants(selectedRoot).some((node) => node.attrs.class === 'graph-workspace-band'), false);
});
test('CSP-safe SVG canvases keep unmapped nodes distinct without inline styles', () => {
  const root = new FakeNode('div', fakeDocument);
  const model = renderOrchestrationGraph(fakeDocument, root, { runtime: { agents: [
      agent('controller', 'controller', { agentKind: 'claude' }),
      agent('worker', 'worker', { status: 'working', agentKind: 'codex' }),
    { paneId: 'orphan-a', workspaceId: 'space', display: 'orphan-a', status: 'idle', orchestration: null },
    { paneId: 'orphan-b', workspaceId: 'space', display: 'orphan-b', status: 'idle', orchestration: null },
  ] } });
  const rendered = [root, ...descendants(root)];
  assert.equal(rendered.some((node) => Object.hasOwn(node.attrs, 'style')), false);
  assert.equal(model.edges.length, 1);
  assert.match(visibleText(root), /\[COORDINATOR\] \[CLAUDE CODE\]/);
  assert.match(visibleText(root), /\[WORKER\] \[CODEX\]/);
  assert.match(visibleText(root), /\[UNMAPPED\] \[UNKNOWN\]/);
  assert.doesNotMatch(visibleText(root), /DISCONNECTED/);
  const avatars = rendered.filter((node) => node.name === 'svg' && node.attrs.class === 'graph-agent-avatar');
  assert.equal(avatars.length, 8);
  assert.ok(avatars.every((node) => node.attrs.viewBox === '0 0 48 48' && node.attrs['aria-hidden'] === 'true'));
  assert.equal(rendered.filter((node) => node.attrs.class === 'graph-agent-signal').length, 8);
  const workingButtons = rendered.filter((node) => node.attrs.class?.includes('is-working'));
  assert.equal(workingButtons.length, 2);
  assert.ok(workingButtons.every((node) => node.attrs['data-agent-status'] === 'working'));
  const canvases = descendants(root).filter((node) => node.name === 'svg' && node.attrs['data-graph-variant']);
  assert.deepEqual(canvases.map((node) => node.attrs['data-graph-variant']), ['desktop', 'mobile']);
  const singleSpaceLanes = descendants(canvases[0]).filter((node) => node.attrs.class?.includes('graph-lane-container')); assert.deepEqual(new Set(singleSpaceLanes.map(visibleText)), new Set(['COORDINATOR', 'WORKER'])); assert.ok(singleSpaceLanes.every((node) => !Object.hasOwn(node.attrs, 'data-workspace-id')));
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
