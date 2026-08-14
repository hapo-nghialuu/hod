export const ACTIONS = Object.freeze({
  CONNECTION: 'connection/set', RECONNECTING: 'connection/reconnecting',
  STATE_REPLACE: 'runtime/replace', TRANSCRIPT_REPLACE: 'transcript/replace', TRANSCRIPT_PUSH: 'transcript/push',
  TRANSCRIPT_SELECT: 'transcript/select', TRANSCRIPT_ERROR: 'transcript/error', TRANSCRIPT_CLEAR: 'transcript/clear',
  SETTINGS_REPLACE: 'settings/replace', VIEW_SET: 'view/set',
  WORKSPACE_SET: 'workspace/set',
  STATUSBAR_SET: 'statusbar/set',
});

export const DEFAULT_CAPABILITIES = Object.freeze({ settings: true, control: true, mutation: true });
const CLEARING_STATUSES = new Set(['connecting', 'reconnecting', 'disconnected']);
const VALID_VIEWS = new Set(['runtime', 'settings']);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function capabilitySource(input) {
  const nested = input?.capabilities ?? input?.runtime?.capabilities;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : input ?? {};
}

export function normalizeCapabilities(input) {
  const source = capabilitySource(input);
  return { settings: source.settings !== false, control: source.control !== false, mutation: source.mutation !== false };
}

export function capabilitiesForState(state) { return normalizeCapabilities(state); }
export function canUseCapability(state, name) { return normalizeCapabilities(state)[name] !== false; }

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function frozen(value) {
  const output = clone(value);
  Object.defineProperty(output, 'selectedTranscript', { enumerable: false, get: () => output.transcript });
  return freeze(output);
}

export function createInitialState(overrides = {}) {
  const output = {
    runtime: null, transcript: null, settings: null,
    connection: { status: 'connecting', errorCode: null },
    capabilities: { ...DEFAULT_CAPABILITIES }, view: 'runtime', selectedWorkspace: null,
    statusbar: { message: 'hod UI console', status: '—' }, ...clone(overrides),
  };
  output.capabilities = normalizeCapabilities(overrides);
  if (!output.capabilities.settings) output.view = 'runtime';
  return frozen(output);
}

export const initialState = createInitialState();
function payloadOf(action, key) { return action[key] !== undefined ? action[key] : action.payload ?? null; }
function requestIdOf(action) { return Number.isSafeInteger(action.requestId) && action.requestId >= 0 ? action.requestId : null; }
function requestMatches(transcript, requestId) { return requestId !== null && transcript?.requestId === requestId; }

export function isValidTranscript(value, paneId) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof paneId === 'string' && typeof value.paneId === 'string' && value.paneId === paneId
    && typeof value.text === 'string' && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function transcriptCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value) ? value : 'ERR_UNAVAILABLE';
}

function connectionValue(value) {
  if (typeof value === 'string') return { status: value, errorCode: null };
  const status = value?.status ?? value?.state ?? 'unknown'; const candidate = value?.errorCode ?? value?.code;
  const errorCode = typeof candidate === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(candidate)
    ? candidate : candidate ? 'ERR_CONNECTION' : null;
  return { status: String(status), errorCode };
}

function settingsValue(value) {
  const output = clone(value && typeof value === 'object' ? value : {});
  const definitions = output.definitions ?? output.metadata; const values = output.values ?? output.herdr?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return output;
  const typed = {};
  for (const [key, item] of Object.entries(values)) {
    const type = definitions?.[key]?.type;
    const valid = !type || { boolean: typeof item === 'boolean', integer: Number.isInteger(item), string: typeof item === 'string' }[type] === true;
    if (valid) typed[key] = clone(item);
  }
  output.values = typed;
  if (output.herdr?.values) output.herdr.values = clone(typed);
  return output;
}

function clearForReconnect(state, connection = { status: 'reconnecting', errorCode: null }) {
  return { ...state, runtime: null, transcript: null, selectedWorkspace: null,
    view: canUseCapability(state, 'settings') ? state.view : 'runtime', connection: connectionValue(connection) };
}

function transcriptMatchesRuntime(transcript, runtime) {
  if (!transcript || !runtime || typeof runtime !== 'object') return null;
  const paneId = transcript.paneId ?? transcript.pane_id;
  if (paneId === undefined || paneId === null) return transcript;
  const hasSelected = Object.hasOwn(runtime, 'selectedPaneId') || Object.hasOwn(runtime, 'selected_pane_id') || Object.hasOwn(runtime, 'selectedPane');
  const selected = Object.hasOwn(runtime, 'selectedPaneId') ? runtime.selectedPaneId : Object.hasOwn(runtime, 'selected_pane_id') ? runtime.selected_pane_id : runtime.selectedPane?.id;
  if (hasSelected && (selected == null || String(selected) !== String(paneId))) return null;
  if (!Array.isArray(runtime.agents)) return transcript;
  return runtime.agents.some((agent) => {
    const candidate = agent?.paneId ?? agent?.pane_id ?? agent?.pane?.id ?? agent?.id;
    return candidate !== undefined && String(candidate) === String(paneId);
  }) ? transcript : null;
}

