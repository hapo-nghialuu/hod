import { normalizeOrchestrationMetadata } from './orchestration-metadata.mjs';

export const CONNECTION_STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'reconnecting']);
export const AGENT_STATUSES = Object.freeze(['idle', 'working', 'blocked', 'done', 'unknown']);

export class RuntimeSnapshotError extends TypeError {
  constructor() {
    super('Runtime snapshot is invalid');
    this.name = 'RuntimeSnapshotError';
    this.code = 'ERR_RUNTIME_SNAPSHOT';
  }
}

function invalid() {
  throw new RuntimeSnapshotError();
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(object, snake, camel = snake) {
  if (Object.hasOwn(object, snake)) return object[snake];
  return object[camel];
}

function id(value) {
  if (typeof value !== 'string' || value.trim() === '') invalid();
  return value.trim();
}

function text(value) {
  if (typeof value !== 'string') invalid();
  return value;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  return text(value);
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function optionalInteger(value) { return value === undefined || value === null ? null : integer(value); }

function state(value) {
  if (!AGENT_STATUSES.includes(value)) invalid();
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function sortByNumber(left, right) {
  return left.number - right.number || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function unwrap(input) {
  if (!record(input)) invalid();
  if (record(input.result) && input.result.type === 'session_snapshot') return unwrap(input.result);
  if (record(input.snapshot) && !Array.isArray(input.workspaces)) return unwrap(input.snapshot);
  return input;
}

export function normalizeConnectionMetadata(input, source = {}) {
  const value = record(input) ? input : {};
  const connectionState = value.state ?? 'connected';
  if (!CONNECTION_STATES.includes(connectionState)) invalid();
  const versionValue = value.version ?? source.version ?? null;
  const protocolValue = value.protocol ?? source.protocol ?? null;
  const version = optionalText(versionValue);
  if (version !== null && version.trim() === '') invalid();
  if (protocolValue !== null) integer(protocolValue);
  let errorCode = null;
  if (value.errorCode !== undefined && value.errorCode !== null) {
    errorCode = typeof value.errorCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.errorCode)
      ? value.errorCode.toUpperCase()
      : 'ERR_CONNECTION';
  }
  return { state: connectionState, version: version?.trim() ?? null, protocol: protocolValue, errorCode };
}

export function normalizeSnapshot(input, connection) {
  const source = unwrap(input);
  const workspacesInput = source.workspaces;
  const tabsInput = source.tabs;
  const agentsInput = Array.isArray(source.agents) ? source.agents : source.panes;
  if (!Array.isArray(workspacesInput) || !Array.isArray(tabsInput) || !Array.isArray(agentsInput)) invalid();

  const workspaces = workspacesInput.map((item) => {
    if (!record(item)) invalid();
    return {
      id: id(field(item, 'workspace_id', 'workspaceId') ?? field(item, 'id')),
      number: integer(field(item, 'number')),
      label: text(field(item, 'label')),
      paneCount: integer(field(item, 'pane_count', 'paneCount')),
      tabCount: integer(field(item, 'tab_count', 'tabCount')),
      status: state(field(item, 'agent_status', 'status')),
      focused: boolean(field(item, 'focused')),
    };
  });
  const workspaceIds = new Set(workspaces.map((item) => item.id));
  if (workspaceIds.size !== workspaces.length) invalid();
  workspaces.sort(sortByNumber);

  const workspaceOrder = new Map(workspaces.map((item, index) => [item.id, index]));
  const tabs = tabsInput.map((item) => {
    if (!record(item)) invalid();
    const workspaceId = id(field(item, 'workspace_id', 'workspaceId'));
    if (!workspaceIds.has(workspaceId)) invalid();
    return {
      id: id(field(item, 'tab_id', 'tabId') ?? field(item, 'id')),
      workspaceId,
      number: integer(field(item, 'number')),
      label: text(field(item, 'label')),
      paneCount: integer(field(item, 'pane_count', 'paneCount')),
      status: state(field(item, 'agent_status', 'status')),
      focused: boolean(field(item, 'focused')),
    };
  });
  const tabIds = new Set(tabs.map((item) => item.id));
  if (tabIds.size !== tabs.length) invalid();
  tabs.sort((left, right) => workspaceOrder.get(left.workspaceId) - workspaceOrder.get(right.workspaceId)
    || sortByNumber(left, right));
  const tabById = new Map(tabs.map((item) => [item.id, item]));

  const agents = agentsInput.map((item) => {
    if (!record(item)) invalid();
    const workspaceId = id(field(item, 'workspace_id', 'workspaceId'));
    const tabId = id(field(item, 'tab_id', 'tabId'));
    const tab = tabById.get(tabId);
    if (!workspaceIds.has(workspaceId) || !tab || tab.workspaceId !== workspaceId) invalid();
    const title = field(item, 'title') ?? field(item, 'terminal_title_stripped') ?? field(item, 'terminal_title');
    const display = field(item, 'display_agent', 'display');
    const agentKind = field(item, 'agent', 'agentKind');
    return {
      paneId: id(field(item, 'pane_id', 'paneId')),
      workspaceId,
      tabId,
      name: optionalText(field(item, 'name') ?? display ?? agentKind),
      display: optionalText(display),
      agentKind: optionalText(agentKind),
      status: state(field(item, 'agent_status', 'status')),
      title: optionalText(title),
      focused: boolean(field(item, 'focused')),
      revision: integer(field(item, 'revision')),
      stateChangeSeq: optionalInteger(field(item, 'state_change_seq', 'stateChangeSeq')),
      orchestration: normalizeOrchestrationMetadata(item.tokens),
      _workspaceOrder: workspaceOrder.get(workspaceId),
      _tabNumber: tab.number,
    };
  });
  const paneIds = new Set(agents.map((item) => item.paneId));
  if (paneIds.size !== agents.length) invalid();
  agents.sort((left, right) => left._workspaceOrder - right._workspaceOrder
    || left._tabNumber - right._tabNumber
    || (left.paneId < right.paneId ? -1 : left.paneId > right.paneId ? 1 : 0));
  for (const agent of agents) {
    delete agent._workspaceOrder;
    delete agent._tabNumber;
  }

  return {
    connection: normalizeConnectionMetadata(connection ?? input?.connection, source),
    workspaces,
    tabs,
    agents,
    selectedPaneId: null,
  };
}
