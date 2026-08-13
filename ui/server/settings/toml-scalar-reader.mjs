import { parseTomlScalar, parseTomlTableHeader, inspectTomlTarget, splitTomlLines, tomlKeyPath } from './toml-scalar-parser.mjs';
import { herdrSettingDefs, publicSettingMetadata, validateSettingValue } from './herdr-setting-definitions.mjs';
import { readConfigSnapshot, AtomicConfigWriteError } from './atomic-config-write.mjs';

export const TOML_SCALAR_READER_ERROR_CODES = Object.freeze({ CONFIG: 'ERR_HERDR_SETTINGS_CONFIG', PARSE: 'ERR_HERDR_SETTINGS_PARSE' });
export class TomlScalarReaderError extends Error {
  constructor(code) { super(code === TOML_SCALAR_READER_ERROR_CODES.PARSE ? 'Herdr config target is unsupported' : 'Herdr config could not be read'); this.name = 'TomlScalarReaderError'; this.code = code; }
}
const fail = (code) => { throw new TomlScalarReaderError(code); };
function same(left, right) { return left.length === right.length && left.every((part, index) => part === right[index]); }
function rejectArrayTable(lines, parts) {
  const table = parts.slice(0, -1); if (!table.length) return;
  for (const line of lines) {
    const match = /^\s*\[\[(.*?)\]\]\s*(?:#.*)?$/.exec(line.text); if (!match) continue;
    const parsed = parseTomlTableHeader(`[${match[1]}]`);
    if (parsed && same(parsed, table)) fail(TOML_SCALAR_READER_ERROR_CODES.PARSE);
  }
}
function decodeScalar(raw, type) {
  if (typeof raw !== 'string') return undefined;
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  if (type === 'integer') {
    if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(raw)) return undefined;
    const value = Number(raw.replaceAll('_', '')); return Number.isSafeInteger(value) ? value : undefined;
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) { try { return JSON.parse(raw); } catch { return undefined; } }
  return undefined;
}
function readValue(toml, key, def) {
  const parts = tomlKeyPath(key); if (!parts) fail(TOML_SCALAR_READER_ERROR_CODES.PARSE);
  const lines = splitTomlLines(toml); rejectArrayTable(lines, parts);
  const target = inspectTomlTarget(lines, parts);
  if (!target.occurrences.length) return { value: def.default, source: 'default' };
  const raw = target.occurrences[0].parsed.value;
  const value = decodeScalar(raw, def.type);
  if (validateSettingValue(key, value) === null) return { value: def.default, source: 'invalid' };
  return { value, source: 'config' };
}
function publicSettings(toml) {
  const defs = herdrSettingDefs(); const metadata = publicSettingMetadata();
  return Object.entries(defs).map(([key, def]) => {
    const current = readValue(toml, key, def);
    return { key, value: current.value, source: current.source, metadata: { ...metadata[key], ...(metadata[key].enum ? { enum: [...metadata[key].enum] } : {}) } };
  });
}
export async function readHerdrConfigState(options = {}) {
  let snapshot;
  try { snapshot = await readConfigSnapshot(options.configPath, { fsApi: options.fsApi }); }
  catch (error) {
    if (error instanceof AtomicConfigWriteError && error.code === 'ERR_HERDR_CONFIG_TOO_LARGE') fail(TOML_SCALAR_READER_ERROR_CODES.CONFIG);
    if (error instanceof AtomicConfigWriteError) fail(TOML_SCALAR_READER_ERROR_CODES.CONFIG);
    fail(TOML_SCALAR_READER_ERROR_CODES.CONFIG);
  }
  try { return { settings: publicSettings(snapshot.bytes.toString('utf8')), snapshot }; }
  catch (error) { if (error instanceof TomlScalarReaderError) throw error; fail(TOML_SCALAR_READER_ERROR_CODES.PARSE); }
}
export async function readHerdrConfigSettings(options = {}) { return (await readHerdrConfigState(options)).settings; }
export const readTomlScalarSettings = readHerdrConfigSettings;
