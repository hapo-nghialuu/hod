import { execFile as nodeExecFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const EXPECTED_HERDR_PROTOCOL = 19;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;
export const DEFAULT_DISCOVERY_OUTPUT_BYTES = 64 * 1024;
export const DISCOVERY_ERROR_CODES = Object.freeze({
  CONFIG: 'ERR_DISCOVERY_CONFIG',
  INVALID_STATUS: 'ERR_DISCOVERY_STATUS',
  SOCKET: 'ERR_DISCOVERY_SOCKET',
  UNAVAILABLE: 'ERR_HERDR_UNAVAILABLE',
  TIMEOUT: 'ERR_HERDR_TIMEOUT',
  OUTPUT_LIMIT: 'ERR_HERDR_OUTPUT_LIMIT',
  NOT_RUNNING: 'ERR_HERDR_NOT_RUNNING',
  INCOMPATIBLE: 'ERR_HERDR_INCOMPATIBLE',
});

export class HerdrDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrDiscoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HerdrDiscoveryError(code, message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateSocket(value) {
  if (!nonEmptyString(value) || !isAbsolute(value.trim())) {
    fail(DISCOVERY_ERROR_CODES.SOCKET, 'Herdr socket path must be absolute and non-empty');
  }
  return value.trim();
}

function validateStatus(status, expectedProtocol) {
  if (!record(status)) fail(DISCOVERY_ERROR_CODES.INVALID_STATUS, 'Herdr status response is invalid');
  if (status.running !== true) fail(DISCOVERY_ERROR_CODES.NOT_RUNNING, 'Herdr server is not running');
  if (status.compatible !== true) fail(DISCOVERY_ERROR_CODES.INCOMPATIBLE, 'Herdr server is incompatible');

  const protocol = status.protocol;
  if (!Number.isSafeInteger(protocol) || protocol < 0) {
    fail(DISCOVERY_ERROR_CODES.INVALID_STATUS, 'Herdr status response is invalid');
  }
  if (expectedProtocol !== null && protocol !== expectedProtocol) {
    fail(DISCOVERY_ERROR_CODES.INCOMPATIBLE, 'Herdr server is incompatible');
  }
  if (!nonEmptyString(status.version)) {
    fail(DISCOVERY_ERROR_CODES.INVALID_STATUS, 'Herdr status response is invalid');
  }

  const socket = status.socket_path ?? status.socketPath ?? status.socket;
  return {
    socketPath: validateSocket(socket),
    version: status.version.trim(),
    protocol,
    source: 'status',
  };
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value ?? ''));
}

function invokeExecFile(execFile, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, { timeout: true }), options.timeout);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const callback = (error, stdout, stderr) => {
      if (error) finish(reject, error);
      else finish(resolve, { stdout, stderr });
    };

    try {
      const returned = execFile(file, args, options, callback);
      if (returned && typeof returned.then === 'function') {
        returned.then((value) => finish(resolve, value), (error) => finish(reject, error));
      } else if (returned && Object.hasOwn(returned, 'stdout') && typeof returned.stdout !== 'object') {
        finish(resolve, returned);
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

function normalizeExecError(error) {
  if (error?.timeout === true || error?.killed === true || error?.code === 'ETIMEDOUT') {
    return new HerdrDiscoveryError(DISCOVERY_ERROR_CODES.TIMEOUT, 'Herdr status timed out');
  }
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new HerdrDiscoveryError(DISCOVERY_ERROR_CODES.OUTPUT_LIMIT, 'Herdr status output exceeded the limit');
  }
  return new HerdrDiscoveryError(DISCOVERY_ERROR_CODES.UNAVAILABLE, 'Herdr status is unavailable');
}

async function readStatus(execFile, command, timeoutMs, maxOutputBytes) {
  let result;
  try {
    result = await invokeExecFile(execFile, command, ['status', 'server', '--json'], {
      shell: false,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error) {
    if (error instanceof HerdrDiscoveryError) throw error;
    throw normalizeExecError(error);
  }

  const stdout = typeof result === 'string' ? result : result?.stdout;
  const stderr = typeof result === 'object' && result !== null ? result.stderr : '';
  if (byteLength(stdout) > maxOutputBytes || byteLength(stderr) > maxOutputBytes) {
    fail(DISCOVERY_ERROR_CODES.OUTPUT_LIMIT, 'Herdr status output exceeded the limit');
  }
  if (typeof stdout !== 'string') fail(DISCOVERY_ERROR_CODES.INVALID_STATUS, 'Herdr status response is invalid');

  try {
    return JSON.parse(stdout);
  } catch {
    fail(DISCOVERY_ERROR_CODES.INVALID_STATUS, 'Herdr status response is invalid');
  }
}

/** Discover a usable Herdr socket without invoking a shell. */
export async function discoverHerdr({
  env = process.env,
  execFile = nodeExecFile,
  command = 'herdr',
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_DISCOVERY_OUTPUT_BYTES,
  expectedProtocol = EXPECTED_HERDR_PROTOCOL,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    fail(DISCOVERY_ERROR_CODES.CONFIG, 'Herdr discovery options are invalid');
  }
  if (expectedProtocol !== null && (!Number.isSafeInteger(expectedProtocol) || expectedProtocol < 0)) {
    fail(DISCOVERY_ERROR_CODES.CONFIG, 'Herdr discovery options are invalid');
  }

  const override = env?.HERDR_SOCKET_PATH;
  if (nonEmptyString(override)) {
    return { socketPath: validateSocket(override), source: 'env', version: null, protocol: null };
  }

  const status = await readStatus(execFile, command, timeoutMs, maxOutputBytes);
  return validateStatus(status, expectedProtocol);
}

export const discover = discoverHerdr;
