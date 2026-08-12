export const STATUS_PRIORITY = Object.freeze({ blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 });
const STATUS_META = Object.freeze({ blocked: { text: 'blocked', tag: '[ERR]' }, working: { text: 'working', tag: '[WORK]' }, idle: { text: 'idle', tag: '[WAIT]' }, done: { text: 'done', tag: '[DONE]' }, unknown: { text: 'unknown', tag: '[UNKNOWN]' } });
const COUNTED_STATUSES = Object.freeze(['working', 'blocked', 'idle', 'done']);

function listFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.agents)) return input.agents;
  if (Array.isArray(input?.runtime?.agents)) return input.runtime.agents;
  return [];
}

function rawStatus(value) {
  const candidate = typeof value === 'string' ? value : value?.status ?? value?.state ?? value?.agent_status ?? value?.lifecycle?.status;
  return typeof candidate === 'string' ? candidate.toLowerCase() : 'unknown';
}

export function normalizeStatus(value) {
  const status = rawStatus(value);
  if (['running', 'active', 'in_progress'].includes(status)) return 'working';
  if (['waiting', 'pending', 'paused'].includes(status)) return 'idle';
  if (['complete', 'completed', 'success'].includes(status)) return 'done';
  if (['error', 'failed', 'failure'].includes(status)) return 'blocked';
  return STATUS_PRIORITY[status] === undefined ? 'unknown' : status;
}

export function statusTag(value) { return STATUS_META[normalizeStatus(value)].tag; }
export function statusText(value) { return STATUS_META[normalizeStatus(value)].text; }

function workspaceOf(agent) {
  const workspace = agent?.workspaceId ?? agent?.workspace_id ?? agent?.spaceId ?? agent?.space_id;
  if (workspace !== undefined && workspace !== null) return String(workspace);
  if (typeof agent?.workspace === 'string') return agent.workspace;
  if (agent?.workspace?.id !== undefined) return String(agent.workspace.id);
  if (agent?.space?.id !== undefined) return String(agent.space.id);
  return null;
}

function agentName(agent) { return String(agent?.name ?? agent?.display ?? agent?.display_agent ?? agent?.title ?? agent?.label ?? agent?.id ?? 'agent'); }
function agentId(agent) { return agent?.paneId ?? agent?.pane_id ?? agent?.id ?? null; }

export function filterAgents(input, selectedWorkspace = null) {
  const agents = listFrom(input);
  if (selectedWorkspace === null || selectedWorkspace === undefined || selectedWorkspace === '') return agents.slice();
  const wanted = String(selectedWorkspace);
  return agents.filter((agent) => workspaceOf(agent) === wanted);
}

export function sortAgents(input) {
  return listFrom(input).map((agent, index) => ({ agent, index })).sort((left, right) => {
    const priority = STATUS_PRIORITY[normalizeStatus(left.agent)] - STATUS_PRIORITY[normalizeStatus(right.agent)];
    if (priority) return priority;
    const leftName = agentName(left.agent); const rightName = agentName(right.agent);
    return leftName < rightName ? -1 : leftName > rightName ? 1 : left.index - right.index;
  }).map(({ agent }) => agent);
}

export function agentViewModel(agent) {
  const status = normalizeStatus(agent); const id = agentId(agent);
  return { ...agent, id: id == null ? null : String(id), displayName: agentName(agent), workspaceId: workspaceOf(agent), status, statusText: STATUS_META[status].text, statusTag: STATUS_META[status].tag, statusPriority: STATUS_PRIORITY[status] };
}

export function buildAgentViewModels(input, selectedWorkspace = null) { return sortAgents(filterAgents(input, selectedWorkspace)).map(agentViewModel); }

function tabList(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.tabs)) return input.tabs;
  return Array.isArray(input?.runtime?.tabs) ? input.runtime.tabs : [];
}

function tabId(tab) { return tab?.id ?? tab?.tabId ?? tab?.tab_id ?? null; }
function tabNumber(tab) {
  const value = tab?.number ?? tab?.tabNumber ?? tab?.tab_number;
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value) : null;
}
function tabLabel(tab, id) { return String(tab?.label ?? tab?.name ?? id ?? 'tab'); }

function filterTabs(input, selectedWorkspace = null) {
  const tabs = tabList(input);
  if (selectedWorkspace === null || selectedWorkspace === undefined || selectedWorkspace === '') return tabs.slice();
  const wanted = String(selectedWorkspace);
  return tabs.filter((tab) => workspaceOf(tab) === wanted);
}

function sortTabs(input) {
  return tabList(input).map((tab, index) => ({ tab, index })).sort((left, right) => {
    const workspace = naturalCompare(workspaceOf(left.tab), workspaceOf(right.tab));
    if (workspace) return workspace;
    const leftNumber = tabNumber(left.tab); const rightNumber = tabNumber(right.tab);
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if ((leftNumber === null) !== (rightNumber === null)) return leftNumber === null ? 1 : -1;
    return naturalCompare(tabId(left.tab), tabId(right.tab)) || left.index - right.index;
  }).map(({ tab }) => tab);
}

