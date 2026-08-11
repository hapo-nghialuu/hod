import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';

export const HOD_ROLE_SETTINGS_LIMIT_BYTES = 64 * 1024;
export const HOD_ROLE_SETTINGS_ERROR_CODES = Object.freeze({
  CONFIG: 'ERR_HOD_SETTINGS_CONFIG', UNKNOWN_ROLE: 'ERR_HOD_SETTINGS_UNKNOWN_ROLE',
  CONFIRMATION: 'ERR_HOD_SETTINGS_CONFIRMATION', FORCE_REQUIRED: 'ERR_HOD_SETTINGS_FORCE_REQUIRED',
  UNSAFE: 'ERR_HOD_SETTINGS_UNSAFE_DESTINATION', TEMPLATE: 'ERR_HOD_SETTINGS_TEMPLATE',
  IO: 'ERR_HOD_SETTINGS_IO', TIMEOUT: 'ERR_HOD_SETTINGS_TIMEOUT',
  OUTPUT_LIMIT: 'ERR_HOD_SETTINGS_OUTPUT_LIMIT', ENGINE: 'ERR_HOD_SETTINGS_ENGINE',
  POSTCONDITION: 'ERR_HOD_SETTINGS_POSTCONDITION',
});

export class HodRoleSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HodRoleSettingsError'; this.code = code;
  }
}

const { O_RDONLY = 0, O_NOFOLLOW = 0 } = fsConstants;
function fail(code, message) { throw new HodRoleSettingsError(code, message); }
function unsafe(role) { return { role, status: 'different', unsafe: true }; }
function missing(role) { return { role, status: 'missing', unsafe: false }; }
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export async function canonicalDirectory(path, code, fsApi = nodeFs) {
  try {
    const canonical = await fsApi.realpath(path);
    const stats = await fsApi.lstat(canonical);
    if (!stats.isDirectory()) fail(code, 'HOD settings directory is invalid');
    return canonical;
  } catch (error) {
    if (error instanceof HodRoleSettingsError) throw error;
    fail(code, 'HOD settings directory is unavailable');
  }
}

export async function readCappedRegularFile(path, code = HOD_ROLE_SETTINGS_ERROR_CODES.IO, fsApi = nodeFs) {
  let handle;
  try {
    const before = await fsApi.lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) fail(code, 'HOD settings file is unsafe');
    handle = await fsApi.open(path, O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) fail(code, 'HOD settings file is unsafe');
    if (opened.size > HOD_ROLE_SETTINGS_LIMIT_BYTES) return { tooLarge: true };
    const bytes = Buffer.allocUnsafe(HOD_ROLE_SETTINGS_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > HOD_ROLE_SETTINGS_LIMIT_BYTES) return { tooLarge: true };
    return { bytes: bytes.subarray(0, offset) };
  } catch (error) {
    if (error instanceof HodRoleSettingsError) throw error;
    fail(code, 'HOD settings file is unavailable');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function readExpectedDigests(root, roles, fsApi = nodeFs) {
  const expected = new Map();
  for (const role of roles) {
    const result = await readCappedRegularFile(join(root, `settings-${role}.json`), HOD_ROLE_SETTINGS_ERROR_CODES.TEMPLATE, fsApi);
    if (result.tooLarge) fail(HOD_ROLE_SETTINGS_ERROR_CODES.TEMPLATE, 'HOD settings template exceeds the limit');
    expected.set(role, digest(result.bytes));
  }
  return expected;
}

export async function inspectDestination(project, role, expectedDigest, fsApi = nodeFs) {
  const parent = join(project, '.claude');
  try {
    const parentStats = await fsApi.lstat(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) return unsafe(role);
  } catch (error) {
    if (error.code === 'ENOENT') return missing(role);
    fail(HOD_ROLE_SETTINGS_ERROR_CODES.IO, 'HOD settings destination is unavailable');
  }
  const destination = join(parent, `settings.${role}.json`);
  let stats;
  try {
    stats = await fsApi.lstat(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return missing(role);
    fail(HOD_ROLE_SETTINGS_ERROR_CODES.IO, 'HOD settings destination is unavailable');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return unsafe(role);
  try {
    const actual = await readCappedRegularFile(destination, HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE, fsApi);
    const matches = !actual.tooLarge && digest(actual.bytes) === expectedDigest;
    return { role, status: matches ? 'matches' : 'different', unsafe: false };
  } catch (error) {
    if (error.code === HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE) return unsafe(role);
    throw error;
  }
}
