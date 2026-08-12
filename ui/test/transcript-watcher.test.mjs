import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptWatcher } from '../server/transcript-watcher.mjs';
import {
  defer,
  errorWithCode,
  flush,
  ManualTimers,
  OneShotTranscriptClient,
} from './transcript-one-shot-clients.mjs';

const read = (paneId, text, revision) => ({ type: 'pane_read', read: {
  pane_id: paneId, workspace_id: 'w', tab_id: 't', source: 'recent', format: 'ansi',
  text, revision, truncated: false,
} });
const semantic = ({
  paneId, text, revision, truncated, gap, reconnecting, bridgeTruncated,
}) => ({
  paneId, text, revision, truncated, gap, reconnecting, bridgeTruncated,
});

const methods = (client) => client.requests.map(({ method }) => method);
const factoryFor = (clients) => async () => {
  const client = clients.shift();
  assert.ok(client, 'unexpected transcript client');
  return client;
};
const watcherFor = (clients, timers) => new TranscriptWatcher({
  clientFactory: factoryFor(clients),
  timers,
});
const cleanupWatcher = (t, watcher) => {
  t.after(async () => {
    await watcher.stop();
  });
};
const assertPanePolling = (clients) => {
  for (const client of clients) {
    assert.deepEqual(methods(client), ['pane.read']);
    assert.equal(client.requests.length, 1);
    assert.deepEqual(client.requests[0].params, {
      pane_id: client.requests[0].params.pane_id, source: 'recent', format: 'ansi', strip_ansi: false,
    });
  }
};

test('polls pane.read with one fresh client per bounded timer', async (t) => {
  const timers = new ManualTimers();
  const clientA = new OneShotTranscriptClient(read('p1', 'initial', 1));
  const clientB = new OneShotTranscriptClient(read('p1', 'initial', 1));
  const clientC = new OneShotTranscriptClient(read('p1', 'changed', 1));
  const clientD = new OneShotTranscriptClient(read('p1', 'changed', 1));
  const clients = [clientA, clientB, clientC, clientD];
  const watcher = watcherFor(clients, timers);
  cleanupWatcher(t, watcher);
  const updates = [];
  watcher.onTranscript((payload) => updates.push(payload));
  const expected = (text) => ({
    paneId: 'p1', text, revision: 1, truncated: false, gap: false,
    reconnecting: false, bridgeTruncated: false,
  });

  await watcher.select({ socketPath: '/tmp/sock', paneId: 'p1' });
  assert.deepEqual(updates.map(semantic), [expected('initial')]);
  assert.deepEqual(timers.pendingDelays(), [1000]);
  assert.deepEqual(timers.scheduledDelays(), [1000]);

  await timers.runNext();
  assert.equal(clientB.closes, 1);
  assert.deepEqual(updates.map(semantic), [expected('initial')]);
  assert.deepEqual(timers.pendingDelays(), [1000]);
  assert.deepEqual(timers.scheduledDelays(), [1000, 1000]);

  await timers.runNext();
  assert.deepEqual(updates.map(semantic), [expected('initial'), expected('changed')]);
  assert.deepEqual(timers.pendingDelays(), [1000]);
  assert.deepEqual(timers.scheduledDelays(), [1000, 1000, 1000]);

  await timers.runNext();
  assert.deepEqual(updates.map(semantic), [expected('initial'), expected('changed')]);
  assert.deepEqual(timers.scheduledDelays(), [1000, 1000, 1000, 1000]);
  assertPanePolling([clientA, clientB, clientC, clientD]);
  await watcher.stop();
});

for (const action of ['stop', 'clear']) {
  test(`${action} cancels a pending poll once and suppresses stale completion`, async (t) => {
    const timers = new ManualTimers();
    const poll = defer();
    const clientA = new OneShotTranscriptClient(read('p1', 'initial', 1));
    const clientB = new OneShotTranscriptClient(poll);
    const clients = [clientA, clientB];
    const watcher = watcherFor(clients, timers);
    cleanupWatcher(t, watcher);
    const updates = [];
    watcher.onTranscript((payload) => updates.push(payload));

    await watcher.select({ socketPath: '/tmp/sock', paneId: 'p1' });
    await timers.runNext();
    assert.deepEqual(timers.pendingDelays(), []);
    await watcher[action]();
    await watcher[action]();
    poll.resolve(read('p1', 'stale', 2));
    await flush();

    assert.deepEqual(updates.map(({ revision }) => revision), [1]);
    assert.equal(clientA.closes, 1);
    assert.equal(clientB.closes, 1);
    assert.equal(watcher.selection, null);
    assertPanePolling(clients);
  });
}

