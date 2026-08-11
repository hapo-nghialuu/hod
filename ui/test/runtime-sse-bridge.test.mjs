import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeStore } from '../server/runtime-store.mjs';
import { RuntimeSseBridge } from '../server/runtime-sse-bridge.mjs';

class FakeHub {
  constructor() { this.events = []; }
  publish(name, payload) { this.events.push({ name, payload }); return 1; }
}

class FakeWatcher extends EventEmitter {
  onTranscript(callback) { this.on('transcript', callback); return () => this.off('transcript', callback); }
}

test('publishes named runtime, transcript, and settings events and cleans up idempotently', () => {
  const store = new RuntimeStore();
  const watcher = new FakeWatcher();
  const hub = new FakeHub();
  const bridge = new RuntimeSseBridge({ store, watcher, hub });
  store.setConnection({ state: 'connected', version: '0.8.0', protocol: 19 });
  assert.deepEqual(hub.events, []);
  bridge.start();
  bridge.start();
  store.setConnection({ state: 'reconnecting', errorCode: 'ERR_SOCKET' });
  watcher.emit('transcript', { paneId: 'p1', text: 'safe', revision: 2, gap: false, socketPath: '/private/nope' });
  bridge.publishSettings({ hod: { roles: [] }, herdr: { settings: [] }, secret: 'drop' });
  assert.deepEqual(hub.events.map(({ name }) => name), ['connection', 'state', 'transcript', 'settings']);
  assert.deepEqual(hub.events[0].payload, {
    state: 'reconnecting', version: '0.8.0', protocol: 19, errorCode: 'ERR_SOCKET',
  });
  assert.deepEqual(hub.events[2].payload, { paneId: 'p1', text: 'safe', revision: 2, gap: false });
  assert.equal(JSON.stringify(hub.events[2]).includes('nope'), false);
  assert.deepEqual(hub.events[3].payload, { hod: { roles: [] }, herdr: { settings: [] } });
  assert.equal(JSON.stringify(hub.events[3]).includes('drop'), false);
  bridge.stop();
  bridge.stop();
  store.setConnection({ state: 'disconnected' });
  watcher.emit('transcript', { paneId: 'p1', text: 'after stop' });
  assert.equal(hub.events.length, 4);
});
