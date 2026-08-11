import * as nodeFs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

import {
  O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY,
  assertParentStable, assertTargetStable, chmodRegular, inspectLocation, sameIdentity,
} from './config-path-safety.mjs';

export const HERDR_CONFIG_LIMIT_BYTES = 2 * 1024 * 1024;
export const HERDR_CONFIG_OUTPUT_BYTES = 64 * 1024;
export const HERDR_CONFIG_TIMEOUT_MS = 10_000;
export const ATOMIC_CONFIG_ERROR_CODES = Object.freeze({
  PATH: 'ERR_HERDR_CONFIG_PATH', UNSAFE: 'ERR_HERDR_CONFIG_UNSAFE', TOO_LARGE: 'ERR_HERDR_CONFIG_TOO_LARGE',
  IO: 'ERR_HERDR_CONFIG_IO', OUTPUT: 'ERR_HERDR_CONFIG_OUTPUT_LIMIT', TIMEOUT: 'ERR_HERDR_CONFIG_TIMEOUT',
  VALIDATION: 'ERR_HERDR_CONFIG_VALIDATION', CHANGED: 'ERR_HERDR_CONFIG_CHANGED', BACKUP: 'ERR_HERDR_CONFIG_BACKUP',
  RELOAD: 'ERR_HERDR_CONFIG_RELOAD', ROLLBACK: 'ERR_HERDR_CONFIG_ROLLBACK',
});
const MESSAGES = Object.freeze({
  [ATOMIC_CONFIG_ERROR_CODES.PATH]: 'Herdr config path is invalid', [ATOMIC_CONFIG_ERROR_CODES.UNSAFE]: 'Herdr config path is unsafe',
  [ATOMIC_CONFIG_ERROR_CODES.TOO_LARGE]: 'Herdr config exceeds the size limit', [ATOMIC_CONFIG_ERROR_CODES.IO]: 'Herdr config operation failed',
  [ATOMIC_CONFIG_ERROR_CODES.OUTPUT]: 'Herdr config command output exceeded the limit', [ATOMIC_CONFIG_ERROR_CODES.TIMEOUT]: 'Herdr config command timed out',
  [ATOMIC_CONFIG_ERROR_CODES.VALIDATION]: 'Herdr config validation failed', [ATOMIC_CONFIG_ERROR_CODES.CHANGED]: 'Herdr config changed during update',
  [ATOMIC_CONFIG_ERROR_CODES.BACKUP]: 'Herdr config backup failed', [ATOMIC_CONFIG_ERROR_CODES.RELOAD]: 'Herdr config reload failed; changes were rolled back',
  [ATOMIC_CONFIG_ERROR_CODES.ROLLBACK]: 'Herdr config rollback failed',
});
export class AtomicConfigWriteError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES[ATOMIC_CONFIG_ERROR_CODES.IO]); this.name = 'AtomicConfigWriteError'; this.code = code; }
}
const fail = (code) => { throw new AtomicConfigWriteError(code); };

async function safeLocation(configPath, fsApi) {
  try { return await inspectLocation(configPath, fsApi); }
  catch (error) {
    if (error.code === 'ERR_CONFIG_PATH') fail(ATOMIC_CONFIG_ERROR_CODES.PATH);
    if (error.code?.startsWith?.('ERR_CONFIG_')) fail(ATOMIC_CONFIG_ERROR_CODES.UNSAFE);
    fail(ATOMIC_CONFIG_ERROR_CODES.IO);
  }
}