test('selection switch clears the old timer before new pane output', async (t) => {
  const timers = new ManualTimers();
  const clientA = new OneShotTranscriptClient(read('p1', 'old', 1));
  const clientB = new OneShotTranscriptClient(({ method }) => (
    method === 'events.wait' ? defer() : read('p2', 'new', 2)
  ));
  const clientC = new OneShotTranscriptClient(read('p2', 'new', 2));
  const clients = [clientA, clientB, clientC];
  const watcher = watcherFor(clients, timers);
  cleanupWatcher(t, watcher);
  const updates = [];
  watcher.onTranscript((payload) => updates.push(payload));

  await watcher.select({ socketPath: '/tmp/sock', paneId: 'p1' });
  await flush();
  const oldTimer = timers.pendingTimers()[0];
  await watcher.select({ socketPath: '/tmp/sock', paneId: 'p2' });
  assert.ok(oldTimer, 'selection must have a scheduled poll timer');
  assert.equal(oldTimer.clearCount, 1);
  assert.deepEqual(updates.map(({ paneId, text }) => [paneId, text]), [
    ['p1', 'old'], ['p2', 'new'],
  ]);
  assert.deepEqual(timers.pendingDelays(), [1000]);
  await watcher.clear();
  assertPanePolling([clientA, clientB]);
});

test('selection switch cancels the old operation and suppresses stale output', async (t) => {
  const timers = new ManualTimers();
  const staleRead = defer();
  const clientA = new OneShotTranscriptClient(staleRead);
  const clientB = new OneShotTranscriptClient(read('p2', 'new', 2));
  const clients = [clientA, clientB];
  const watcher = watcherFor(clients, timers);
  cleanupWatcher(t, watcher);
  const updates = [];
  watcher.onTranscript((payload) => updates.push(payload));

  const oldSelection = watcher.select({ socketPath: '/tmp/sock', paneId: 'p1' });
  await flush();
  await watcher.select({ socketPath: '/tmp/sock', paneId: 'p2' });
  staleRead.resolve(read('p1', 'stale', 9));
  await oldSelection.catch(() => {});
  await flush();

  assert.deepEqual(updates.map(({ paneId, text }) => [paneId, text]), [['p2', 'new']]);
  assert.equal(clientA.closes, 1);
  assert.equal(clientB.closes, 1);
  assertPanePolling(clients);
  await watcher.clear();
});

for (const code of ['ERR_SOCKET_DISCONNECTED', 'ERR_REQUEST_TIMEOUT']) {
  test(`${code} retains the last update and recovers on a bounded retry`, async (t) => {
    const timers = new ManualTimers();
    const clientA = new OneShotTranscriptClient(read('p1', 'initial', 1));
    const clientB = new OneShotTranscriptClient(() => Promise.reject(errorWithCode(code)));
    const clientC = new OneShotTranscriptClient(read('p1', 'recovered', 2));
    const clients = [clientA, clientB, clientC];
    const watcher = watcherFor(clients, timers);
    cleanupWatcher(t, watcher);
    const updates = [];
    const errors = [];
    watcher.onTranscript((payload) => updates.push(payload));
    watcher.on('watcher-error', (error) => errors.push(error));

    await watcher.select({ socketPath: '/tmp/sock', paneId: 'p1' });
    await timers.runNext();
    assert.deepEqual(updates.map(({ revision }) => revision), [1]);
    assert.deepEqual(errors, [{ code }]);
    assert.deepEqual(timers.pendingDelays(), [250]);
    assert.deepEqual(timers.scheduledDelays(), [1000, 250]);

    await timers.runNext();
    assert.deepEqual(updates.map(({ revision }) => revision), [1, 2]);
    assert.deepEqual(errors, [{ code }]);
    assert.deepEqual(timers.pendingDelays(), [1000]);
    assertPanePolling(clients);
    await watcher.stop();
  });
}
