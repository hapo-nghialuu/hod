import { execFile } from 'node:child_process';
import {
  canonicalDirectory, HodRoleSettingsError, HOD_ROLE_SETTINGS_ERROR_CODES,
  inspectDestination, readExpectedDigests,
} from './hod-role-inspector.mjs';

export { HodRoleSettingsError, HOD_ROLE_SETTINGS_ERROR_CODES } from './hod-role-inspector.mjs';
export const HOD_ROLES = Object.freeze(['controller', 'impl', 'reviewer']);
export const HOD_ROLE_SETTINGS_TIMEOUT_MS = 10_000;
export const HOD_ROLE_SETTINGS_OUTPUT_BYTES = 64 * 1024;

const INSTALL_CONFIRMATION = 'INSTALL HOD ROLE';
const OVERWRITE_CONFIRMATION = 'OVERWRITE HOD ROLE';
function fail(code, message) { throw new HodRoleSettingsError(code, message); }
function assertString(value, code = HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, 'HOD settings options are invalid');
  return value;
}
function assertRole(role) {
  if (!HOD_ROLES.includes(role)) fail(HOD_ROLE_SETTINGS_ERROR_CODES.UNKNOWN_ROLE, 'Unknown HOD role');
}
function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(typeof value === 'string' ? value : '');
}
function outputTooLarge(result) {
  return result && typeof result === 'object'
    && byteLength(result.stdout) + byteLength(result.stderr) > HOD_ROLE_SETTINGS_OUTPUT_BYTES;
}
function commandFailure(error) {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || outputTooLarge(error)) {
    return [HOD_ROLE_SETTINGS_ERROR_CODES.OUTPUT_LIMIT, 'HOD settings command output exceeded the limit'];
  }
  if (error?.timeout === true || error?.killed === true || error?.code === 'ETIMEDOUT') {
    return [HOD_ROLE_SETTINGS_ERROR_CODES.TIMEOUT, 'HOD settings command timed out'];
  }
  return [HOD_ROLE_SETTINGS_ERROR_CODES.ENGINE, 'HOD settings command failed'];
}
function defaultRunCommand(file, args, options) {
  return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
    resolve({ stdout, stderr });
  }));
}
async function invokeCommand(runCommand, file, args, options) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => runCommand(file, args, options)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new Error('HOD settings command timed out'); error.code = 'ETIMEDOUT'; error.timeout = true; reject(error); }, HOD_ROLE_SETTINGS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHodRoleSettings(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail(HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG, 'HOD settings options are invalid');
  const projectRoot = assertString(options.projectRoot);
  const templatesRoot = assertString(options.templatesRoot);
  const hodBin = assertString(options.hodBin);
  const runCommand = options.runCommand ?? defaultRunCommand;
  if (typeof runCommand !== 'function') fail(HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG, 'HOD settings options are invalid');

  async function list() {
    const project = await canonicalDirectory(projectRoot, HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG);
    const templates = await canonicalDirectory(templatesRoot, HOD_ROLE_SETTINGS_ERROR_CODES.TEMPLATE);
    const expected = await readExpectedDigests(templates, HOD_ROLES);
    return Promise.all(HOD_ROLES.map((role) => inspectDestination(project, role, expected.get(role))));
  }

  async function install(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail(HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG, 'HOD settings request is invalid');
    const { role, force = false, confirmation } = request;
    assertRole(role);
    if (typeof force !== 'boolean') fail(HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG, 'force must be a boolean');
    const current = (await list()).find((item) => item.role === role);
    if (!current) fail(HOD_ROLE_SETTINGS_ERROR_CODES.IO, 'HOD settings role is unavailable');
    if (current.unsafe) fail(HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE, 'HOD settings destination is unsafe');
    if (current.status === 'matches' && !force) return current;
    if (current.status === 'different' && !force) fail(HOD_ROLE_SETTINGS_ERROR_CODES.FORCE_REQUIRED, 'Overwrite requires force');
    const expected = force ? OVERWRITE_CONFIRMATION : INSTALL_CONFIRMATION;
    if (confirmation !== expected) fail(HOD_ROLE_SETTINGS_ERROR_CODES.CONFIRMATION, 'Confirmation token is invalid');

    const project = await canonicalDirectory(projectRoot, HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG);
    const args = ['settings', 'install', '--project', project, '--role', role];
    if (force) args.push('--force');
    try {
      const result = await invokeCommand(runCommand, hodBin, args, {
        shell: false, timeout: HOD_ROLE_SETTINGS_TIMEOUT_MS,
        maxBuffer: HOD_ROLE_SETTINGS_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true,
      });
      if (outputTooLarge(result) || result?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        fail(HOD_ROLE_SETTINGS_ERROR_CODES.OUTPUT_LIMIT, 'HOD settings command output exceeded the limit');
      }
      if (Number.isInteger(result?.status) && result.status !== 0) fail(HOD_ROLE_SETTINGS_ERROR_CODES.ENGINE, 'HOD settings command failed');
    } catch (error) {
      if (error instanceof HodRoleSettingsError) throw error;
      const [code, message] = commandFailure(error);
      fail(code, message);
    }

    const after = (await list()).find((item) => item.role === role);
    if (!after || after.status !== 'matches' || after.unsafe) fail(HOD_ROLE_SETTINGS_ERROR_CODES.POSTCONDITION, 'HOD settings postcondition failed');
    return after;
  }
  return Object.freeze({ list, install });
}
