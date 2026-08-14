import { HOD_ROLES } from './hod-role-settings.mjs';
import { HERDR_CONFIG_SETTINGS_ERROR_CODES } from './herdr-config-settings.mjs';
import {
  isAllowlistedSetting,
  publicSettingMetadata,
  validateSettingValue,
} from './herdr-setting-definitions.mjs';
import { HOD_ROLE_SETTINGS_ERROR_CODES } from './hod-role-inspector.mjs';

export const SETTINGS_CONFIRMATIONS = Object.freeze({
  install: 'INSTALL HOD ROLE',
  overwrite: 'OVERWRITE HOD ROLE',
  herdr: 'APPLY HERDR SETTING',
});

export class SettingsControllerError extends Error {
  constructor(code, message = 'Settings request is invalid') {
    super(message);
    this.name = 'SettingsControllerError';
    this.code = code;
  }
}

const ROLE_STATUSES = new Set(['missing', 'matches', 'different']);
const PUBLIC_SOURCES = new Set(['config', 'default', 'invalid', 'env', 'file', 'fallback', 'herdr', 'runtime', 'system', 'cli']);
const HOD_CODES = HOD_ROLE_SETTINGS_ERROR_CODES;
const HERDR_CODES = HERDR_CONFIG_SETTINGS_ERROR_CODES;
const SAFE_SERVICE_CODES = new Set([
  ...Object.values(HOD_CODES), ...Object.values(HERDR_CODES),
  'ERR_HERDR_CONFIG_CHANGED', 'ERR_HERDR_CONFIG_UNSAFE', 'ERR_HERDR_CONFIG_RELOAD',
  'ERR_HERDR_CONFIG_ROLLBACK', 'ERR_SETTINGS_RESPONSE',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  throw new SettingsControllerError(code, message);
}

function safeServiceError(error) {
  const code = SAFE_SERVICE_CODES.has(error?.code) ? error.code : 'ERR_SETTINGS_OPERATION';
  return new SettingsControllerError(code, 'Settings operation failed');
}

function metadataFor(key) {
  const metadata = publicSettingMetadata()[key];
  return { ...metadata, ...(Array.isArray(metadata.enum) ? { enum: [...metadata.enum] } : {}) };
}

function publicRole(item, fallbackRole = null) {
  const role = HOD_ROLES.includes(item?.role) ? item.role : fallbackRole;
  const status = ROLE_STATUSES.has(item?.status) ? item.status : 'missing';
  if (!role) return null;
  return { role, status, unsafe: item?.unsafe === true };
}

function publicSetting(item, fallback = {}) {
  const key = item?.key ?? fallback.key;
  if (!isAllowlistedSetting(key)) return null;
  const value = validateSettingValue(key, item?.value ?? fallback.value);
  if (value === null) return null;
  const source = PUBLIC_SOURCES.has(item?.source) ? item.source : (fallback.source ?? 'config');
  return { key, value, source, metadata: metadataFor(key) };
}

function parseHod(body) {
  if (!record(body) || typeof body.role !== 'string' || body.role.trim() === ''
    || typeof body.force !== 'boolean' || typeof body.confirmation !== 'string') {
    fail(HOD_CODES.CONFIG, 'HOD settings request is invalid');
  }
  const expected = body.force ? SETTINGS_CONFIRMATIONS.overwrite : SETTINGS_CONFIRMATIONS.install;
  if (body.confirmation !== expected) fail(HOD_CODES.CONFIRMATION, 'Confirmation token is invalid');
  return { role: body.role, force: body.force, confirmation: body.confirmation };
}

function parseHerdr(body) {
  if (!record(body) || typeof body.key !== 'string' || body.key.trim() === ''
    || typeof body.confirmation !== 'string') {
    fail(HERDR_CODES.CONFIG, 'Herdr settings request is invalid');
  }
  if (!isAllowlistedSetting(body.key)) fail(HERDR_CODES.KEY, 'Herdr setting key is not allowed');
  if (validateSettingValue(body.key, body.value) === null) {
    fail(HERDR_CODES.VALUE, 'Herdr setting value is invalid');
  }
  if (body.confirmation !== SETTINGS_CONFIRMATIONS.herdr) {
    fail(HERDR_CODES.CONFIRMATION, 'Herdr setting confirmation is invalid');
  }
  return { key: body.key, value: body.value, confirmation: body.confirmation };
}

export function createSettingsController(options = {}) {
  const hod = options.hodRoleSettings ?? options.hodSettings ?? options.hod;
  const herdr = options.herdrConfigSettings ?? options.herdrSettings ?? options.herdr;
  if (typeof hod?.list !== 'function' || typeof hod?.install !== 'function') {
    throw new TypeError('hod role settings service is required');
  }
  if (typeof herdr?.list !== 'function' || typeof herdr?.update !== 'function') {
    throw new TypeError('herdr config settings service is required');
  }

  let mutationQueue = Promise.resolve();
  function serializeMutation(operation) {
    const result = mutationQueue.then(operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  async function getSettings() {
    let roles;
    let settings;
    try {
      [roles, settings] = await Promise.all([hod.list(), herdr.list()]);
    } catch (error) {
      throw safeServiceError(error);
    }
    if (!Array.isArray(roles) || !Array.isArray(settings)) {
      throw new SettingsControllerError('ERR_SETTINGS_RESPONSE', 'Settings service response is invalid');
    }
    return {
      hod: { roles: roles.map((item) => publicRole(item)).filter(Boolean) },
      herdr: { settings: settings.map((item) => publicSetting(item)).filter(Boolean) },
    };
  }

  function updateHod(body) {
    return serializeMutation(async () => {
      const input = parseHod(body);
      let result;
      try { result = await hod.install(input); } catch (error) { throw safeServiceError(error); }
      return publicRole(result, input.role) ?? publicRole({ role: input.role });
    });
  }

  function updateHerdr(body) {
    return serializeMutation(async () => {
      const input = parseHerdr(body);
      let result;
      try { result = await herdr.update(input); } catch (error) { throw safeServiceError(error); }
      const setting = publicSetting(result?.setting, { key: input.key, value: input.value });
      if (!setting) throw new SettingsControllerError('ERR_SETTINGS_RESPONSE', 'Settings service response is invalid');
      return {
        setting,
        backupCreated: result?.backupCreated === true,
        restartRequired: result?.restartRequired === true,
      };
    });
  }

  return Object.freeze({
    get: getSettings,
    getSettings,
    postHod: updateHod,
    updateHod,
    postHerdr: updateHerdr,
    updateHerdr,
  });
}

export const createSettingsRoutes = createSettingsController;