export function tabViewModel(tab) {
  const id = tabId(tab); const status = normalizeStatus(tab);
  const paneCount = tab?.paneCount ?? tab?.pane_count ?? 0;
  return {
    ...tab,
    id: id == null ? null : String(id),
    label: tabLabel(tab, id),
    workspaceId: workspaceOf(tab),
    number: tabNumber(tab),
    paneCount: Number.isFinite(Number(paneCount)) ? Number(paneCount) : 0,
    status, statusText: STATUS_META[status].text, statusTag: STATUS_META[status].tag,
  };
}

export function buildTabViewModels(input, selectedWorkspace = null) {
  return sortTabs({ tabs: filterTabs(input, selectedWorkspace) }).map(tabViewModel);
}

export function progressRatio(value, total) {
  const current = Number(value); const maximum = Number(total);
  return !Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0 ? 0 : Math.min(1, Math.max(0, current / maximum));
}

export function progressPercent(value, total) { return Math.round(progressRatio(value, total) * 100); }
function bar(value, total, width) { const safeWidth = Math.min(80, Math.max(1, Number.isInteger(width) ? width : 10)); const filled = Math.round(progressRatio(value, total) * safeWidth); return '|'.repeat(filled) + '.'.repeat(safeWidth - filled); }
export function asciiProgress(value, total, width = 10) { return `[${bar(value, total, width)}] ${progressPercent(value, total)}%`; }
export function asciiOccupancy(used, capacity, width = 10) { return `[${bar(used, capacity, width)}] ${progressPercent(used, capacity)}%`; }

function naturalCompare(left, right) {
  const leftParts = String(left ?? '').match(/(\d+|\D+)/g) ?? ['']; const rightParts = String(right ?? '').match(/(\d+|\D+)/g) ?? [''];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? ''; const rightPart = rightParts[index] ?? '';
    if (/^\d+$/.test(leftPart) && /^\d+$/.test(rightPart)) { const difference = Number(leftPart) - Number(rightPart); if (difference) return difference; }
    else if (leftPart.toLowerCase() !== rightPart.toLowerCase()) return leftPart.toLowerCase() < rightPart.toLowerCase() ? -1 : 1;
  }
  return 0;
}

function workspaceList(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.workspaces)) return input.workspaces;
  if (Array.isArray(input?.spaces)) return input.spaces;
  if (Array.isArray(input?.runtime?.workspaces)) return input.runtime.workspaces;
  return Array.isArray(input?.runtime?.spaces) ? input.runtime.spaces : [];
}

function spaceStatus(workspaces) { return workspaces.reduce((current, workspace) => { const status = normalizeStatus(workspace); return STATUS_PRIORITY[status] < STATUS_PRIORITY[current] ? status : current; }, 'unknown'); }

export function buildSpaceViewModels(input) {
  const workspaces = workspaceList(input).map((workspace, index) => ({ workspace, index })).sort((left, right) => {
    const leftNumber = Number(left.workspace?.number); const rightNumber = Number(right.workspace?.number);
    const leftHasNumber = Number.isFinite(leftNumber); const rightHasNumber = Number.isFinite(rightNumber);
    if (leftHasNumber && rightHasNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if (leftHasNumber !== rightHasNumber) return leftHasNumber ? -1 : 1;
    const leftId = left.workspace?.id ?? left.workspace?.workspaceId ?? left.workspace?.workspace_id;
    const rightId = right.workspace?.id ?? right.workspace?.workspaceId ?? right.workspace?.workspace_id;
    return naturalCompare(leftId, rightId) || left.index - right.index;
  }).map(({ workspace }) => {
    const id = workspace?.id ?? workspace?.workspaceId ?? workspace?.workspace_id;
    const paneCount = workspace?.paneCount ?? workspace?.pane_count ?? workspace?.panes?.length ?? 0;
    const tabCount = workspace?.tabCount ?? workspace?.tab_count ?? workspace?.tabs?.length ?? 0;
    const status = normalizeStatus(workspace);
    return { ...workspace, id: id == null ? null : String(id), label: String(workspace?.label ?? id ?? 'workspace'), number: Number.isFinite(Number(workspace?.number)) ? Number(workspace.number) : null, paneCount: Number.isFinite(Number(paneCount)) ? Number(paneCount) : 0, tabCount: Number.isFinite(Number(tabCount)) ? Number(tabCount) : 0, status, statusText: statusText(status), statusTag: statusTag(status) };
  });
  const paneCount = workspaces.reduce((total, item) => total + item.paneCount, 0); const tabCount = workspaces.reduce((total, item) => total + item.tabCount, 0); const allStatus = spaceStatus(workspaces);
  return [{ id: null, label: 'ALL', number: null, paneCount, tabCount, status: allStatus, statusText: statusText(allStatus), statusTag: statusTag(allStatus), isAll: true }, ...workspaces.map((workspace) => ({ ...workspace, isAll: false }))];
}

export function buildRuntimeTotals(input) {
  const agents = listFrom(input); const totals = { spaces: workspaceList(input).length, agents: agents.length, working: 0, blocked: 0, idle: 0, done: 0 };
  for (const agent of agents) { const status = normalizeStatus(agent); if (COUNTED_STATUSES.includes(status)) totals[status] += 1; }
  return totals;
}

export const aggregateRuntimeTotals = buildRuntimeTotals;
export const progressBar = asciiProgress;
export const occupancyBar = asciiOccupancy;
export const getAgentViewModels = buildAgentViewModels;
export const getTabViewModels = buildTabViewModels;
