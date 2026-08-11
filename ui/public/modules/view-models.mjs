export const STATUS_PRIORITY = Object.freeze({ blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 });

const STATUS_META = Object.freeze({
  blocked: { text: 'blocked', tag: '[ERR]' },
  working: { text: 'working', tag: '[WORK]' },
  idle: { text: 'idle', tag: '[WAIT]' },
  done: { text: 'done', tag: '[DONE]' },
  unknown: { text: 'unknown', tag: '[UNKNOWN]' },
});

function listFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.agents)) return input.agents;
  if (Array.isArray(input?.runtime?.agents)) return input.runtime.agents;
  return [];
}

function rawStatus(value) {
  const candidate = typeof value === 'string'
    ? value
    : value?.status ?? value?.state ?? value?.agent_status ?? value?.lifecycle?.status;
  return typeof candidate === 'string' ? candidate.toLowerCase() : 'unknown';
}

export function normalizeStatus(value) {
  const status = rawStatus(value);
  if (status === 'running' || status === 'active' || status === 'in_progress') return 'working';
  if (status === 'waiting' || status === 'pending' || status === 'paused') return 'idle';
  if (status === 'complete' || status === 'completed' || status === 'success') return 'done';
  if (status === 'error' || status === 'failed' || status === 'failure') return 'blocked';
  return STATUS_PRIORITY[status] === undefined ? 'unknown' : status;
}

export function statusTag(value) {
  return STATUS_META[normalizeStatus(value)].tag;
}

export function statusText(value) {
  return STATUS_META[normalizeStatus(value)].text;
}

function workspaceOf(agent) {
  const workspace = agent?.workspaceId ?? agent?.workspace_id ?? agent?.spaceId;
  if (workspace !== undefined && workspace !== null) return String(workspace);
  if (typeof agent?.workspace === 'string') return agent.workspace;
  if (agent?.workspace?.id !== undefined) return String(agent.workspace.id);
  return null;
}

function agentName(agent) {
  return String(agent?.name ?? agent?.display ?? agent?.title ?? agent?.label ?? agent?.id ?? 'agent');
}

function agentId(agent) {
  return agent?.paneId ?? agent?.pane_id ?? agent?.id ?? null;
}

export function filterAgents(input, selectedWorkspace = null) {
  const agents = listFrom(input);
  if (selectedWorkspace === null || selectedWorkspace === undefined || selectedWorkspace === '') {
    return agents.slice();
  }
  const wanted = String(selectedWorkspace);
  return agents.filter((agent) => workspaceOf(agent) === wanted);
}

export function sortAgents(input) {
  return listFrom(input)
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[normalizeStatus(left.agent)] - STATUS_PRIORITY[normalizeStatus(right.agent)];
      if (priority) return priority;
      const leftName = agentName(left.agent);
      const rightName = agentName(right.agent);
      if (leftName < rightName) return -1;
      if (leftName > rightName) return 1;
      return left.index - right.index;
    })
    .map(({ agent }) => agent);
}

export function agentViewModel(agent) {
  const status = normalizeStatus(agent);
  return {
    ...agent,
    id: agentId(agent) == null ? null : String(agentId(agent)),
    displayName: agentName(agent),
    workspaceId: workspaceOf(agent),
    status,
    statusText: STATUS_META[status].text,
    statusTag: STATUS_META[status].tag,
    statusPriority: STATUS_PRIORITY[status],
  };
}

export function buildAgentViewModels(input, selectedWorkspace = null) {
  return sortAgents(filterAgents(input, selectedWorkspace)).map(agentViewModel);
}

export function progressRatio(value, total) {
  const current = Number(value);
  const maximum = Number(total);
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(1, Math.max(0, current / maximum));
}

export function progressPercent(value, total) {
  return Math.round(progressRatio(value, total) * 100);
}

function bar(value, total, width) {
  const safeWidth = Math.min(80, Math.max(1, Number.isInteger(width) ? width : 10));
  const filled = Math.round(progressRatio(value, total) * safeWidth);
  return '|'.repeat(filled) + '.'.repeat(safeWidth - filled);
}