export async function readConfigSnapshot(configPath, { fsApi = nodeFs } = {}) {
  const location = await safeLocation(configPath, fsApi); const before = location.targetStat;
  if (!before) return { exists: false, bytes: Buffer.alloc(0), mode: 0o600, identity: null };
  let handle;
  try {
    handle = await fsApi.open(location.target, O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) fail(ATOMIC_CONFIG_ERROR_CODES.UNSAFE);
    if (opened.size > HERDR_CONFIG_LIMIT_BYTES) fail(ATOMIC_CONFIG_ERROR_CODES.TOO_LARGE);
    const buffer = Buffer.alloc(HERDR_CONFIG_LIMIT_BYTES + 1); let used = 0;
    while (used < buffer.length) { const result = await handle.read(buffer, used, buffer.length - used, null); if (!result.bytesRead) break; used += result.bytesRead; }
    const after = await handle.stat(); await assertParentStable(location, fsApi);
    if (!sameIdentity(opened, after)) fail(ATOMIC_CONFIG_ERROR_CODES.UNSAFE);
    if (used > HERDR_CONFIG_LIMIT_BYTES || after.size > HERDR_CONFIG_LIMIT_BYTES) fail(ATOMIC_CONFIG_ERROR_CODES.TOO_LARGE);
    return { exists: true, bytes: Buffer.from(buffer.subarray(0, used)), mode: opened.mode & 0o7777, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    if (error instanceof AtomicConfigWriteError) throw error;
    if (error.code === 'ELOOP' || error.code?.startsWith?.('ERR_CONFIG_')) fail(ATOMIC_CONFIG_ERROR_CODES.UNSAFE);
    fail(ATOMIC_CONFIG_ERROR_CODES.IO);
  } finally { await handle?.close?.().catch?.(() => {}); }
}

async function writeExclusive(file, content, fsApi) {
  let handle; let opened = false;
  try { handle = await fsApi.open(file, O_WRONLY | O_CREAT | O_EXCL, 0o600); opened = true; await handle.writeFile(content); await handle.sync(); }
  catch (error) { if (opened) await fsApi.unlink(file).catch(() => {}); throw error; }
  finally { await handle?.close?.().catch?.(() => {}); }
}
async function syncDirectory(parent, expected, fsApi) {
  let handle;
  try { handle = await fsApi.open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW); const stat = await handle.stat(); if (!sameIdentity(expected, stat)) fail(ATOMIC_CONFIG_ERROR_CODES.UNSAFE); await handle.sync(); }
  catch (error) { if (error instanceof AtomicConfigWriteError) throw error; fail(ATOMIC_CONFIG_ERROR_CODES.IO); }
  finally { await handle?.close?.().catch?.(() => {}); }
}
async function remove(file, fsApi) { try { await fsApi.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function bytes(value) { return Buffer.isBuffer(value) ? value : Buffer.from(value); }
function sameSnapshot(left, right) {
  return left.exists === right.exists && (!left.exists || (left.bytes.equals(right.bytes)
    && (!left.identity || !right.identity || sameIdentity(left.identity, right.identity))));
}
function outputSize(value) { return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(typeof value === 'string' ? value : ''); }
function commandOptions(env, configPath) {
  return { env: { ...(env || process.env), HERDR_CONFIG_PATH: configPath }, shell: false, timeout: HERDR_CONFIG_TIMEOUT_MS,
    maxBuffer: HERDR_CONFIG_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true };
}
function defaultRunCommand(file, args, options) { return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => error ? (error.stdout = stdout, error.stderr = stderr, reject(error)) : resolve({ stdout, stderr }))); }
async function invoke(runCommand, file, args, options) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(() => runCommand(file, args, options)), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { code: ATOMIC_CONFIG_ERROR_CODES.TIMEOUT })), HERDR_CONFIG_TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
async function command(runCommand, file, args, options, failureCode) {
  try {
    const result = await invoke(runCommand, file, args, options);
    if (outputSize(result?.stdout) + outputSize(result?.stderr) > HERDR_CONFIG_OUTPUT_BYTES) fail(ATOMIC_CONFIG_ERROR_CODES.OUTPUT);
    if ((Number.isInteger(result?.status) && result.status !== 0) || (Number.isInteger(result?.exitCode) && result.exitCode !== 0)) fail(failureCode);
    return result;
  } catch (error) {
    if (error instanceof AtomicConfigWriteError) throw error;
    if (error.code === ATOMIC_CONFIG_ERROR_CODES.TIMEOUT || error.code === 'ETIMEDOUT' || error.timeout || error.killed) fail(ATOMIC_CONFIG_ERROR_CODES.TIMEOUT);
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || outputSize(error?.stdout) + outputSize(error?.stderr) > HERDR_CONFIG_OUTPUT_BYTES) fail(ATOMIC_CONFIG_ERROR_CODES.OUTPUT);
    fail(failureCode);
  }
}
async function artifact(parent, base, suffix, content, fsApi, randomBytes, clock, failureCode) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const stamp = String(await (typeof clock === 'function' ? clock() : clock)).replace(/[^A-Za-z0-9_-]/g, '_'); const random = await randomBytes(12);
    if (!Buffer.isBuffer(random) && !(random instanceof Uint8Array)) fail(ATOMIC_CONFIG_ERROR_CODES.IO);
    const file = join(parent, `.${base}.${suffix}.${stamp}.${Buffer.from(random).toString('hex')}.${attempt}`);
    try { await writeExclusive(file, content, fsApi); return file; } catch (error) { if (error.code === 'EEXIST') continue; fail(failureCode); }
  }
  fail(failureCode);
}

