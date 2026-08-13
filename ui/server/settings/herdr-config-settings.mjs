import { isAbsolute } from 'node:path';
import { patchTomlScalar } from './toml-scalar-patcher.mjs';
import { herdrSettingDefs, publicSettingMetadata, serializeSettingValue, validateSettingValue } from './herdr-setting-definitions.mjs';
import { readHerdrConfigSettings, readHerdrConfigState, TomlScalarReaderError } from './toml-scalar-reader.mjs';
import { atomicConfigWrite, AtomicConfigWriteError } from './atomic-config-write.mjs';

export const HERDR_CONFIG_SETTINGS_ERROR_CODES = Object.freeze({
  CONFIG: 'ERR_HERDR_SETTINGS_CONFIG', KEY: 'ERR_HERDR_SETTINGS_KEY', VALUE: 'ERR_HERDR_SETTINGS_VALUE',
  CONFIRMATION: 'ERR_HERDR_SETTINGS_CONFIRMATION', PARSE: 'ERR_HERDR_SETTINGS_PARSE', IO: 'ERR_HERDR_SETTINGS_IO',
});
const MESSAGES = Object.freeze({
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIG]: 'Herdr settings options are invalid',
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.KEY]: 'Herdr setting key is not allowed',
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.VALUE]: 'Herdr setting value is invalid',
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIRMATION]: 'Herdr setting confirmation is invalid',
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.PARSE]: 'Herdr config target is unsupported',
  [HERDR_CONFIG_SETTINGS_ERROR_CODES.IO]: 'Herdr settings operation failed',
});
export class HerdrConfigSettingsError extends Error {
  constructor(code, message = MESSAGES[code] || MESSAGES[HERDR_CONFIG_SETTINGS_ERROR_CODES.IO]) { super(message); this.name = 'HerdrConfigSettingsError'; this.code = code; }
}
const fail = (code) => { throw new HerdrConfigSettingsError(code); };
function safeError(error) {
  if (error instanceof HerdrConfigSettingsError) return error;
  if (error instanceof TomlScalarReaderError) return new HerdrConfigSettingsError(error.code === 'ERR_HERDR_SETTINGS_PARSE' ? HERDR_CONFIG_SETTINGS_ERROR_CODES.PARSE : HERDR_CONFIG_SETTINGS_ERROR_CODES.IO);
  if (error instanceof AtomicConfigWriteError) return new HerdrConfigSettingsError(error.code, error.message);
  return new HerdrConfigSettingsError(HERDR_CONFIG_SETTINGS_ERROR_CODES.IO);
}
function cloneSetting(key, value, source = 'config') {
  const metadata = publicSettingMetadata()[key];
  return { key, value, source, metadata: { ...metadata, ...(metadata.enum ? { enum: [...metadata.enum] } : {}) } };
}
export function createHerdrConfigSettings(options = {}) {
  const configPath = options.configPath;
  if (typeof configPath !== 'string' || !isAbsolute(configPath) || configPath.includes('\0')) fail(HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIG);
  if (options.runCommand !== undefined && typeof options.runCommand !== 'function') fail(HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIG);
  const common = { configPath, fsApi: options.fsApi, herdrBin: options.herdrBin, runCommand: options.runCommand, randomBytes: options.randomBytes, clock: options.clock, env: options.env };
  let mutationQueue = Promise.resolve();
  function enqueue(operation) { const result = mutationQueue.then(operation); mutationQueue = result.catch(() => {}); return result; }
  async function list() { try { return await readHerdrConfigSettings(common); } catch (error) { throw safeError(error); } }
  function update(input = {}) {
    return enqueue(async () => {
      if (input.confirmation !== 'APPLY HERDR SETTING') fail(HERDR_CONFIG_SETTINGS_ERROR_CODES.CONFIRMATION);
      const defs = herdrSettingDefs(); const def = defs[input.key];
      if (!def) fail(HERDR_CONFIG_SETTINGS_ERROR_CODES.KEY);
      const value = validateSettingValue(input.key, input.value);
      if (value === null) fail(HERDR_CONFIG_SETTINGS_ERROR_CODES.VALUE);
      let state; let nextToml;
      try {
        state = await readHerdrConfigState(common);
        nextToml = patchTomlScalar({ toml: state.snapshot.bytes.toString('utf8'), key: input.key, literal: serializeSettingValue(def, value) });
      } catch (error) { throw safeError(error); }
      try {
        const result = await atomicConfigWrite({ ...common, snapshot: state.snapshot, nextBytes: Buffer.from(nextToml) });
        return { setting: cloneSetting(input.key, value), backupCreated: result.backupCreated, restartRequired: def.restart };
      } catch (error) { throw safeError(error); }
    });
  }
  return Object.freeze({ list, update });
}
