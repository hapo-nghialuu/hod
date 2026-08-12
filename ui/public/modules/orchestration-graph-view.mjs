import { clearChildren, createElement, setAttribute } from './dom-helpers.mjs';
import { buildAgentViewModels } from './view-models.mjs';
import { layoutOrchestrationNodes } from './orchestration-graph-layout.mjs';

const SVG_NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
const ROLE_RELATIONS = Object.freeze({ controller: 'delegate', worker: 'delegate', advisor: 'consult', reviewer: 'verify', tester: 'verify' });
const RELATIONS = new Set(Object.values(ROLE_RELATIONS));
function stringValue(value, fallback = '—') {
  return typeof value === 'string' && value !== '' ? value : fallback;
}
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
    return {
      ...agent,
      key: agent.id ?? `unmapped-${index}`,
      role: metadata.role,
      mapped: metadata.mapped,
      parentPaneId: metadata.parentPaneId,
      relation: metadata.relation,
      task: metadata.task,
      runId: metadata.runId,
      disconnected: !metadata.mapped,
    };
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
    return svgElement(documentRef, 'line', {
      class: `graph-edge edge-${edge.relation}${edge.targetWorking ? ' is-target-working' : ''}`,
      x1: `${source.x}%`, y1: source.y + source.height,
      x2: `${target.x}%`, y2: target.y,
      'marker-end': `url(#graph-arrow-${variant}-${edge.relation})`,
      'data-relation': edge.relation,
      'data-target-pane-id': edge.target.id,
    });
  });
  return svgElement(documentRef, 'g', { class: `graph-edges graph-edges-${variant}`, 'aria-hidden': 'true' }, [
    edgeMarkers(documentRef, variant), ...lines,
  ]);
}
function nodeButton(documentRef, node, selected) {
  const label = `${node.displayName}, ${node.role.toUpperCase()}, ${node.statusText}`;
  const selectable = node.id !== null;
  const classes = ['graph-node', `graph-node-${node.role}`, node.mapped ? '' : 'is-unmapped',
    node.disconnected ? 'is-disconnected' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ');
  return createElement('button', {
    class: classes,
    type: 'button',
    'data-pane-id': selectable ? node.id : null,
    'data-node-state': node.disconnected ? 'disconnected' : node.status,
    'aria-pressed': selected ? 'true' : 'false',
    'aria-label': selectable ? `Select read-only transcript for ${label}` : `${label}, no pane id`,
    disabled: !selectable,
  }, [
    createElement('span', { class: 'graph-node-role' }, [`[${node.role.toUpperCase()}]`], documentRef),
    createElement('strong', { class: 'graph-node-name' }, [node.displayName], documentRef),
    createElement('span', { class: 'graph-node-status' }, [`${node.statusTag} ${node.statusText}`], documentRef),
    createElement('span', { class: 'graph-node-meta' }, [`task ${node.task} · run ${node.runId ?? '—'}`], documentRef),
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
  const lanes = [['advisor', 'ADVISOR', ['advisor']], ['controller', 'CONTROLLER', ['controller', 'unmapped']],
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
    'aria-label': `${variant} live orchestration graph`, 'data-graph-variant': variant,
  });
  canvas.appendChild(edgeLayer(documentRef, model, mobile));
  if (!mobile) for (const lane of laneCanvasItems(documentRef, model)) canvas.appendChild(lane);
  for (const node of model.nodes) canvas.appendChild(nodeCanvasItem(documentRef, node,
    node.id !== null && String(node.id) === String(selectedPane), mobile));
  return canvas;
}
function legend(documentRef) {
  return createElement('ul', { class: 'graph-legend', 'aria-label': 'Orchestration edge semantics' }, [
    ...[['delegate', 'DELEGATE'], ['consult', 'CONSULT'], ['verify', 'VERIFY']].map(([relation, label]) => createElement('li', {
      class: `graph-legend-item edge-${relation}`,
    }, [label], documentRef)),
  ], documentRef);
}
function helpState(documentRef, message) {
  return createElement('p', { class: 'graph-help', role: 'status' }, [message], documentRef);
}
export function renderOrchestrationGraph(documentRef, root, state = {}) {
  clearChildren(root);
  const runtime = state.runtime;
  if (!runtime || typeof runtime !== 'object') {
    root.appendChild(helpState(documentRef, 'Waiting for a live orchestration snapshot.'));
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
    legend(documentRef),
  ], documentRef);
  const stage = createElement('div', {
    class: 'graph-stage', role: 'group', 'aria-label': 'Live orchestration graph',
  }, [], documentRef);
  stage.appendChild(graphCanvas(documentRef, model, false, selectedPane));
  stage.appendChild(graphCanvas(documentRef, model, true, selectedPane));
  graph.appendChild(stage);
  if (!model.nodes.length) graph.appendChild(helpState(documentRef, 'No agents reported for this space.'));
  else if (model.hasUnmapped || !model.edges.length) graph.appendChild(helpState(documentRef,
    'UNMAPPED / DISCONNECTED nodes have no inferred edges; relationships come only from backend orchestration metadata.'));
  root.appendChild(graph);
  return model;
}
export function createOrchestrationGraphView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="agents"]');
  const store = options.store;
  if (!documentRef || !root || !store) return Object.freeze({ destroy() {} });
  const render = (state = store.getState()) => renderOrchestrationGraph(documentRef, root, state);
  const unsubscribe = store.subscribe(render);
  render();
  return Object.freeze({ render, destroy: unsubscribe });
}
