import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptWatcher } from '../server/transcript-watcher.mjs';
import {
  TranscriptWatcherError,
  validatePaneRead,
} from '../server/transcript-text-limit.mjs';
import {
  ManualTimers,
  OneShotTranscriptClient,
} from './transcript-one-shot-clients.mjs';

const validRead = {
  pane_id: 'p1',
  workspace_id: 'w',
  tab_id: 't',
  source: 'recent',
  format: 'ansi',
  text: 'visible',
  revision: 4,
  truncated: false,
};

const paneRead = (overrides = {}) => ({
  type: 'pane_read',
  read: { ...validRead, ...overrides },
});

test('rejects invalid pane.read pane, revision, source, and format fields', () => {
  const cases = [
    ['pane', { pane_id: 'other' }, 'ERR_PANE_READ_INVALID'],
    ['missing revision', { revision: undefined }, 'ERR_PANE_READ_REVISION'],
    ['negative revision', { revision: -1 }, 'ERR_PANE_READ_REVISION'],
    ['fractional revision', { revision: 1.5 }, 'ERR_PANE_READ_REVISION'],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }, 'ERR_PANE_READ_REVISION'],
    ['string revision', { revision: '4' }, 'ERR_PANE_READ_REVISION'],
    ['source', { source: 'wrapped' }, 'ERR_PANE_READ_INVALID'],
    ['format', { format: 'json' }, 'ERR_PANE_READ_INVALID'],
  ];

  for (const [label, overrides, expectedCode] of cases) {
    assert.throws(
      () => validatePaneRead(paneRead(overrides), 'p1'),
      (error) => {
        assert.equal(error instanceof TranscriptWatcherError, true, label);
        assert.equal(error.code, expectedCode, label);
        assert.equal(error.message, expectedCode, label);
        return true;
      },
      label,
    );
  }
});

test('rejects invalid selections with one stable code before creating a client', async (t) => {
  const invalidSelections = [
    null,
    {},
    { paneId: 'p1' },
    { socketPath: '/tmp/herdr.sock' },
    { socketPath: ' ', paneId: 'p1' },
    { socketPath: '/tmp/herdr.sock', paneId: ' ' },
  ];
  let factoryCalls = 0;
  const watcher = new TranscriptWatcher({
    clientFactory: () => {
      factoryCalls += 1;
      throw new Error('client must not be created');
    },
  });
  t.after(() => watcher.stop());

  for (const selection of invalidSelections) {
    await assert.rejects(watcher.select(selection), (error) => {
      assert.equal(error instanceof TranscriptWatcherError, true);
      assert.equal(error.code, 'ERR_INVALID_SELECTION');
      assert.equal(error.message, 'ERR_INVALID_SELECTION');
      return true;
    });
  }

  assert.equal(factoryCalls, 0);
  assert.equal(watcher.selection, null);
});

test('exposes only a stable code when the client factory fails', async (t) => {
  const secret = '/private/herdr/socket-with-secret-token';
  const rawError = Object.assign(new Error(secret), { code: 'err client factory' });
  const watcherErrors = [];
  const watcher = new TranscriptWatcher({
    clientFactory: () => { throw rawError; },
  });
  watcher.on('watcher-error', ({ code }) => watcherErrors.push(code));
  t.after(() => watcher.stop());

  await assert.rejects(
    watcher.select({ socketPath: '/tmp/herdr.sock', paneId: 'p1' }),
    (error) => {
      assert.equal(error instanceof TranscriptWatcherError, true);
      assert.equal(error.code, 'ERR_CLIENT_FACTORY');
      assert.equal(error.message, 'ERR_CLIENT_FACTORY');
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );
  assert.deepEqual(watcherErrors, ['ERR_CLIENT_FACTORY']);
});

test('sets bridgeTruncated, truncated, and gap for a UTF-8 tail over the byte limit', async (t) => {
  const timers = new ManualTimers();
  const expected = '🙂'.repeat(2) + 'abcd';
  const client = new OneShotTranscriptClient(paneRead({
    text: `x${expected}`,
    revision: 8,
  }));
  const watcher = new TranscriptWatcher({
    clientFactory: async () => client,
    timers,
    maxBytes: 12,
  });
  t.after(() => watcher.stop());

  const payload = await watcher.select({ socketPath: '/tmp/herdr.sock', paneId: 'p1' });

  assert.deepEqual(payload, {
    paneId: 'p1',
    text: expected,
    revision: 8,
    truncated: true,
    gap: true,
    reconnecting: false,
    bridgeTruncated: true,
  });
  assert.equal(Buffer.byteLength(payload.text, 'utf8'), 12);
  assert.deepEqual(timers.pendingDelays(), [1000]);
});
