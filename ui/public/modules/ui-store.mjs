export const ACTIONS = Object.freeze({
  CONNECTION: 'connection/set',
  RECONNECTING: 'connection/reconnecting',
  STATE_REPLACE: 'runtime/replace',
  TRANSCRIPT_REPLACE: 'transcript/replace',
  TRANSCRIPT_SELECT: 'transcript/select',
  TRANSCRIPT_CLEAR: 'transcript/clear',
  SETTINGS_REPLACE: 'settings/replace',
  VIEW_SET: 'view/set',
  WORKSPACE_SET: 'workspace/set',
  FOLLOW_TAIL_SET: 'transcript/follow-tail',
  STATUSBAR_SET: 'statusbar/set',
});

const CLEARING_STATUSES = new Set(['connecting', 'reconnecting', 'disconnected']);
const VALID_VIEWS = new Set(['runtime', 'settings']);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

function frozen(value) {
  const output = clone(value);
  Object.defineProperty(output, 'selectedTranscript', { enumerable: false, get: () => output.transcript });
  return freeze(output);
}

export function createInitialState(overrides = {}) {
  return frozen({
    runtime: null,
    transcript: null,
    settings: null,
    connection: { status: 'connecting', errorCode: null },
    view: 'runtime',
    selectedWorkspace: null,
    followTail: true,
    statusbar: { message: 'hod UI console', status: '—' },
    ...clone(overrides),
  });
}

export const initialState = createInitialState();

function payloadOf(action, key) {
  if (action[key] !== undefined) return action[key];
  if (action.payload !== undefined) return action.payload;
  return null;
}

function connectionValue(value) {
  if (typeof value === 'string') return { status: value, errorCode: null };
  const status = value?.status ?? value?.state ?? 'unknown';
  const candidate = value?.errorCode ?? value?.code;
  const errorCode = typeof candidate === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(candidate)
    ? candidate
    : (candidate ? 'ERR_CONNECTION' : null);
  return { status: String(status), errorCode };
}

function settingsValue(value) {
  const source = value && typeof value === 'object' ? value : {};
  const output = clone(source);
  const definitions = output.definitions ?? output.metadata;
  const values = output.values ?? output.herdr?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return output;
  const typed = {};
  for (const [key, item] of Object.entries(values)) {
    const definition = definitions?.[key];
    const type = definition?.type;
    const valid = !type
      || (type === 'boolean' && typeof item === 'boolean')
      || (type === 'integer' && Number.isInteger(item))
      || (type === 'string' && typeof item === 'string');
    if (valid) typed[key] = clone(item);
  }
  output.values = typed;
  if (output.herdr?.values) output.herdr.values = clone(typed);
  return output;
}

function clearForReconnect(state, connection = { status: 'reconnecting', errorCode: null }) {
  return {
    ...state,
    runtime: null,
    transcript: null,
    selectedWorkspace: null,
    connection: connectionValue(connection),
  };
}

function transcriptMatchesRuntime(transcript, runtime) {
  if (!transcript) return null;
  if (!runtime || typeof runtime !== 'object') return null;
  const paneId = transcript.paneId ?? transcript.pane_id;
  if (paneId === undefined || paneId === null) return transcript;
  const selectedPaneId = runtime.selectedPaneId ?? runtime.selected_pane_id ?? runtime.selectedPane?.id;
  if (selectedPaneId !== undefined && selectedPaneId !== null && String(selectedPaneId) !== String(paneId)) return null;
  if (!Array.isArray(runtime.agents)) return transcript;
  const found = runtime.agents.some((agent) => {
    const candidate = agent?.paneId ?? agent?.pane_id ?? agent?.pane?.id ?? agent?.id;
    return candidate !== undefined && String(candidate) === String(paneId);
  });
  return found ? transcript : null;
}

export function reducer(state = initialState, action = {}) {
  const current = state ?? initialState;
  const type = action.type;
  if (type === ACTIONS.RECONNECTING || type === 'RECONNECT') {
    return frozen(clearForReconnect(current));
  }
  if (type === ACTIONS.CONNECTION || type === 'CONNECTION_CHANGED') {
    const connection = connectionValue(payloadOf(action, 'connection'));
    if (CLEARING_STATUSES.has(connection.status)) return frozen(clearForReconnect(current, connection));
    return frozen({ ...current, connection });
  }
  if (type === ACTIONS.STATE_REPLACE || type === 'STATE_REPLACE' || type === 'STATE_SNAPSHOT') {
    const runtime = payloadOf(action, 'state');
    return frozen({ ...current, runtime, transcript: transcriptMatchesRuntime(current.transcript, runtime) });
  }
  if (type === ACTIONS.TRANSCRIPT_REPLACE || type === 'TRANSCRIPT_REPLACE') {
    const transcript = payloadOf(action, 'transcript');
    return frozen({ ...current, transcript: transcript == null ? null : transcript });
  }
  if (type === ACTIONS.TRANSCRIPT_SELECT) {
    const paneId = payloadOf(action, 'paneId');
    return frozen({ ...current, transcript: paneId == null ? null : { paneId: String(paneId) } });
  }
  if (type === ACTIONS.TRANSCRIPT_CLEAR) return frozen({ ...current, transcript: null });
  if (type === ACTIONS.SETTINGS_REPLACE || type === 'SETTINGS_REPLACE') {
    return frozen({ ...current, settings: settingsValue(payloadOf(action, 'settings')) });
  }
  if (type === ACTIONS.VIEW_SET) {
    const view = payloadOf(action, 'view');
    return VALID_VIEWS.has(view) ? frozen({ ...current, view }) : current;
  }
  if (type === ACTIONS.WORKSPACE_SET) {
    const workspace = payloadOf(action, 'selectedWorkspace');
    return frozen({ ...current, selectedWorkspace: workspace == null ? null : String(workspace) });
  }
  if (type === ACTIONS.FOLLOW_TAIL_SET) {
    const followTail = payloadOf(action, 'followTail');
    return typeof followTail === 'boolean' ? frozen({ ...current, followTail }) : current;
  }
  if (type === ACTIONS.STATUSBAR_SET) {
    const statusbar = payloadOf(action, 'statusbar') ?? {};
    return frozen({
      ...current,
      statusbar: {
        message: String(statusbar.message ?? current.statusbar.message),
        status: String(statusbar.status ?? current.statusbar.status),
      },
    });
  }
  return current;
}

export function createStore(options = {}, customReducer = reducer) {
  const configured = options && typeof options === 'object' && !Array.isArray(options);
  const reduce = configured && typeof options.reducer === 'function' ? options.reducer : customReducer;
  const looksLikeState = configured && ['runtime', 'transcript', 'settings', 'view'].some((key) => key in options);
  const seed = configured && options.initialState
    ? options.initialState
    : (looksLikeState ? options : initialState);
  let current = frozen(seed);
  const listeners = new Set();
  return {
    getState: () => current,
    dispatch(action) {
      const next = reduce(current, action);
      if (next === current) return current;
      current = next;
      for (const listener of [...listeners]) listener(current, action);
      return current;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const reduce = reducer;
