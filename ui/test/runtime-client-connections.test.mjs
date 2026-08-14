import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeEvents } from '../server/runtime-events.mjs';
import { RuntimeStore } from '../server/runtime-store.mjs';
import { ContractRuntimeClient, ManualTimers, sessionSnapshot } from './runtime-test-clients.mjs';

test('uses a fresh one-shot client for each poll and never subscribes', async () => {
  const timers = new ManualTimers();
  const first = new ContractRuntimeClient('A', sessionSnapshot(1));
  const second = new ContractRuntimeClient('B', sessionSnapshot(2));
  const clients = [first, second];
  const created = [];
  const coordinator = new RuntimeEvents({
    store: new RuntimeStore(),
    timers,
    pollIntervalMs: 1_000,
    discover: async () => ({ socketPath: '/tmp/fake.sock' }),
    clientFactory: () => {
      const client = clients.shift();
      created.push(client);
      return client;
    },
  });

  await coordinator.start();
  assert.deepEqual(created, [first]);
  assert.deepEqual(first.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(timers.count(1_000), 1);

  await timers.run(1_000);
  assert.deepEqual(created, [first, second]);
  assert.deepEqual(second.calls.map(({ method }) => method), ['session.snapshot']);
  assert.equal(created.some((client) => client.calls.some(({ method }) => method === 'events.subscribe')), false);
  assert.equal(coordinator.store.getSnapshot().agents[0].revision, 2);

  await coordinator.stop();
});