export function reducer(state = initialState, action = {}) {
  const current = state ?? initialState; const type = action.type;
  if (type === ACTIONS.RECONNECTING || type === 'RECONNECT') return frozen(clearForReconnect(current));
  if (type === ACTIONS.CONNECTION || type === 'CONNECTION_CHANGED') {
    const connection = connectionValue(payloadOf(action, 'connection'));
    return frozen(CLEARING_STATUSES.has(connection.status) ? clearForReconnect(current, connection) : { ...current, connection });
  }
  if (type === ACTIONS.STATE_REPLACE || type === 'STATE_REPLACE' || type === 'STATE_SNAPSHOT') {
    const runtime = payloadOf(action, 'state'); const capabilities = normalizeCapabilities(runtime);
    const view = capabilities.settings || current.view !== 'settings' ? current.view : 'runtime';
    return frozen({ ...current, runtime, capabilities, view,
      settings: capabilities.settings ? current.settings : null,
      transcript: transcriptMatchesRuntime(current.transcript, runtime) });
  }
  if (type === ACTIONS.TRANSCRIPT_REPLACE || type === 'TRANSCRIPT_REPLACE') {
    const transcript = payloadOf(action, 'transcript');
    const selected = current.transcript;
    if (!selected || selected.status !== 'loading' || !isValidTranscript(transcript, selected.paneId) || !requestMatches(selected, requestIdOf(action))) return current;
    return frozen({ ...current, transcript: { ...transcript, status: 'success', requestId: requestIdOf(action) ?? selected.requestId } });
  }
  if (type === ACTIONS.TRANSCRIPT_PUSH) {
    const transcript = payloadOf(action, 'transcript'); const selected = current.transcript;
    const requestId = requestIdOf(action);
    if (!selected || selected.status !== 'success' || !isValidTranscript(transcript, selected.paneId) || (requestId !== null && requestId !== selected.requestId)
      || !Number.isSafeInteger(selected.revision) || transcript.revision < selected.revision) return current;
    return frozen({ ...current, transcript: { ...transcript, status: 'success', requestId: selected.requestId } });
  }
  if (type === ACTIONS.TRANSCRIPT_SELECT) {
    const paneId = payloadOf(action, 'paneId');
    if (paneId == null) return frozen({ ...current, transcript: null });
    const requestId = requestIdOf(action); const currentId = current.transcript?.requestId;
    if (requestId !== null && Number.isSafeInteger(currentId) && requestId < currentId) return current;
    return frozen({ ...current, transcript: { paneId: String(paneId), status: 'loading', requestId: requestId ?? (currentId ?? 0) + 1 } });
  }
  if (type === ACTIONS.TRANSCRIPT_ERROR) {
    const selected = current.transcript; const paneId = payloadOf(action, 'paneId');
    if (!selected || selected.status !== 'loading' || selected.paneId !== String(paneId) || !requestMatches(selected, requestIdOf(action))) return current;
    return frozen({ ...current, transcript: { ...selected, status: 'error', errorCode: transcriptCode(payloadOf(action, 'errorCode')) } });
  }
  if (type === ACTIONS.TRANSCRIPT_CLEAR) return frozen({ ...current, transcript: null });
  if (type === ACTIONS.SETTINGS_REPLACE || type === 'SETTINGS_REPLACE') {
    return frozen({ ...current, settings: settingsValue(payloadOf(action, 'settings')) });
  }
  if (type === ACTIONS.VIEW_SET) {
    const view = payloadOf(action, 'view');
    if (!VALID_VIEWS.has(view) || (view === 'settings' && !canUseCapability(current, 'settings'))) return current;
    return frozen({ ...current, view });
  }
  if (type === ACTIONS.WORKSPACE_SET) {
    const workspace = payloadOf(action, 'selectedWorkspace');
    return frozen({ ...current, selectedWorkspace: workspace == null ? null : String(workspace) });
  }
  if (type === ACTIONS.STATUSBAR_SET) {
    const statusbar = payloadOf(action, 'statusbar') ?? {};
    return frozen({ ...current, statusbar: {
      message: String(statusbar.message ?? current.statusbar.message),
      status: String(statusbar.status ?? current.statusbar.status),
    } });
  }
  return current;
}

export function createStore(options = {}, customReducer = reducer) {
  const configured = options && typeof options === 'object' && !Array.isArray(options);
  const reduce = configured && typeof options.reducer === 'function' ? options.reducer : customReducer;
  const looksLikeState = configured && ['runtime', 'transcript', 'settings', 'view'].some((key) => key in options);
  const seed = configured && options.initialState ? options.initialState : looksLikeState ? options : initialState;
  let current = seed === initialState ? initialState : createInitialState(seed); const listeners = new Set();
  return {
    getState: () => current,
    dispatch(action) {
      const next = reduce(current, action); if (next === current) return current;
      current = next; for (const listener of [...listeners]) listener(current, action); return current;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener); return () => listeners.delete(listener);
    },
  };
}

export const reduce = reducer;
