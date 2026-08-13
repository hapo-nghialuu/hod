import { statSync } from 'node:fs';

// Option contract for `hod ui`. The launcher passes argv (after the `ui`
// subcommand) straight here; every parse error is a usage error (exit 2) in
// the caller, and structured errors never embed user input.

export const DEFAULT_PORT = 0;
export const MIN_PORT = 0;
export const MAX_PORT = 65535;

function portError(value) {
  const err = new Error(`--port must be an integer in ${MIN_PORT}..${MAX_PORT}: ${value}`);
  err.code = 'ERR_USAGE';
  return err;
}

function existingDirError(value) {
  const err = new Error(`--project path is not an existing directory: ${value}`);
  err.code = 'ERR_USAGE';
  return err;
}

function duplicateFlagError(flag) {
  const err = new Error(`duplicate option: ${flag}`);
  err.code = 'ERR_USAGE';
  return err;
}

function unknownFlagError(flag) {
  const err = new Error(`unknown option: ${flag}`);
  err.code = 'ERR_USAGE';
  return err;
}

function missingValueError(flag) {
  const err = new Error(`${flag} requires a value`);
  err.code = 'ERR_USAGE';
  return err;
}

function runtimeOnlyProjectError() {
  const err = new Error('--project is not supported in runtime-only mode');
  err.code = 'ERR_USAGE';
  return err;
}

// Ensure a path is a directory. Realpath-free on purpose: the launcher is the
// single place that canonicalizes, so tests can pass a fake tree.
function assertExistingDirectory(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw existingDirError(path);
  }
  if (!st.isDirectory()) {
    throw existingDirError(path);
  }
  return path;
}

/**
 * Parse runtime options for `hod ui`.
 *
 * @param {string[]} argv arguments after `ui` (may be empty)
 * @param {object} [env] process.env-like lookup for HOD_BIN defaults
 * @returns {{project?: string, port: number, open: boolean, hodBin?: string}}
 * @throws {Error} with code 'ERR_USAGE' on any invalid input
 */
export function parseRuntimeOptions(argv = [], env = {}) {
  const seen = new Set();
  const runtimeOnly = argv.includes('--runtime-only');
  let project;
  let port = DEFAULT_PORT;
  let open = true;
  let hodBin;
  let i = 0;

  const takeValue = (flag) => {
    const value = argv[i + 1];
    if (i + 1 >= argv.length || typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw missingValueError(flag);
    }
    i += 1;
    return value;
  };

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--runtime-only') {
      if (seen.has('--runtime-only')) throw duplicateFlagError('--runtime-only');
      seen.add('--runtime-only');
    } else if (arg === '--project') {
      if (runtimeOnly) throw runtimeOnlyProjectError();
      if (seen.has('--project')) throw duplicateFlagError('--project');
      seen.add('--project');
      project = takeValue('--project');
      assertExistingDirectory(project);
    } else if (arg === '--port') {
      if (seen.has('--port')) throw duplicateFlagError('--port');
      seen.add('--port');
      const raw = takeValue('--port');
      if (!/^[0-9]{1,5}$/.test(raw)) throw portError(raw);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw portError(raw);
      }
      port = parsed;
    } else if (arg === '--no-open') {
      if (seen.has('--no-open')) throw duplicateFlagError('--no-open');
      seen.add('--no-open');
      open = false;
    } else if (arg === '--hod-bin') {
      if (seen.has('--hod-bin')) throw duplicateFlagError('--hod-bin');
      seen.add('--hod-bin');
      hodBin = takeValue('--hod-bin');
    } else {
      throw unknownFlagError(arg);
    }
    i += 1;
  }

  if (hodBin === undefined && typeof env.HOD_BIN === 'string' && env.HOD_BIN !== '') {
    hodBin = env.HOD_BIN;
  }

  return runtimeOnly ? { project, port, open, hodBin, runtimeOnly: true }
    : { project, port, open, hodBin };
}
