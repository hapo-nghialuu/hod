import { clearChildren, createElement } from './dom-helpers.mjs';
import { ACTIONS } from './ui-store.mjs';
import { renderOrchestrationGraph } from './orchestration-graph-view.mjs';
import {
  asciiOccupancy, buildRuntimeTotals, buildSpaceViewModels,
} from './view-models.mjs';

const TOTAL_KEYS = Object.freeze(['spaces', 'agents', 'working', 'blocked', 'idle', 'done']);

function statusClass(status) {
  if (status === 'blocked') return 'status-err';
  if (status === 'done') return 'status-ok';
  return 'status-warn';
}

function statusNode(documentRef, model) {
  return createElement('span', { class: `tag ${statusClass(model.status)}` }, [
    `${model.statusTag} ${model.statusText}`,
  ], documentRef);
}

function countNode(documentRef, space, paneCapacity, tabCapacity) {
  return createElement('span', { class: 'space-counts' }, [
    `panes ${space.paneCount} tabs ${space.tabCount}`,
    createElement('span', { class: 'ascii-bars', 'aria-label': 'pane and tab occupancy' }, [
      `P ${asciiOccupancy(space.paneCount, paneCapacity, 8)}`,
      ` T ${asciiOccupancy(space.tabCount, tabCapacity, 8)}`,
    ], documentRef),
  ], documentRef);
}

function totalsNode(documentRef, totals) {
  return createElement('p', {
    class: 'runtime-totals',
    'data-runtime-totals': '',
    role: 'status',
    'aria-label': 'Global runtime totals',
  }, TOTAL_KEYS.map((key) => createElement('span', {
    class: 'runtime-total',
    'data-runtime-total': key,
    'aria-label': `${key} ${totals[key]}`,
  }, [`${key} ${totals[key]}`], documentRef)), documentRef);
}

function spaceButton(documentRef, space, selected, paneCapacity, tabCapacity) {
  const button = createElement('button', {
    class: `space-button${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-space-id': space.isAll ? '' : space.id,
    'aria-pressed': selected ? 'true' : 'false',
    'aria-label': `${space.label} space, ${space.statusText}, ${space.paneCount} panes, ${space.tabCount} tabs`,
  }, [
    createElement('span', { class: 'space-label' }, [space.label], documentRef),
    statusNode(documentRef, space),
    countNode(documentRef, space, paneCapacity, tabCapacity),
  ], documentRef);
  return button;
}

function renderSpaces(documentRef, root, state) {
  clearChildren(root);
  root.appendChild(totalsNode(documentRef, buildRuntimeTotals(state.runtime)));
  const spaces = buildSpaceViewModels(state.runtime);
  const paneCapacity = Math.max(1, ...spaces.map((space) => space.paneCount));
  const tabCapacity = Math.max(1, ...spaces.map((space) => space.tabCount));
  const selected = state.selectedWorkspace;
  for (const space of spaces) {
    const active = space.isAll ? selected === null : space.id === selected;
    root.appendChild(spaceButton(documentRef, space, active, paneCapacity, tabCapacity));
  }
}

function renderGraph(documentRef, root, state) {
  renderOrchestrationGraph(documentRef, root, state);
}

export function createDashboardView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const store = options.store;
  const spacesRoot = options.spacesRoot ?? documentRef?.querySelector?.('[data-pane-body="spaces"]');
  const agentsRoot = options.graphRoot ?? options.agentsRoot ?? documentRef?.querySelector?.('[data-pane-body="agents"]');
  const onSelectPane = options.onSelectPane;
  if (!store || !spacesRoot || !agentsRoot) return Object.freeze({ destroy() {} });

  const render = (state = store.getState()) => {
    renderSpaces(documentRef, spacesRoot, state);
    renderGraph(documentRef, agentsRoot, state);
  };
  const onSpaceClick = (event) => {
    const button = event.target?.closest?.('[data-space-id]');
    if (!button || (typeof spacesRoot.contains === 'function' && !spacesRoot.contains(button))) return;
    const id = button.getAttribute('data-space-id');
    store.dispatch({ type: ACTIONS.WORKSPACE_SET, selectedWorkspace: id || null });
  };
  const onAgentClick = async (event) => {
    const button = event.target?.closest?.('[data-pane-id]');
    if (!button || (typeof agentsRoot.contains === 'function' && !agentsRoot.contains(button))) return;
    const paneId = button.getAttribute('data-pane-id');
    if (!paneId) return;
    try { await onSelectPane?.(paneId); } catch { /* app owns the statusbar */ }
  };
  spacesRoot.addEventListener?.('click', onSpaceClick);
  agentsRoot.addEventListener?.('click', onAgentClick);
  const unsubscribe = store.subscribe(render);
  render();
  return Object.freeze({ render, destroy() {
    unsubscribe();
    spacesRoot.removeEventListener?.('click', onSpaceClick);
    agentsRoot.removeEventListener?.('click', onAgentClick);
  } });
}

export const mountDashboardView = createDashboardView;
