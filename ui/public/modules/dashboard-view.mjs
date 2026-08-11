import { clearChildren, createElement, setAttribute, textContent } from './dom-helpers.mjs';
import { ACTIONS } from './ui-store.mjs';
import {
  asciiOccupancy, buildAgentViewModels, buildSpaceViewModels,
} from './view-models.mjs';

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

function spaceButton(documentRef, space, selected, paneCapacity, tabCapacity) {
  const button = createElement('button', {
    class: `space-button${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-space-id': space.isAll ? '' : space.id,
    'aria-pressed': selected ? 'true' : 'false',
  }, [
    createElement('span', { class: 'space-label' }, [space.label], documentRef),
    statusNode(documentRef, space),
    countNode(documentRef, space, paneCapacity, tabCapacity),
  ], documentRef);
  return button;
}

function renderSpaces(documentRef, root, state) {
  clearChildren(root);
  const spaces = buildSpaceViewModels(state.runtime);
  const paneCapacity = Math.max(1, ...spaces.map((space) => space.paneCount));
  const tabCapacity = Math.max(1, ...spaces.map((space) => space.tabCount));
  const selected = state.selectedWorkspace;
  for (const space of spaces) {
    const active = space.isAll ? selected === null : space.id === selected;
    root.appendChild(spaceButton(documentRef, space, active, paneCapacity, tabCapacity));
  }
}

function agentButton(documentRef, agent, selected) {
  return createElement('button', {
    class: `bracket-button agent-select${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-pane-id': agent.id,
    'aria-pressed': selected ? 'true' : 'false',
  }, ['[ SELECT ]'], documentRef);
}

function agentRow(documentRef, agent, selected) {
  return createElement('article', { class: `agent-row${selected ? ' is-selected' : ''}` }, [
    createElement('div', { class: 'agent-heading' }, [
      createElement('strong', { class: 'agent-name' }, [agent.displayName], documentRef),
      statusNode(documentRef, agent),
    ], documentRef),
    createElement('p', { class: 'agent-meta' }, [
      `${agent.statusTag} ${agent.statusText} · pane ${agent.id ?? '—'}`,
    ], documentRef),
    agentButton(documentRef, agent, selected),
  ], documentRef);
}

function renderAgents(documentRef, root, state) {
  clearChildren(root);
  const runtime = state.runtime ?? {};
  const selectedPane = state.transcript?.paneId ?? runtime.selectedPaneId ?? null;
  const agents = buildAgentViewModels(runtime, state.selectedWorkspace);
  if (!agents.length) {
    root.appendChild(createElement('p', { class: 'empty-state' }, [
      state.selectedWorkspace ? 'No agents in this space.' : 'No agents reported.',
    ], documentRef));
    return;
  }
  for (const agent of agents) root.appendChild(agentRow(documentRef, agent, agent.id === selectedPane));
}

export function createDashboardView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const store = options.store;
  const spacesRoot = options.spacesRoot ?? documentRef?.querySelector?.('[data-pane-body="spaces"]');
  const agentsRoot = options.agentsRoot ?? documentRef?.querySelector?.('[data-pane-body="agents"]');
  const onSelectPane = options.onSelectPane;
  if (!store || !spacesRoot || !agentsRoot) return Object.freeze({ destroy() {} });

  const render = (state = store.getState()) => {
    renderSpaces(documentRef, spacesRoot, state);
    renderAgents(documentRef, agentsRoot, state);
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
    store.dispatch({ type: ACTIONS.TRANSCRIPT_SELECT, paneId });
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
