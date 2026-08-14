import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGlobalObserverRuntime } from '../server/global-observer-runtime.mjs';
import { RuntimeEvents } from '../server/runtime-events.mjs';
import { RuntimeStore } from '../server/runtime-store.mjs';
import { ContractRuntimeClient, ManualTimers, sessionSnapshot } from './runtime-test-clients.mjs';

class FakeWatcher extends EventEmitter {
  constructor() { super(); this.stops = 0; }
  onTranscript(callback) { this.on('transcript', callback); return () => this.off('transcript', callback); }
  async select(selection) { return { paneId: selection.paneId, text: 'read-only' }; }
  async clear() {}
  async stop() { this.stops += 1; }
}

class FakeHub {
  constructor() { this.events = []; this.closed = 0; }
  publish(name, payload) { this.events.push({ name, payload }); return 1; }
  close() { this.closed += 1; }
}

class ManualSseTimers extends ManualTimers {
  setInterval(callback, delay) { return this.setTimeout(callback, delay); }
  clearInterval(id) { this.clearTimeout(id); }
}

test('composes runtime events and SSE over one-shot snapshots with observer capabilities', async () => {
  const timers = new ManualTimers();
  const client = new ContractRuntimeClient('observer', sessionSnapshot(7));
  const hub = new FakeHub();
  const watcher = new FakeWatcher();
  const store = new RuntimeStore();
  const runtime = createGlobalObserverRuntime({
    runtimeStore: store,
    runtimeEvents: new RuntimeEvents({
      store,
      timers,
      pollIntervalMs: 1_000,
      discover: async () => ({ socketPath: '/tmp/herdr.sock' }),
      clientFactory: () => client,
    }),
    transcriptWatcher: watcher,
    sseHub: hub,
    discover: async () => ({ socketPath: '/tmp/herdr.sock' }),
    settingsSnapshotReader: async () => sessionSnapshot(7).snapshot,
  });

  await runtime.start();
  assert.deepEqual(client.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(client.closed, 1);
  assert.equal(client.calls.some(({ method }) => method === 'events.subscribe'), false);
  const state = await runtime.apiController.handle({ method: 'GET', path: '/api/state' });
  assert.deepEqual(state.body.capabilities, { settings: true, control: false, mutation: true });
  assert.equal(JSON.stringify(state.body).match(/(?:cwd|projectRoot|checkout_path|foreground_cwd)/i), null);
  const stateEvent = hub.events.find(({ name }) => name === 'state');
  assert.deepEqual(stateEvent.payload.capabilities, state.body.capabilities);
  const settings = await runtime.apiController.handle({ method: 'GET', path: '/api/settings' });
  assert.equal(settings.status, 200); assert.equal(settings.body.selectedWorkspaceId, null);
  await runtime.stop();
  assert.equal(watcher.stops, 1);
  assert.equal(hub.closed, 0);
});

test('default runtime-only composition uses one-shot snapshots and global settings service', async () => {
  const timers = new ManualSseTimers();
  const client = new ContractRuntimeClient('default-observer', sessionSnapshot(8));
  const runtime = createGlobalObserverRuntime({
    discover: async () => ({ socketPath: '/tmp/herdr.sock' }),
    runtimeEventsOptions: {
      timers,
      pollIntervalMs: 1_000,
      clientFactory: () => client,
    },
    transcriptWatcherOptions: { timers },
    sseHubOptions: { timers, heartbeatMs: 15_000 },
  });

  assert.equal(runtime.runtimeEvents instanceof RuntimeEvents, true);
  assert.equal(typeof runtime.settingsController?.get, 'function');
  assert.equal('hodRoleSettings' in runtime, false);
  assert.equal('herdrConfigSettings' in runtime, false);
  await runtime.start();
  assert.deepEqual(client.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(client.closed, 1);
  assert.equal(client.calls.some(({ method }) => method === 'events.subscribe'), false);
  await runtime.stop();
  assert.equal(runtime.sseHub.closed, true);
});

test('stop settles throwing or rejecting hub cleanup and restart remains usable', async () => {
  let starts = 0;
  let stops = 0;
  const runtime = createGlobalObserverRuntime({
    runtimeEvents: {
      start() { starts += 1; return Promise.resolve(); },
      stop() { stops += 1; return Promise.resolve(); },
    },
    transcriptWatcher: new FakeWatcher(),
    sseHubOptions: { heartbeatMs: 60_000 },
  });
  const realClose = runtime.sseHub.close.bind(runtime.sseHub);
  let closeCalls = 0;
  runtime.sseHub.close = () => {
    closeCalls += 1;
    if (closeCalls === 1) throw new Error('sync hub close failure');
    return Promise.reject(new Error('async hub close failure'));
  };

  await assert.doesNotReject(() => runtime.stop());
  assert.equal(runtime._stopPromise, null);
  await assert.doesNotReject(() => runtime.start());
  assert.equal(starts, 1);
  await assert.doesNotReject(() => runtime.stop());
  assert.equal(runtime._stopPromise, null);
  assert.equal(stops, 1);
  assert.equal(closeCalls, 2);

  runtime.sseHub.close = realClose;
  runtime.sseHub.close();
});
