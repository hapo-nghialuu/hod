import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeStore } from '../server/runtime-store.mjs';
import { TranscriptSelectionCoordinator } from '../server/transcript-selection-coordinator.mjs';

const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function snapshot(panes) {
  const ids = panes.map((paneId) => String(paneId));
  return {
    version: '0.8.0', protocol: 19,
    workspaces: [{ workspace_id: 'w', number: 1, label: 'W', pane_count: ids.length, tab_count: 1, agent_status: 'working', focused: true }],
    tabs: [{ tab_id: 't', workspace_id: 'w', number: 1, label: 'T', pane_count: ids.length, agent_status: 'working', focused: true }],
    agents: ids.map((paneId, index) => ({ pane_id: paneId, workspace_id: 'w', tab_id: 't', name: paneId,
      agent_status: 'working', title: 'title', focused: index === 0, revision: index + 1 })),
  };
}

class FakeWatcher extends EventEmitter {
  constructor() { super(); this.selections = []; this.clears = 0; }
  async select(selection) {
    this.selections.push({ ...selection });
    return { ...selection, text: selection.paneId, revision: 4, gap: false, secret: 'drop' };
  }
  clear() { this.clears += 1; }
}

test('selects through a fresh discovery, hides socket data, and resumes with a gap', async () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot(['p1']));
  const watcher = new FakeWatcher();
  const gaps = [];
  const coordinator = new TranscriptSelectionCoordinator({
    store, watcher, discover: async () => ({ socketPath: '/private/herdr.sock' }), onGap: (value) => gaps.push(value),
  });
  coordinator.start();
  const initial = await coordinator.select('p1');
  assert.deepEqual(initial, { paneId: 'p1', text: 'p1', revision: 4, gap: false });
  assert.equal(Object.hasOwn(initial, 'socketPath'), false);
  store.resetForReconnect({ errorCode: 'ERR_SOCKET_DISCONNECTED' });
  assert.deepEqual(gaps, [{ paneId: 'p1', text: '', gap: true, reconnecting: true, truncated: false }]);
  store.replaceSnapshot(snapshot(['p1']));
  await flush();
  assert.deepEqual(watcher.selections, [
    { socketPath: '/private/herdr.sock', paneId: 'p1' },
    { socketPath: '/private/herdr.sock', paneId: 'p1', reconnecting: true },
  ]);
  coordinator.stop();
});

test('generation suppresses stale discovery and a disappeared pane is not resumed', async () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot(['p1', 'p2']));
  const watcher = new FakeWatcher();
  const first = defer();
  const second = defer();
  const discoveries = [first.promise, second.promise];
  const coordinator = new TranscriptSelectionCoordinator({ store, watcher, discover: () => discoveries.shift() });
  coordinator.start();
  const oldSelection = coordinator.select('p1');
  const newSelection = coordinator.select('p2');
  second.resolve({ socketPath: '/tmp/current.sock' });
  assert.equal((await newSelection).paneId, 'p2');
  first.resolve({ socketPath: '/tmp/stale.sock' });
  assert.equal(await oldSelection, null);
  assert.deepEqual(watcher.selections.map(({ paneId }) => paneId), ['p2']);
  store.replaceSnapshot(snapshot(['p1']));
  store.resetForReconnect();
  store.replaceSnapshot(snapshot(['p1']));
  await flush();
  assert.deepEqual(watcher.selections.map(({ paneId }) => paneId), ['p2']);
  coordinator.stop();
  coordinator.stop();
  assert.ok(watcher.clears >= 2);
});
