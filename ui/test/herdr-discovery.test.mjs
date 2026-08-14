import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverHerdr,
  DISCOVERY_ERROR_CODES,
  EXPECTED_HERDR_PROTOCOL,
} from '../server/herdr-discovery.mjs';

const status = (overrides = {}) => ({
  running: true,
  compatible: true,
  socket_path: '/tmp/herdr.sock',
  protocol: EXPECTED_HERDR_PROTOCOL,
  version: '0.8.0',
  ...overrides,
});

function promiseExec(stdout, stderr = '') {
  return async () => ({ stdout, stderr });
}

test('non-empty HERDR_SOCKET_PATH wins without invoking herdr', async () => {
  let calls = 0;
  const result = await discoverHerdr({
    env: { HERDR_SOCKET_PATH: '/tmp/override.sock' },
    execFile: async () => { calls += 1; },
  });
  assert.deepEqual(result, {
    socketPath: '/tmp/override.sock', source: 'env', version: null, protocol: null,
  });
  assert.equal(calls, 0);
});

test('empty override falls back to execFile with bounded, shell-free invocation', async () => {
  let call;
  const result = await discoverHerdr({
    env: { HERDR_SOCKET_PATH: '   ' },
    timeoutMs: 321,
    maxOutputBytes: 4096,
    execFile: async (...args) => {
      call = args;
      return { stdout: JSON.stringify(status()), stderr: '' };
    },
  });
  assert.equal(result.socketPath, '/tmp/herdr.sock');
  assert.deepEqual(call.slice(0, 2), ['herdr', ['status', 'server', '--json']]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, 321);
  assert.equal(call[2].maxBuffer, 4096);
});

test('successful status validates and returns compatible metadata', async () => {
  const result = await discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec(JSON.stringify(status())) });
  assert.deepEqual(result, {
    socketPath: '/tmp/herdr.sock', source: 'status', version: '0.8.0', protocol: EXPECTED_HERDR_PROTOCOL,
  });
});

test('malformed, unavailable, and incompatible statuses fail with stable sanitized errors', async () => {
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec('{not-json}') }),
    (error) => error.code === DISCOVERY_ERROR_CODES.INVALID_STATUS && !error.message.includes('not-json'),
  );
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: async () => { throw Object.assign(new Error('/private/raw'), { code: 'ENOENT' }); } }),
    (error) => error.code === DISCOVERY_ERROR_CODES.UNAVAILABLE && !error.message.includes('/private/raw'),
  );
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec(JSON.stringify(status({ compatible: false }))) }),
    (error) => error.code === DISCOVERY_ERROR_CODES.INCOMPATIBLE && !error.message.includes('/tmp/herdr.sock'),
  );
});

test('not-running, invalid socket, protocol mismatch, and output cap fail closed', async () => {
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec(JSON.stringify(status({ running: false }))) }),
    (error) => error.code === DISCOVERY_ERROR_CODES.NOT_RUNNING,
  );
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec(JSON.stringify(status({ socket_path: 'relative.sock' }))) }),
    (error) => error.code === DISCOVERY_ERROR_CODES.SOCKET,
  );
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, execFile: promiseExec(JSON.stringify(status({ protocol: 18 }))) }),
    (error) => error.code === DISCOVERY_ERROR_CODES.INCOMPATIBLE,
  );
  await assert.rejects(
    discoverHerdr({ env: { HERDR_SOCKET_PATH: '' }, maxOutputBytes: 8, execFile: promiseExec('123456789') }),
    (error) => error.code === DISCOVERY_ERROR_CODES.OUTPUT_LIMIT,
  );
});