export function asciiProgress(value, total, width = 10) {
  return `[${bar(value, total, width)}] ${progressPercent(value, total)}%`;
}

export function asciiOccupancy(used, capacity, width = 10) {
  return `[${bar(used, capacity, width)}] ${progressPercent(used, capacity)}%`;
}

function naturalCompare(left, right) {
  const leftParts = String(left ?? '').match(/(\d+|\D+)/g) ?? [''];
  const rightParts = String(right ?? '').match(/(\d+|\D+)/g) ?? [''];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? '';
    const rightPart = rightParts[index] ?? '';
    if (/^\d+$/.test(leftPart) && /^\d+$/.test(rightPart)) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference) return difference;
    } else if (leftPart.toLowerCase() < rightPart.toLowerCase()) return -1;
    else if (leftPart.toLowerCase() > rightPart.toLowerCase()) return 1;
  } return 0;
}

function workspaceList(input) {
  return Array.isArray(input) ? input : Array.isArray(input?.workspaces) ? input.workspaces
    : Array.isArray(input?.spaces) ? input.spaces : Array.isArray(input?.runtime?.workspaces)
      ? input.runtime.workspaces : [];
}

function spaceStatus(workspaces) {
  return workspaces.reduce((current, workspace) => STATUS_PRIORITY[normalizeStatus(workspace)] < STATUS_PRIORITY[current]
    ? normalizeStatus(workspace) : current, 'unknown');
}

export function buildSpaceViewModels(input) {
  const workspaces = workspaceList(input)
    .map((workspace, index) => ({ workspace, index }))
    .sort((left, right) => {
      const leftNumber = Number(left.workspace?.number);
      const rightNumber = Number(right.workspace?.number);
      const leftHasNumber = Number.isFinite(leftNumber);
      const rightHasNumber = Number.isFinite(rightNumber);
      if (leftHasNumber && rightHasNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
      if (leftHasNumber !== rightHasNumber) return leftHasNumber ? -1 : 1;
      const leftId = left.workspace?.id ?? left.workspace?.workspaceId ?? left.workspace?.workspace_id;
      const rightId = right.workspace?.id ?? right.workspace?.workspaceId ?? right.workspace?.workspace_id;
      return naturalCompare(leftId, rightId) || left.index - right.index;
    })
    .map(({ workspace }) => {
      const id = workspace?.id ?? workspace?.workspaceId ?? workspace?.workspace_id;
      const paneCount = workspace?.paneCount ?? workspace?.pane_count ?? 0;
      const tabCount = workspace?.tabCount ?? workspace?.tab_count ?? 0;
      const status = normalizeStatus(workspace);
      return {
        ...workspace,
        id: id == null ? null : String(id),
        label: String(workspace?.label ?? id ?? 'workspace'),
        number: Number.isFinite(Number(workspace?.number)) ? Number(workspace.number) : null,
        paneCount: Number.isFinite(Number(paneCount)) ? Number(paneCount) : 0,
        tabCount: Number.isFinite(Number(tabCount)) ? Number(tabCount) : 0,
        status,
        statusText: statusText(status),
        statusTag: statusTag(status),
      };
    });
  const paneCount = workspaces.reduce((total, item) => total + item.paneCount, 0);
  const tabCount = workspaces.reduce((total, item) => total + item.tabCount, 0); const allStatus = spaceStatus(workspaces);
  return [{
    id: null,
    label: 'ALL',
    number: null,
    paneCount,
    tabCount,
    status: allStatus,
    statusText: statusText(allStatus),
    statusTag: statusTag(allStatus),
    isAll: true,
  }, ...workspaces.map((workspace) => ({ ...workspace, isAll: false }))];
}

export const progressBar = asciiProgress;
export const occupancyBar = asciiOccupancy;
export const getAgentViewModels = buildAgentViewModels;
