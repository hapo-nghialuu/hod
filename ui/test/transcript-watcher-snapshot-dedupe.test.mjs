import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptWatcher } from '../server/transcript-watcher.mjs';
import { ManualTimers, OneShotTranscriptClient } from './transcript-one-shot-clients.mjs';

const read = (text, revision) => ({ type: 'pane_read', read: {
  pane_id: 'p1', workspace_id: 'w', tab_id: 't', source: 'recent_unwrapped', format: 'text',
  text, revision, truncated: false,
} });
const semantic = ({
  paneId, text, revision, truncated, gap, reconnecting, bridgeTruncated,
}) => ({
  paneId, text, revision, truncated, gap, reconnecting, bridgeTruncated,
});

test('emits when reconnecting metadata clears on an unchanged snapshot', async (t) => {
  const timers = new ManualTimers();
  const clientA = new OneShotTranscriptClient(read('same', 1));
  const clientB = new OneShotTranscriptClient(read('same', 1));
  const clients = [clientA, clientB];
  const watcher = new TranscriptWatcher({
    clientFactory: async () => clients.shift(),
    timers,
  });
  t.after(async () => {
    await watcher.stop();
  });
  const updates = [];
  watcher.onTranscript((payload) => updates.push(payload));

  await watcher.select({ socketPath: '/tmp/sock', paneId: 'p1', reconnecting: true });
  await timers.runNext();

  const expected = (gap, reconnecting) => ({
    paneId: 'p1', text: 'same', revision: 1, truncated: false, gap, reconnecting,
    bridgeTruncated: false,
  });
  assert.deepEqual(updates.map(semantic), [expected(true, true), expected(false, false)]);
  assert.equal(clientA.requests.length, 1);
  assert.equal(clientB.requests.length, 1);
});
