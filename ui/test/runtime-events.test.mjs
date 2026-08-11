import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeEvents } from '../server/runtime-events.mjs';
import { RuntimeStore } from '../server/runtime-store.mjs';
import {
  ContractRuntimeClient,
  defer,
  flush,
  ManualTimers,
  runtimeError,
  sessionSnapshot,
} from './runtime-test-clients.mjs';

function setup(clients, timers) {
  const created = [];
  const coordinator = new RuntimeEvents({
    store: new RuntimeStore(),
    timers,
    pollIntervalMs: 1_000,
    discover: async () => ({ socketPath: '/tmp/fake.sock' }),
    reconnectMinMs: 250,
    reconnectMaxMs: 1_000,
    clientFactory: () => {
      const client = clients.shift();
      created.push(client);
      return client;
    },
  });
  return { coordinator, created };
}

test('does not overlap a pending poll; stop closes it and clears timers', async () => {
  const timers = new ManualTimers();
  const pending = defer();
  const first = new ContractRuntimeClient('A', sessionSnapshot(1));
  const second = new ContractRuntimeClient('B', pending.promise);
  const { coordinator, created } = setup([first, second], timers);

  await coordinator.start();
  await timers.run(1_000);
  assert.deepEqual(second.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(created.length, 2);
  assert.equal(timers.count(1_000), 0);

  await coordinator.stop();
  pending.resolve(sessionSnapshot(2));
  await flush();
  assert.equal(second.closed, 1);
  assert.equal(created.length, 2);
  assert.equal(timers.tasks.size, 0);
});

test('clears the last good snapshot before a failed poll retries with a new client', async () => {
  const timers = new ManualTimers();
  const failed = defer();
  const first = new ContractRuntimeClient('A', sessionSnapshot(1));
  const disconnected = new ContractRuntimeClient('B', failed.promise);
  const retry = new ContractRuntimeClient('C', sessionSnapshot(2));
  const { coordinator, created } = setup([first, disconnected, retry], timers);

  await coordinator.start();
  await timers.run(1_000);
  failed.reject(runtimeError('ERR_SOCKET_DISCONNECTED'));
  await flush();

  const reconnecting = coordinator.store.getSnapshot();
  assert.equal(reconnecting.connection.state, 'reconnecting');
  assert.equal(reconnecting.connection.errorCode, 'ERR_SOCKET_DISCONNECTED');
  assert.deepEqual(reconnecting.workspaces, []);
  assert.deepEqual(reconnecting.tabs, []);
  assert.deepEqual(reconnecting.agents, []);
  assert.equal(reconnecting.selectedPaneId, null);
  assert.equal(timers.count(250), 1);

  await timers.run(250);
  assert.deepEqual(retry.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(coordinator.store.getSnapshot().connection.state, 'connected');
  assert.equal(coordinator.store.getSnapshot().agents[0].revision, 2);
  assert.equal(created.some((client) => client.calls.some(({ method }) => method === 'events.subscribe')), false);

  await coordinator.stop();
  assert.equal(timers.tasks.size, 0);
});
