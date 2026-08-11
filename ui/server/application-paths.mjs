import { lstatSync as nodeLstatSync, realpathSync as nodeRealpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_CODES = Object.freeze({
  PROJECT: 'ERR_PROJECT_PATH', PUBLIC: 'ERR_PUBLIC_ROOT', TEMPLATES: 'ERR_TEMPLATES_ROOT',
  CONFIG: 'ERR_CONFIG_PATH', HOD: 'ERR_HOD_BIN',
});
const MESSAGES = Object.freeze({
  [SAFE_CODES.PROJECT]: 'Project directory is unavailable',
  [SAFE_CODES.PUBLIC]: 'Public assets are unavailable',
  [SAFE_CODES.TEMPLATES]: 'Templates are unavailable',
  [SAFE_CODES.CONFIG]: 'Herdr config path is invalid',
  [SAFE_CODES.HOD]: 'HOD executable is unavailable',
});

export class ApplicationPathError extends Error {
  constructor(code, message = MESSAGES[code] ?? 'Application path is invalid') {
    super(message); this.name = 'ApplicationPathError'; this.code = code;
  }
}

function fail(code) { throw new ApplicationPathError(code); }
function fsMethod(fsApi, name, fallback) { return (fsApi?.[name] ?? fallback).bind(fsApi ?? null); }
function missing(error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; }
function absolute(value, code) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) fail(code);
  return resolve(value);
}

function assertNoSymlinkComponents(path, lstat, code) {
  for (const candidate of [dirname(path), path]) {
    let stats;
    try { stats = lstat(candidate); } catch { fail(code); }
    if (stats.isSymbolicLink?.()) fail(code);
  }
}

function canonicalDirectory(path, code, fsApi, rejectSymlinks) {
  const lstat = fsMethod(fsApi, 'lstatSync', nodeLstatSync);
  const realpath = fsMethod(fsApi, 'realpathSync', nodeRealpathSync);
  const absolutePath = absolute(path, code);
  if (rejectSymlinks) assertNoSymlinkComponents(absolutePath, lstat, code);
  let canonical;
  try { canonical = realpath(absolutePath); } catch { fail(code); }
  let stats;
  try { stats = lstat(canonical); } catch { fail(code); }
  if (!stats.isDirectory?.()) fail(code);
  return canonical;
}

function validateOptionalConfig(path, fsApi) {
  const lstat = fsMethod(fsApi, 'lstatSync', nodeLstatSync);
  try {
    const stats = lstat(path);
    if (stats.isSymbolicLink?.() || !stats.isFile?.()) fail(SAFE_CODES.CONFIG);
  } catch (error) {
    if (!missing(error)) fail(SAFE_CODES.CONFIG);
  }
}

function configPath(env, fsApi) {
  const explicit = env?.HERDR_CONFIG_PATH;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = absolute(explicit, SAFE_CODES.CONFIG);
    validateOptionalConfig(path, fsApi);
    return path;
  }
  const xdg = typeof env?.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() !== ''
    ? absolute(env.XDG_CONFIG_HOME, SAFE_CODES.CONFIG) : null;
  const home = typeof env?.HOME === 'string' && env.HOME.trim() !== ''
    ? absolute(env.HOME, SAFE_CODES.CONFIG) : null;
  if (!xdg && !home) fail(SAFE_CODES.CONFIG);
  const path = join(xdg ?? join(home, '.config'), 'herdr', 'config.toml');
  validateOptionalConfig(path, fsApi);
  return path;
}

/** Resolve and validate only metadata; config bytes are never read here. */
export function resolveApplicationPaths(options = {}) {
  const fsApi = options.fsApi ?? null;
  const entryFile = options.entryFile ?? fileURLToPath(import.meta.url);
  const entryDirectory = dirname(absolute(entryFile, SAFE_CODES.PUBLIC));
  const repositoryRoot = dirname(entryDirectory);
  const projectRoot = canonicalDirectory(options.project ?? options.cwd ?? process.cwd(), SAFE_CODES.PROJECT, fsApi, false);
  const publicRoot = canonicalDirectory(join(entryDirectory, 'public'), SAFE_CODES.PUBLIC, fsApi, true);
  const templatesRoot = canonicalDirectory(join(repositoryRoot, 'templates'), SAFE_CODES.TEMPLATES, fsApi, true);
  const hodBin = options.hodBin !== undefined ? options.hodBin
    : options.directSourceInvocation === true ? join(repositoryRoot, 'bin', 'hod') : undefined;
  if (hodBin !== undefined && (typeof hodBin !== 'string' || hodBin.trim() === '')) fail(SAFE_CODES.HOD);
  return Object.freeze({
    repositoryRoot, projectRoot, publicRoot, templatesRoot,
    configPath: configPath(options.env ?? process.env, fsApi), hodBin,
    herdrBin: options.herdrBin ?? options.env?.HERDR_BIN ?? 'herdr',
  });
}

export const deriveApplicationPaths = resolveApplicationPaths;
