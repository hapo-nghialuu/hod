import { clearChildren, createElement, setAttribute } from './dom-helpers.mjs';
import { buildAgentViewModels } from './view-models.mjs';
import { layoutOrchestrationNodes } from './orchestration-graph-layout.mjs';
import { createAgentAvatarGlyph } from './agent-avatar-glyph.mjs';
import { attachGraphViewport, createGraphHelpState, createGraphLegend, createGraphViewportControls, createGraphViewportState } from './orchestration-graph-viewport.mjs';
const SVG_NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
const ROLE_RELATIONS = Object.freeze({ controller: 'delegate', worker: 'delegate', advisor: 'consult', reviewer: 'verify', tester: 'verify' });
const ROLE_LABELS = Object.freeze({ controller: 'COORDINATOR', worker: 'WORKER', advisor: 'ADVISOR', reviewer: 'REVIEWER', tester: 'TESTER', unmapped: 'UNMAPPED' });
const RELATIONS = new Set(Object.values(ROLE_RELATIONS));
function stringValue(value, fallback = '—') { return typeof value === 'string' && value !== '' ? value : fallback; }
function orchestrationOf(agent) {
  const value = agent?.orchestration;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function metadataFor(agent) {
  const metadata = orchestrationOf(agent);
  const rawParent = metadata?.parentPaneId;
  const rawRelation = metadata?.relation;
  const role = typeof metadata?.role === 'string' ? metadata.role.toLowerCase() : null;
  const structuralTypesValid = typeof metadata?.role === 'string' && metadata.role !== ''
    && (rawParent == null || typeof rawParent === 'string' && rawParent !== '')
    && (rawRelation == null || typeof rawRelation === 'string');
  const parentPaneId = structuralTypesValid && typeof rawParent === 'string' ? rawParent : null;
  const relation = structuralTypesValid && typeof rawRelation === 'string' ? rawRelation.toLowerCase() : null;
  const rootController = structuralTypesValid && role === 'controller' && parentPaneId === null && relation === null;
  const mapped = structuralTypesValid && Object.hasOwn(ROLE_RELATIONS, role)
    && (rootController || (parentPaneId !== null && ROLE_RELATIONS[role] === relation));
  return { mapped, role: mapped ? role : 'unmapped', parentPaneId: mapped ? parentPaneId : null,
    relation: mapped && RELATIONS.has(relation) ? relation : null, task: stringValue(metadata?.task),
    runId: typeof metadata?.runId === 'string' && metadata.runId !== '' ? metadata.runId : null };
}
export function buildOrchestrationGraphModel(input, selectedWorkspace = null) {
  const nodes = buildAgentViewModels(input, selectedWorkspace).map((agent, index) => {
    const metadata = metadataFor(agent);
    return { ...agent, key: agent.id ?? `unmapped-${index}`, role: metadata.role,
      mapped: metadata.mapped, parentPaneId: metadata.parentPaneId, relation: metadata.relation,
      task: metadata.task, runId: metadata.runId, disconnected: !metadata.mapped };
  });
  const layout = layoutOrchestrationNodes(nodes);
  const byId = new Map(nodes.filter((node) => node.id !== null).map((node) => [node.id, node]));
  const edges = nodes.flatMap((target) => {
    const source = target.parentPaneId ? byId.get(target.parentPaneId) : null;
    const connected = source?.mapped && source.id !== target.id && target.relation
      && target.runId !== null && source.runId === target.runId;
    if (target.parentPaneId && !connected) target.disconnected = true;
    if (!connected) return [];
    return [{ id: `${source.id}->${target.id}`, source, target, relation: target.relation,
      targetWorking: target.status === 'working' }];
  });
  return { ...layout, nodes, edges, hasUnmapped: nodes.some((node) => node.disconnected) };
}
function svgElement(documentRef, name, attributes = {}, children = []) {
  const element = documentRef.createElementNS?.(SVG_NS, name) ?? documentRef.createElement(name);
  for (const [attribute, value] of Object.entries(attributes)) setAttribute(element, attribute, value);
  for (const child of children) element.appendChild(child);
  return element;
}
function edgeMarkers(documentRef, variant) {
  return svgElement(documentRef, 'defs', {}, [...RELATIONS].map((relation) => svgElement(documentRef, 'marker', {
    id: `graph-arrow-${variant}-${relation}`, viewBox: '0 0 8 8', refX: '7', refY: '4',
    markerWidth: '7', markerHeight: '7', orient: 'auto', markerUnits: 'strokeWidth',
  }, [svgElement(documentRef, 'path', { class: `graph-arrow edge-${relation}`, d: 'M 0 0 L 8 4 L 0 8 Z' })])));
}
function edgeLayer(documentRef, model, mobile) {
  const variant = mobile ? 'mobile' : 'desktop';
  const lines = model.edges.map((edge) => {
    const source = edge.source.position[mobile ? 'mobile' : 'desktop'];
    const target = edge.target.position[mobile ? 'mobile' : 'desktop'];
    const vertical = mobile || edge.relation !== 'delegate';
    const forward = vertical ? target.y >= source.y : target.x >= source.x;
    const direction = forward ? 1 : -1;
    const geometry = vertical
      ? { x1: `${source.x}%`, y1: source.y + (forward ? source.height : 0), x2: `${target.x}%`, y2: target.y + (forward ? 0 : target.height) }
      : { x1: `${source.x + direction * source.width / 2}%`, y1: source.y + source.height / 2, x2: `${target.x - direction * target.width / 2}%`, y2: target.y + target.height / 2 };
    return svgElement(documentRef, 'line', {
      class: `graph-edge edge-${edge.relation}${edge.targetWorking ? ' is-target-working' : ''}`,
      ...geometry, 'marker-end': `url(#graph-arrow-${variant}-${edge.relation})`,
      'data-relation': edge.relation, 'data-target-pane-id': edge.target.id,
    });
  });
  return svgElement(documentRef, 'g', { class: `graph-edges graph-edges-${variant}`, 'aria-hidden': 'true' }, [
    edgeMarkers(documentRef, variant), ...lines,
  ]);
}
function nodeButton(documentRef, node, selected) {
  const roleLabel = ROLE_LABELS[node.role] ?? ROLE_LABELS.unmapped; const label = `${node.displayName}, ${roleLabel}, ${node.agentKind}, ${node.statusText}`;
  const selectable = node.id !== null;
  const classes = ['graph-node', `graph-node-${node.role}`, node.mapped ? '' : 'is-unmapped',
    node.disconnected ? 'is-disconnected' : '', node.status === 'working' ? 'is-working' : '',
    selected ? 'is-selected' : ''].filter(Boolean).join(' ');
  return createElement('button', {
    class: classes,
    type: 'button',
    'data-pane-id': selectable ? node.id : null,
    'data-node-state': node.disconnected ? 'disconnected' : node.status,
    'data-agent-status': node.status,
    'data-agent-kind': node.agentKind,
    'aria-pressed': selected ? 'true' : 'false',
    'aria-label': selectable ? `Select read-only transcript for ${label}` : `${label}, no pane id`,
    title: `${roleLabel} · ${node.agentKind} · ${node.task} · run ${node.runId ?? '—'}`,
    disabled: !selectable,
  }, [
    createAgentAvatarGlyph(documentRef),
    createElement('span', { class: 'graph-node-copy' }, [
      createElement('span', { class: 'graph-node-role' }, [`[${roleLabel}] [${node.agentKind}]`], documentRef), createElement('strong', { class: 'graph-node-name' }, [node.displayName], documentRef),
      createElement('span', { class: 'graph-node-status' }, [`${node.statusTag} ${node.statusText}`], documentRef),
      createElement('span', { class: 'graph-node-meta' }, [node.task], documentRef),
    ], documentRef),
  ], documentRef);
}
function nodeCanvasItem(documentRef, node, selected, mobile) {
  const variant = mobile ? 'mobile' : 'desktop';
  const position = node.position[variant];
  return svgElement(documentRef, 'foreignObject', {
    class: `graph-node-container graph-node-container-${variant}`,
    x: `${position.x - position.width / 2}%`, y: position.y,
    width: `${position.width}%`, height: position.height,
    'data-node-key': node.key, 'data-node-role': mobile ? null : node.role,
    'data-node-layout-role': node.role, 'data-pane-id': node.id,
  }, [nodeButton(documentRef, node, selected)]);
}
function laneCanvasItems(documentRef, model) {
  const lanes = [['advisor', 'ADVISOR', ['advisor']], ['controller', 'COORDINATOR', ['controller', 'unmapped']],
    ['worker', 'WORKER', ['worker']], ['review', 'REVIEW / TEST', ['reviewer', 'tester']]];
  return lanes.flatMap(([className, label, roles]) => {
    if (!model.nodes.some((node) => roles.includes(node.role))) return [];
    const right = className === 'worker' || className === 'review';
    return [svgElement(documentRef, 'foreignObject', {
      class: `graph-lane-container graph-lane-${className}`,
      x: right ? '66%' : '4%', y: Math.max(8, model.lanes[className] - 24),
      width: '30%', height: '20',
    }, [createElement('span', { class: `graph-lane-label graph-lane-${className}` }, [label], documentRef)])];
  });
}
function graphCanvas(documentRef, model, mobile, selectedPane) {
  const variant = mobile ? 'mobile' : 'desktop';
  const canvas = svgElement(documentRef, 'svg', {
    class: `graph-canvas graph-canvas-${variant}`, width: '100%',
    height: mobile ? model.mobileHeight : model.height, role: 'group',
    'aria-label': `${variant} live orchestration graph. Drag to pan; use Control or Command plus scroll to zoom.`, 'data-graph-variant': variant,
  });
  const layer = svgElement(documentRef, 'g', { class: 'graph-viewport-layer' });
  layer.appendChild(edgeLayer(documentRef, model, mobile));
  if (!mobile) for (const lane of laneCanvasItems(documentRef, model)) layer.appendChild(lane);
  for (const node of model.nodes) layer.appendChild(nodeCanvasItem(documentRef, node,
    node.id !== null && String(node.id) === String(selectedPane), mobile));
  canvas.appendChild(layer);
  return canvas;
}
export function renderOrchestrationGraph(documentRef, root, state = {}, options = {}) {
  clearChildren(root);
  const runtime = state.runtime;
  if (!runtime || typeof runtime !== 'object') {
    root.appendChild(createGraphHelpState(documentRef, 'Waiting for a live orchestration snapshot.'));
    return { nodes: [], edges: [], hasUnmapped: false };
  }
  const model = buildOrchestrationGraphModel(runtime, state.selectedWorkspace);
  const selectedPane = state.transcript?.paneId ?? runtime.selectedPaneId ?? null;
  const graph = createElement('div', {
    class: 'orchestration-graph',
    'data-orchestration-graph': '',
    'data-node-count': model.nodes.length,
    'data-edge-count': model.edges.length,
  }, [
    createElement('div', { class: 'graph-summary' }, [
      createElement('strong', {}, ['// LIVE_ORCHESTRATION'], documentRef),
      createElement('span', {}, [`${model.nodes.length} nodes · ${model.edges.length} edges`], documentRef),
    ], documentRef),
    createGraphLegend(documentRef),
  ], documentRef);
  const stage = createElement('div', {
    class: 'graph-stage', role: 'group', 'aria-label': 'Live orchestration graph',
  }, [], documentRef);
  const canvases = [graphCanvas(documentRef, model, false, selectedPane), graphCanvas(documentRef, model, true, selectedPane)];
  for (const canvas of canvases) stage.appendChild(canvas);
  const controls = createGraphViewportControls(documentRef);
  graph.appendChild(controls.element);
  graph.appendChild(stage);
  if (!model.nodes.length) graph.appendChild(createGraphHelpState(documentRef, 'No agents reported for this space.'));
  root.appendChild(graph);
  attachGraphViewport(documentRef, stage, canvases, controls, options.viewportState);
  return model;
}
export function createOrchestrationGraphView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="agents"]');
  const store = options.store;
  if (!documentRef || !root || !store) return Object.freeze({ destroy() {} });
  const viewportState = createGraphViewportState();
  const render = (state = store.getState()) => renderOrchestrationGraph(documentRef, root, state, { viewportState });
  const unsubscribe = store.subscribe(render);
  render();
  return Object.freeze({ render, destroy: unsubscribe });
}