// Node core has no openat/renameat-style directory-FD API. Rechecking the
// parent and target closes ordinary stale-path cases, but a same-user process
// can still swap the parent after the final check; this is an explicit limit.
async function rollback(location, original, replacement, fsApi, randomBytes, clock) {
  await assertParentStable(location, fsApi);
  if (!original.exists) {
    await assertTargetStable(location.target, replacement, fsApi); await remove(location.target, fsApi); await syncDirectory(location.parent, location.parentIdentity, fsApi); return;
  }
  let file;
  try {
    file = await artifact(location.parent, basename(location.target), 'rollback', original.bytes, fsApi, randomBytes, clock, ATOMIC_CONFIG_ERROR_CODES.ROLLBACK);
    await assertParentStable(location, fsApi); await assertTargetStable(location.target, replacement, fsApi);
    await fsApi.rename(file, location.target); file = null;
    const restored = await assertTargetStable(location.target, null, fsApi); await chmodRegular(location.target, restored, original.mode ?? 0o600, fsApi);
    await syncDirectory(location.parent, location.parentIdentity, fsApi);
  } finally { if (file) await remove(file, fsApi).catch(() => {}); }
}

export async function atomicConfigWrite(options = {}) {
  const fsApi = options.fsApi || nodeFs; const location = await safeLocation(options.configPath, fsApi);
  const snapshot = options.snapshot || await readConfigSnapshot(options.configPath, { fsApi }); const nextBytes = bytes(options.nextBytes ?? options.content ?? Buffer.alloc(0));
  if (nextBytes.length > HERDR_CONFIG_LIMIT_BYTES) fail(ATOMIC_CONFIG_ERROR_CODES.TOO_LARGE);
  const runCommand = options.runCommand || defaultRunCommand; const herdrBin = options.herdrBin || 'herdr'; const randomBytes = options.randomBytes || cryptoRandomBytes; const clock = options.clock || Date.now;
  let temp; let replaced = false; let replacement = null; let backupCreated = false;
  try {
    await assertParentStable(location, fsApi); temp = await artifact(location.parent, basename(location.target), 'tmp', nextBytes, fsApi, randomBytes, clock, ATOMIC_CONFIG_ERROR_CODES.IO);
    await assertParentStable(location, fsApi); await command(runCommand, herdrBin, ['config', 'check'], commandOptions(options.env, temp), ATOMIC_CONFIG_ERROR_CODES.VALIDATION);
    await assertParentStable(location, fsApi);
    const current = await readConfigSnapshot(location.target, { fsApi });
    if (!sameSnapshot(snapshot, current)) fail(ATOMIC_CONFIG_ERROR_CODES.CHANGED);
    await assertParentStable(location, fsApi);
    if (snapshot.exists) { await artifact(location.parent, basename(location.target), 'bak', snapshot.bytes, fsApi, randomBytes, clock, ATOMIC_CONFIG_ERROR_CODES.BACKUP); backupCreated = true; }
    const targetBeforeRename = await assertTargetStable(location.target, snapshot.identity ?? null, fsApi, !snapshot.exists);
    if (!snapshot.exists && targetBeforeRename) fail(ATOMIC_CONFIG_ERROR_CODES.CHANGED);
    await assertParentStable(location, fsApi); await fsApi.rename(temp, location.target); temp = null; replaced = true;
    replacement = await assertTargetStable(location.target, null, fsApi); await chmodRegular(location.target, replacement, snapshot.exists ? (snapshot.mode ?? 0o600) : 0o600);
    await syncDirectory(location.parent, location.parentIdentity, fsApi);
  } catch (error) {
    if (replaced) { try { await rollback(location, snapshot, replacement, fsApi, randomBytes, clock); } catch { fail(ATOMIC_CONFIG_ERROR_CODES.ROLLBACK); } }
    if (error instanceof AtomicConfigWriteError) throw error;
    if (error.code?.startsWith?.('ERR_CONFIG_')) fail(ATOMIC_CONFIG_ERROR_CODES.CHANGED);
    fail(ATOMIC_CONFIG_ERROR_CODES.IO);
  } finally { if (temp) await remove(temp, fsApi).catch(() => {}); }
  try {
    await command(runCommand, herdrBin, ['server', 'reload-config'], commandOptions(options.env, location.target), ATOMIC_CONFIG_ERROR_CODES.RELOAD);
  } catch (error) {
    try { await rollback(location, snapshot, replacement, fsApi, randomBytes, clock); } catch { fail(ATOMIC_CONFIG_ERROR_CODES.ROLLBACK); }
    await command(runCommand, herdrBin, ['server', 'reload-config'], commandOptions(options.env, location.target), ATOMIC_CONFIG_ERROR_CODES.RELOAD).catch(() => {});
    fail(ATOMIC_CONFIG_ERROR_CODES.RELOAD);
  }
  return { backupCreated };
}

export const writeConfigAtomically = atomicConfigWrite;
