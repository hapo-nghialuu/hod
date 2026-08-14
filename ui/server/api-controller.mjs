import { HOD_ROLE_SETTINGS_ERROR_CODES } from './settings/hod-role-inspector.mjs';
import { HERDR_CONFIG_SETTINGS_ERROR_CODES } from './settings/herdr-config-settings.mjs';

export const MAX_PANE_ID_LENGTH = 256;

const HOD_CODES = HOD_ROLE_SETTINGS_ERROR_CODES;
const HERDR_CODES = HERDR_CONFIG_SETTINGS_ERROR_CODES;
const ERROR_DEFINITIONS = new Map([
  [HOD_CODES.CONFIG, [400, 'Invalid HOD settings request']],
  [HOD_CODES.UNKNOWN_ROLE, [400, 'HOD role is not allowed']],
  [HOD_CODES.CONFIRMATION, [400, 'Confirmation is invalid']],
  [HOD_CODES.FORCE_REQUIRED, [409, 'HOD role overwrite requires force']],
  [HOD_CODES.UNSAFE, [409, 'HOD role destination is unsafe']],
  [HERDR_CODES.CONFIG, [400, 'Invalid Herdr settings request']],
  [HERDR_CODES.KEY, [400, 'Herdr setting key is not allowed']],
  [HERDR_CODES.VALUE, [400, 'Herdr setting value is invalid']],
  [HERDR_CODES.CONFIRMATION, [400, 'Confirmation is invalid']],
  ['ERR_HERDR_CONFIG_CHANGED', [409, 'Herdr config changed during update']],
  ['ERR_SETTINGS_RESPONSE', [500, 'Settings service response is invalid']],
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function response(status, body) {
  return { status, body };
}

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

function publicError(error, fallbackCode, fallbackMessage, fallbackStatus = 500) {
  const definition = ERROR_DEFINITIONS.get(error?.code);
  if (definition) return errorResponse(definition[0], error.code, definition[1]);
  return errorResponse(fallbackStatus, fallbackCode, fallbackMessage);
}

function invalidBody() {
  return errorResponse(400, 'ERR_INVALID_BODY', 'Request body is invalid');
}

function safeSettingsBody(method, body) {
  if (method === 'hod') {
    return { role: body.role, force: body.force, confirmation: body.confirmation };
  }
  return { key: body.key, value: body.value, confirmation: body.confirmation };
}

function selectedTranscript(value, paneId) {
  const source = record(value) && record(value.transcript) ? value.transcript : value;
  if (source === null || source === undefined) return { paneId };
  if (typeof source === 'string') return { paneId, text: source };
  if (!record(source)) return { paneId };
  const output = { paneId };
  if (typeof source.text === 'string') output.text = source.text;
  if (Number.isSafeInteger(source.revision) && source.revision >= 0) output.revision = source.revision;
  for (const key of ['truncated', 'gap', 'reconnecting', 'bridgeTruncated']) {
    if (typeof source[key] === 'boolean') output[key] = source[key];
  }
  return output;
}

function runtimeSnapshot(store) {
  if (typeof store?.getSnapshot === 'function') return store.getSnapshot();
  if (typeof store?.snapshot === 'function') return store.snapshot();
  throw new Error('runtime store unavailable');
}

export function createApiController(options = {}) {
  const store = options.runtimeStore ?? options.store;
  const settings = options.settingsController ?? options.settings;
  const selectTranscript = options.selectTranscript;
  if (!store || typeof settings?.get !== 'function') throw new TypeError('runtime store and settings controller are required');

  async function getState() {
    try { return response(200, runtimeSnapshot(store)); }
    catch (error) { return publicError(error, 'ERR_RUNTIME_STATE', 'Unable to read runtime state'); }
  }

  async function getSettings() {
    try { return response(200, await settings.get()); }
    catch (error) { return publicError(error, 'ERR_SETTINGS_READ', 'Unable to read settings'); }
  }

  async function selectPane(body) {
    if (!record(body) || typeof body.paneId !== 'string') return invalidBody();
    const paneId = body.paneId.trim();
    if (paneId.length === 0 || paneId.length > MAX_PANE_ID_LENGTH) {
      return errorResponse(400, 'ERR_INVALID_PANE_ID', 'paneId is invalid');
    }
    let snapshot;
    try { snapshot = runtimeSnapshot(store); }
    catch (error) { return publicError(error, 'ERR_RUNTIME_STATE', 'Unable to read runtime state'); }
    const exists = Array.isArray(snapshot?.agents)
      && snapshot.agents.some((agent) => agent?.paneId === paneId);
    if (!exists) return errorResponse(404, 'ERR_PANE_NOT_FOUND', 'Pane was not found');
    try {
      await store.selectPane(paneId);
      const selected = typeof selectTranscript === 'function' ? await selectTranscript(paneId) : null;
      return response(200, selectedTranscript(selected, paneId));
    } catch (error) {
      return publicError(error, 'ERR_TRANSCRIPT_SELECT', 'Unable to select transcript');
    }
  }

  async function mutateSettings(method, body) {
    if (!record(body)) return invalidBody();
    try {
      if (method === 'hod') {
        if (typeof settings.postHod !== 'function' && typeof settings.updateHod !== 'function') throw new Error();
        const handler = settings.postHod ?? settings.updateHod;
        return response(200, await handler(safeSettingsBody(method, body)));
      }
      if (typeof settings.postHerdr !== 'function' && typeof settings.updateHerdr !== 'function') throw new Error();
      const handler = settings.postHerdr ?? settings.updateHerdr;
      return response(200, await handler(safeSettingsBody(method, body)));
    } catch (error) {
      return publicError(error, 'ERR_SETTINGS_UPDATE', 'Unable to update settings');
    }
  }

  async function handle(request, path, body) {
    const input = typeof request === 'string' ? { method: request, path, body } : request;
    const method = methodOf(input);
    const pathname = routePath(input);
    if (method === 'GET' && pathname === '/api/state') return getState();
    if (method === 'GET' && pathname === '/api/settings') return getSettings();
    if (method === 'POST' && pathname === '/api/transcript/select') return selectPane(input?.body);
    if (method === 'POST' && pathname === '/api/settings/hod') return mutateSettings('hod', input?.body);
    if (method === 'POST' && pathname === '/api/settings/herdr') return mutateSettings('herdr', input?.body);
    return null;
  }

  return Object.freeze({ handle, handleRequest: handle, route: handle });
}

export const createApiRoutes = createApiController;
