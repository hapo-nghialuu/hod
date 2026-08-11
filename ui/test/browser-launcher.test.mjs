import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openBrowser } from '../server/browser-launcher.mjs';

test('macOS and Linux launchers use exact argv, shell false, bounded output and timeout', async () => {
  const calls = [];
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, '', ''); };
  await openBrowser('http://127.0.0.1:4317/#token=one', { platform: 'darwin', execFile, timeoutMs: 77, maxBuffer: 88 });
  await openBrowser('http://127.0.0.1:4317/#token=two', { platform: 'linux', execFile });
  assert.equal(calls[0].file, 'open');
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:4317/#token=one']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 77);
  assert.equal(calls[0].options.maxBuffer, 88);
  assert.equal(calls[1].file, 'xdg-open');
});

test('unsupported platforms and opener failures expose stable codes only', async () => {
  await assert.rejects(() => openBrowser('http://127.0.0.1:1/#token=x', { platform: 'win32' }), { code: 'ERR_UNSUPPORTED_PLATFORM' });
  await assert.rejects(() => openBrowser('http://127.0.0.1:1/#token=x', {
    platform: 'linux', execFile: (_file, _args, _options, callback) => callback(Object.assign(new Error('raw secret'), { code: 'EACCES' })),
  }), (error) => error.code === 'ERR_BROWSER_OPEN' && !error.message.includes('secret'));
});

test('waits for callback errors from ChildProcess-like opener results', async () => {
  await assert.rejects(() => openBrowser('http://127.0.0.1:1/#token=x', {
    platform: 'linux',
    execFile: (_file, _args, _options, callback) => {
      setImmediate(() => callback(Object.assign(new Error('late raw error'), { code: 'EACCES' })));
      return { stdout: {} };
    },
  }), { code: 'ERR_BROWSER_OPEN' });
});
