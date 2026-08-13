import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeStore } from '../server/runtime-store.mjs';
import { createLiveConsoleRuntime } from '../server/live-console-runtime.mjs';

const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function snapshot(panes = ['p1']) {
  return {
    version: '0.8.0', protocol: 19,
    workspaces: [{ workspace_id: 'w', number: 1, label: 'W', pane_count: panes.length, tab_count: 1, agent_status: 'working', focused: true }],
    tabs: [{ tab_id: 't', workspace_id: 'w', number: 1, label: 'T', pane_count: panes.length, agent_status: 'working', focused: true }],
    agents: panes.map((paneId, index) => ({ pane_id: paneId, workspace_id: 'w', tab_id: 't', name: paneId,
      agent_status: 'working', title: 'title', focused: index === 0, revision: index + 1 })),
  };
}

class FakeHub {
  constructor() { this.events = []; this.closed = 0; }
  publish(name, payload) { this.events.push({ name, payload }); return 1; }
  close() { this.closed += 1; }
}

class FakeWatcher extends EventEmitter {
  constructor() { super(); this.selections = []; this.clears = 0; this.stops = 0; }
  onTranscript(callback) { this.on('transcript', callback); return () => this.off('transcript', callback); }
  async select(selection) {
    this.selections.push({ ...selection });
    const payload = { paneId: selection.paneId, text: selection.reconnecting ? 'resumed' : 'initial', revision: 2,
      gap: selection.reconnecting === true, ...(selection.reconnecting ? { reconnecting: true } : {}) };
    this.emit('transcript', payload);
    return { ...payload, socketPath: selection.socketPath };
  }
  clear() { this.clears += 1; }
  stop() { this.stops += 1; }
}

class FakeRuntimeEvents {
  constructor(store, failure = false) { this.store = store; this.failure = failure; this.starts = 0; this.stops = 0; }
  start() {
    this.starts += 1;
    if (this.failure) {
      this.store.resetForReconnect({ errorCode: 'ERR_HERDR_DOWN' });
      return Promise.reject(Object.assign(new Error('raw /private/socket'), { code: 'ERR_HERDR_DOWN' }));
    }
    this.store.setConnection({ state: 'connecting' });
    return Promise.resolve();
  }
  stop() { this.stops += 1; }
}

function settings() {
  let value = 'terminal';
  return {
    async get() { return { hod: { roles: [{ role: 'impl', status: 'matches', unsafe: false }] },
      herdr: { settings: [{ key: 'theme.name', value, source: 'config', metadata: {} }] } }; },
    async postHod(body) { value = 'nord'; return { role: body.role, status: 'matches', unsafe: false }; },
    async postHerdr(body) { value = body.value; return { setting: { key: body.key, value, source: 'config' } }; },
  };
}

function makeRuntime(failure = false) {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot());
  const hub = new FakeHub();
  const watcher = new FakeWatcher();
  const events = new FakeRuntimeEvents(store, failure);
  let discovery = 0;
  const runtime = createLiveConsoleRuntime({
    runtimeStore: store, runtimeEvents: events, transcriptWatcher: watcher, sseHub: hub,
    settingsController: settings(), discover: async () => ({ socketPath: `/tmp/socket-${++discovery}` }),
  });
  return { runtime, store, hub, watcher, events };
}

test('attaches before runtime start, keeps API contracts, and publishes mutations', async () => {
  const { runtime, store, hub, watcher, events } = makeRuntime();
  await runtime.start();
  assert.equal(events.starts, 1);
  assert.deepEqual(hub.events.slice(0, 2).map(({ name }) => name), ['connection', 'state']);
  store.replaceSnapshot(snapshot());
  assert.deepEqual((await runtime.apiController.handle({ method: 'GET', path: '/api/state' })).body, store.getSnapshot());
  const selected = await runtime.apiController.handle({ method: 'POST', path: '/api/transcript/select', body: { paneId: 'p1' } });
  assert.deepEqual(selected.body, { paneId: 'p1', text: 'initial', revision: 2, gap: false });
  assert.equal(JSON.stringify(hub.events).includes('socket-'), false);
  const mutation = await runtime.apiController.handle({ method: 'POST', path: '/api/settings/hod',
    body: { role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE' } });
  assert.deepEqual(mutation.body, { role: 'impl', status: 'matches', unsafe: false });
  assert.equal(hub.events.at(-1).name, 'settings');
  await runtime.stop();
  await runtime.stop();
  store.setConnection({ state: 'connected' });
  watcher.emit('transcript', { paneId: 'p1', text: 'after stop' });
  assert.equal(events.stops, 1);
  assert.equal(watcher.stops, 1);
  assert.equal(hub.closed, 0);
});

test('initial Herdr failure resolves nonfatally while settings stay usable', async () => {
  const { runtime, store } = makeRuntime(true);
  await runtime.start();
  assert.equal(store.getSnapshot().connection.state, 'reconnecting');
  assert.equal(store.getSnapshot().connection.errorCode, 'ERR_HERDR_DOWN');
  const settingsResult = await runtime.apiController.handle({ method: 'GET', path: '/api/settings' });
  assert.equal(settingsResult.status, 200);
  assert.deepEqual(Object.keys(settingsResult.body), ['hod', 'herdr']);
  await runtime.stop();
});

test('reconnect clears stale transcript and automatically resumes the desired pane', async () => {
  const { runtime, store, hub, watcher } = makeRuntime();
  await runtime.start();
  store.replaceSnapshot(snapshot());
  await runtime.selectTranscript('p1');
  store.resetForReconnect({ errorCode: 'ERR_SOCKET_DISCONNECTED' });
  const gap = hub.events.find(({ name, payload }) => name === 'transcript' && payload.gap === true);
  assert.deepEqual(gap.payload, { paneId: 'p1', text: '', gap: true, reconnecting: true, truncated: false });
  store.replaceSnapshot(snapshot());
  await flush();
  assert.equal(watcher.selections.length, 2);
  assert.equal(watcher.selections[1].reconnecting, true);
  assert.equal(hub.events.filter(({ name }) => name === 'transcript').at(-1).payload.text, 'resumed');
  await runtime.stop();
});
