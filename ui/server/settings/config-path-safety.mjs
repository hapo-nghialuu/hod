import { constants as fsConstants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const { O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 64, O_EXCL = 128,
  O_NOFOLLOW = 0, O_DIRECTORY = 0 } = fsConstants;

function failure(code) { return Object.assign(new Error(code), { code }); }

export function sameIdentity(left, right) {
  return left?.dev !== undefined && left?.ino !== undefined
    && left.dev === right?.dev && left.ino === right?.ino;
}

function owned(stats, parent = false) {
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== undefined && stats.uid !== uid) throw failure('ERR_CONFIG_OWNER');
  if (parent && (stats.mode & 0o022) !== 0) throw failure('ERR_CONFIG_PARENT_MODE');
}

async function listed(fsApi, path, allowMissing = false) {
  try { return await fsApi.lstat(path); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
}

export async function inspectLocation(configPath, fsApi = defaultFs) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath) || configPath.includes('\0')) throw failure('ERR_CONFIG_PATH');
  const target = resolve(configPath); const parent = dirname(target);
  const parentStat = await listed(fsApi, parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw failure('ERR_CONFIG_UNSAFE');
  owned(parentStat, true);
  const targetStat = await listed(fsApi, target, true);
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) throw failure('ERR_CONFIG_UNSAFE');
  if (targetStat) owned(targetStat);
  return { target, parent, parentIdentity: { dev: parentStat.dev, ino: parentStat.ino }, targetStat };
}

export async function assertParentStable(location, fsApi = defaultFs) {
  const current = await listed(fsApi, location.parent);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(location.parentIdentity, current)) {
    throw failure('ERR_CONFIG_PARENT_CHANGED');
  }
  owned(current, true);
  return current;
}

export async function assertTargetStable(target, expected, fsApi = defaultFs, allowMissing = false) {
  const current = await listed(fsApi, target, allowMissing);
  if (!current) {
    if (expected !== null) throw failure('ERR_CONFIG_TARGET_CHANGED');
    return null;
  }
  if (current.isSymbolicLink() || !current.isFile()) throw failure('ERR_CONFIG_TARGET_CHANGED');
  owned(current);
  if (expected !== null && !sameIdentity(expected, current)) throw failure('ERR_CONFIG_TARGET_CHANGED');
  return current;
}

export async function chmodRegular(target, expected, mode, fsApi = defaultFs) {
  const handle = await fsApi.open(target, O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(expected, opened)) throw failure('ERR_CONFIG_TARGET_CHANGED');
    await handle.chmod(mode);
  } finally { await handle.close().catch(() => {}); }
}
