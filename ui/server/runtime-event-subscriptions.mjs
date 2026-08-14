const LIFECYCLE_TYPES = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'pane.agent_status_changed',
  'layout.updated',
];
const STATUS_EVENT_TYPE = 'pane.agent_status_changed';
const GLOBAL_LIFECYCLE_TYPES = LIFECYCLE_TYPES.filter((type) => type !== STATUS_EVENT_TYPE);

const RUNTIME_EVENT_NAMES = new Set(
  LIFECYCLE_TYPES.flatMap((name) => [name, name.replaceAll('.', '_')]),
);

export const RUNTIME_EVENT_SUBSCRIPTIONS = Object.freeze(
  GLOBAL_LIFECYCLE_TYPES.map((type) => Object.freeze({ type })),
);

export const RUNTIME_SUBSCRIPTIONS = RUNTIME_EVENT_SUBSCRIPTIONS;

export function paneIdsFromSnapshot(snapshot) {
  const panes = Array.isArray(snapshot?.agents) ? snapshot.agents
    : (Array.isArray(snapshot?.panes) ? snapshot.panes : []);
  return [...new Set(panes.map((pane) => pane?.pane_id ?? pane?.paneId)
    .filter((paneId) => typeof paneId === 'string' && paneId.trim() !== '')
    .map((paneId) => paneId.trim()))].sort();
}

export function buildRuntimeEventSubscriptions(snapshot) {
  const paneIds = paneIdsFromSnapshot(snapshot);
  return Object.freeze(LIFECYCLE_TYPES.flatMap((type) => type === STATUS_EVENT_TYPE
    ? paneIds.map((pane_id) => Object.freeze({ type, pane_id }))
    : [Object.freeze({ type })]));
}

export function samePaneIds(left, right) {
  return left.length === right.length && left.every((paneId, index) => paneId === right[index]);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableRuntimeCode(error, fallback = 'ERR_RUNTIME') {
  const raw = typeof error?.code === 'string' ? error.code : fallback;
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

export function snapshotFromResponse(response) {
  if (!record(response)) throw Object.assign(new Error(), { code: 'ERR_RUNTIME_SNAPSHOT' });
  if (response.type === 'session_snapshot') return response.snapshot;
  if (record(response.snapshot)) return response.snapshot;
  return response;
}

export function closeRuntimeClient(client) {
  if (!client) return Promise.resolve();
  const method = typeof client.close === 'function' ? client.close
    : (typeof client.disconnect === 'function' ? client.disconnect : null);
  if (!method) return Promise.resolve();
  try {
    return Promise.resolve(method.call(client)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function addRuntimeListener(client, event, callback) {
  if (event === 'event' && typeof client.onEvent === 'function') {
    const remove = client.onEvent(callback);
    return typeof remove === 'function' ? remove : () => {};
  }
  if (typeof client.on !== 'function') return () => {};
  client.on(event, callback);
  return () => {
    if (typeof client.off === 'function') client.off(event, callback);
    else client.removeListener?.(event, callback);
  };
}

export function removeRuntimeListeners(listeners) {
  for (const remove of listeners) remove();
  return [];
}

export function cancelRuntimeTimer(owner, field, clearTimeout) {
  if (owner[field] === null) return;
  clearTimeout(owner[field]);
  owner[field] = null;
}

function eventCandidates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidates = [value.event, value.type, value.kind];
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    candidates.push(value.data.event, value.data.type, value.data.kind);
  }
  return candidates.filter((candidate) => typeof candidate === 'string');
}

export function isRuntimeEvent(value) {
  return eventCandidates(value).some((candidate) => RUNTIME_EVENT_NAMES.has(candidate));
}
