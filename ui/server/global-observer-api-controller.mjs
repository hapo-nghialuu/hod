export const GLOBAL_OBSERVER_CAPABILITIES = Object.freeze({
  settings: false,
  control: false,
  mutation: false,
});

const SETTINGS_ROUTES = new Set(['/api/settings', '/api/settings/hod', '/api/settings/herdr']);
const MAX_PANE_ID_LENGTH = 256;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function response(status, body) { return { status, body }; }

function errorResponse(status, code, message) {
  return response(status, { error: { code, message } });
}

function routePath(request) {
  const value = request?.path ?? request?.pathname ?? request?.url;
  if (typeof value !== 'string') return null;
  try { return new URL(value, 'http://hod.local').pathname; } catch { return null; }
}

function methodOf(request) {
  return typeof request?.method === 'string' ? request.method.toUpperCase() : '';
}

function runtimeSnapshot(store) {
  if (typeof store?.getSnapshot === 'function') return store.getSnapshot();
  if (typeof store?.snapshot === 'function') return store.snapshot();
  throw new Error('runtime store unavailable');
}

function stateWithCapabilities(snapshot) {
  if (!record(snapshot)) throw new Error('runtime state is invalid');
  return { ...snapshot, capabilities: { ...GLOBAL_OBSERVER_CAPABILITIES } };
}

function publicTranscript(value, paneId) {
  const source = record(value) && Object.hasOwn(value, 'transcript') ? value.transcript : value;
  if (!record(source)) return null;
  const sourcePaneId = source.paneId ?? source.pane_id;
  if (typeof sourcePaneId !== 'string' || sourcePaneId !== paneId
    || typeof source.text !== 'string'
    || !Number.isSafeInteger(source.revision) || source.revision < 0) return null;
  const output = { paneId };
  output.text = source.text;
  output.revision = source.revision;
  for (const key of ['truncated', 'gap', 'reconnecting', 'bridgeTruncated']) {
    if (typeof source[key] === 'boolean') output[key] = source[key];
  }
  return output;
}

function settingsRouteError() { return response(404, { error: { code: 'ERR_ROUTE' } }); }

export class GlobalObserverApiController {
  constructor({ runtimeStore, store, selectTranscript } = {}) {
    this.store = runtimeStore ?? store;
    this.selectTranscript = selectTranscript;
    if (!this.store) throw new TypeError('runtime store is required');
    this.capabilities = GLOBAL_OBSERVER_CAPABILITIES;
  }

  async handle(request, path, body) {
    const input = typeof request === 'string' ? { method: request, path, body } : request;
    const method = methodOf(input);
    const pathname = routePath(input);
    if (SETTINGS_ROUTES.has(pathname)) return settingsRouteError();
    if (method === 'GET' && pathname === '/api/state') {
      try { return response(200, stateWithCapabilities(runtimeSnapshot(this.store))); }
      catch { return errorResponse(500, 'ERR_RUNTIME_STATE', 'Unable to read runtime state'); }
    }
    if (method !== 'POST' || pathname !== '/api/transcript/select') return null;
    if (!record(input?.body) || typeof input.body.paneId !== 'string') {
      return errorResponse(400, 'ERR_INVALID_BODY', 'Request body is invalid');
    }
    const paneId = input.body.paneId.trim();
    if (paneId.length === 0 || paneId.length > MAX_PANE_ID_LENGTH) {
      return errorResponse(400, 'ERR_INVALID_PANE_ID', 'paneId is invalid');
    }
    let snapshot;
    try { snapshot = runtimeSnapshot(this.store); }
    catch { return errorResponse(500, 'ERR_RUNTIME_STATE', 'Unable to read runtime state'); }
    if (!Array.isArray(snapshot?.agents) || !snapshot.agents.some((agent) => agent?.paneId === paneId)) {
      return errorResponse(404, 'ERR_PANE_NOT_FOUND', 'Pane was not found');
    }
    try {
      this.store.selectPane?.(paneId);
      const selected = typeof this.selectTranscript === 'function'
        ? await this.selectTranscript(paneId) : null;
      const transcript = publicTranscript(selected, paneId);
      return transcript ? response(200, transcript)
        : errorResponse(502, 'ERR_TRANSCRIPT_INVALID', 'Transcript response is invalid');
    } catch { return errorResponse(500, 'ERR_TRANSCRIPT_SELECT', 'Unable to select transcript'); }
  }
}

export const createGlobalObserverApiController = (options) => new GlobalObserverApiController(options);
export const createGlobalObserverApi = createGlobalObserverApiController;
