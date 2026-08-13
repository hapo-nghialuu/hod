import { HOD_ROLE_SETTINGS_ERROR_CODES } from './settings/hod-role-inspector.mjs';
import { HERDR_CONFIG_SETTINGS_ERROR_CODES } from './settings/herdr-config-settings.mjs';

export const GLOBAL_OBSERVER_CAPABILITIES = Object.freeze({
  settings: true,
  control: false,
  mutation: true,
});

const MAX_PANE_ID_LENGTH = 256;
const SETTINGS_ERROR_DEFINITIONS = new Map([
  ['ERR_INVALID_BODY', [400, 'Request body is invalid']],
  ['ERR_WORKSPACE_ID', [400, 'Workspace ID is invalid']],
  ['ERR_WORKSPACE_REQUIRED', [400, 'A workspace must be selected']],
  ['ERR_WORKSPACE_NOT_FOUND', [404, 'Workspace was not found']],
  ['ERR_WORKSPACE_AMBIGUOUS', [409, 'Workspace target is ambiguous']],
  ['ERR_WORKSPACE_UNSAFE', [409, 'Workspace target is unsafe']],
  ['ERR_WORKSPACE_SNAPSHOT', [503, 'Workspace snapshot is unavailable']],
  ['ERR_SETTINGS_UNAVAILABLE', [503, 'Settings are unavailable']],
  [HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG, [400, 'Invalid HOD settings request']],
  [HOD_ROLE_SETTINGS_ERROR_CODES.UNKNOWN_ROLE, [400, 'HOD role is not allowed']],
  [HOD_ROLE_SETTINGS_ERROR_CODES.CONFIRMATION, [400, 'Confirmation is invalid']],
  [HOD_ROLE_SETTINGS_ERROR_CODES.FORCE_REQUIRED, [409, 'HOD role overwrite requires force']],
  [HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE, [409, 'HOD role destination is unsafe']],
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIG, [400, 'Invalid Herdr settings request']],
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.KEY, [400, 'Herdr setting key is not allowed']],
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.VALUE, [400, 'Herdr setting value is invalid']],
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIRMATION, [400, 'Confirmation is invalid']],
  ['ERR_HERDR_CONFIG_CHANGED', [409, 'Herdr config changed during update']],
  ['ERR_SETTINGS_RESPONSE', [500, 'Settings service response is invalid']],
]);
const FORBIDDEN_QUERY_KEYS = new Set([
  'path', 'cwd', 'foreground_cwd', 'foregroundCwd', 'project', 'projectRoot', 'project_root',
  'checkoutPath', 'checkout_path', 'worktree', 'worktreeRoot', 'worktree_root', 'directory', 'root',
]);
const SETTINGS_BODY_KEYS = Object.freeze({
  hod: new Set(['workspaceId', 'role', 'force', 'confirmation']),
  herdr: new Set(['workspaceId', 'key', 'value', 'confirmation']),
});

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

function queryOf(request) {
  const value = request?.path ?? request?.pathname ?? request?.url;
  if (typeof value !== 'string') return null;
  try { return new URL(value, 'http://hod.local').searchParams; } catch { return null; }
}

function settingsWorkspaceId(request) {
  const query = queryOf(request);
  if (!query) return { error: 'ERR_INVALID_QUERY' };
  for (const key of query.keys()) if (key !== 'workspaceId' || FORBIDDEN_QUERY_KEYS.has(key)) return { error: 'ERR_INVALID_QUERY' };
  const values = query.getAll('workspaceId');
  if (values.length > 1 || values[0] === '') return { error: 'ERR_WORKSPACE_ID' };
  return { workspaceId: values[0] ?? null };
}

function settingsBody(body, kind) {
  if (!record(body)) return null;
  const allowed = SETTINGS_BODY_KEYS[kind];
  if (!allowed || Reflect.ownKeys(body).some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
  const output = {};
  for (const key of allowed) if (Object.hasOwn(body, key)) output[key] = body[key];
  return output;
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

function publicSettingsError(error, fallbackCode = 'ERR_SETTINGS_READ', fallbackMessage = 'Unable to read settings') {
  const definition = SETTINGS_ERROR_DEFINITIONS.get(error?.code);
  if (definition) return errorResponse(definition[0], error.code, definition[1]);
  return errorResponse(500, fallbackCode, fallbackMessage);
}

export class GlobalObserverApiController {
  constructor({ runtimeStore, store, selectTranscript, settingsController, settings } = {}) {
    this.store = runtimeStore ?? store;
    this.selectTranscript = selectTranscript;
    this.settingsController = settingsController ?? settings ?? null;
    if (!this.store) throw new TypeError('runtime store is required');
    this.capabilities = GLOBAL_OBSERVER_CAPABILITIES;
  }

  async handle(request, path, body) {
    const input = typeof request === 'string' ? { method: request, path, body } : request;
    const method = methodOf(input);
    const pathname = routePath(input);
    if (method === 'GET' && pathname === '/api/settings') {
      const getSettings = this.settingsController?.get ?? this.settingsController?.getSettings;
      if (typeof getSettings !== 'function') return publicSettingsError(null, 'ERR_SETTINGS_UNAVAILABLE', 'Settings are unavailable');
      const selected = settingsWorkspaceId(input);
      if (selected.error === 'ERR_INVALID_QUERY') return errorResponse(400, selected.error, 'Settings query is invalid');
      if (selected.error) return publicSettingsError({ code: selected.error });
      try { return response(200, await getSettings.call(this.settingsController, selected.workspaceId)); }
      catch (error) { return publicSettingsError(error); }
    }
    if (method === 'POST' && (pathname === '/api/settings/hod' || pathname === '/api/settings/herdr')) {
      const query = settingsWorkspaceId(input);
      if (query.error === 'ERR_INVALID_QUERY') return errorResponse(400, query.error, 'Settings query is invalid');
      if (query.error) return publicSettingsError({ code: query.error });
      const body = settingsBody(input?.body, pathname.endsWith('/hod') ? 'hod' : 'herdr');
      if (!body) return errorResponse(400, 'ERR_INVALID_BODY', 'Request body is invalid');
      const handler = pathname.endsWith('/hod') ? this.settingsController?.postHod ?? this.settingsController?.updateHod
        : this.settingsController?.postHerdr ?? this.settingsController?.updateHerdr;
      if (typeof handler !== 'function') return publicSettingsError(null, 'ERR_SETTINGS_UNAVAILABLE', 'Settings are unavailable');
      try { return response(200, await handler.call(this.settingsController, body)); }
      catch (error) { return publicSettingsError(error, 'ERR_SETTINGS_UPDATE', 'Unable to update settings'); }
    }
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
