import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HerdrSocketClient,
  MAX_PENDING_REQUESTS,
  SOCKET_STATUS,
} from '../server/herdr-socket-client.mjs';
import { createFakeHerdrServer } from './helpers/fake-herdr-server.mjs';

async function openClient(requestTimeoutMs = 250) {
  const server = await createFakeHerdrServer();
  const client = new HerdrSocketClient({ socketPath: server.socketPath, requestTimeoutMs });
  await client.connect();
  return { server, client };
}

async function cleanup(server, client) {
  await client?.disconnect().catch(() => {});
  await server?.close();
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test('connects over a Unix socket and correlates a success response', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('pane.read', { pane_id: 'pane-1' });
    const request = await server.waitForRequest();
    assert.equal(typeof request.id, 'string');
    assert.equal(request.method, 'pane.read');
    assert.deepEqual(request.params, { pane_id: 'pane-1' });
    server.send({ id: request.id, result: { revision: 4 } });
    assert.deepEqual(await resultPromise, { revision: 4 });
    assert.equal(client.status, SOCKET_STATUS.CONNECTED);
  } finally {
    await cleanup(server, client);
  }
});

test('rejects a correlated Herdr error response', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('missing.method');
    const request = await server.waitForRequest();
    server.send({ id: request.id, error: { code: 'E_NOT_FOUND', message: 'missing' } });
    await assert.rejects(resultPromise, (error) => {
      assert.equal(error.code, 'E_NOT_FOUND');
      assert.equal(error.message, 'missing');
      assert.equal(error.details, undefined);
      return true;
    });
  } finally {
    await cleanup(server, client);
  }
});

test('handles a response split across multiple data frames', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('split.frame');
    const request = await server.waitForRequest();
    const response = JSON.stringify({ id: request.id, result: 'split-ok' });
    server.sendRaw(response.slice(0, 5));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.pendingCount, 1);
    server.sendRaw(`${response.slice(5)}\n`);
    assert.equal(await resultPromise, 'split-ok');
  } finally {
    await cleanup(server, client);
  }
});

test('delivers a coalesced event and response in wire order', async () => {
  const { server, client } = await openClient();
  const events = [];
  const removeEventListener = client.onEvent((event) => events.push(event));
  try {
    const resultPromise = client.request('coalesced');
    const request = await server.waitForRequest();
    server.sendRaw(
      `${JSON.stringify({ event: 'pane_output_changed', data: { pane_id: 'p1' } })}\n`
      + `${JSON.stringify({ id: request.id, result: true })}\n`,
    );
    assert.equal(await resultPromise, true);
    assert.deepEqual(events, [{ event: 'pane_output_changed', data: { pane_id: 'p1' } }]);
  } finally {
    removeEventListener();
    await cleanup(server, client);
  }
});

test('times out a request and removes it from pending correlation', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('slow', {}, { timeoutMs: 20 });
    await server.waitForRequest();
    await assert.rejects(resultPromise, hasCode('ERR_REQUEST_TIMEOUT'));
    assert.equal(client.pendingCount, 0);
  } finally {
    await cleanup(server, client);
  }
});

test('rejects pending requests when the peer disconnects', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('disconnect.me');
    await server.waitForRequest();
    const closed = once(client, 'close');
    server.destroyConnection();
    await assert.rejects(resultPromise, hasCode('ERR_SOCKET_DISCONNECTED'));
    await closed;
    assert.equal(client.status, SOCKET_STATUS.DISCONNECTED);
  } finally {
    await cleanup(server, client);
  }
});

test('fails closed on invalid JSON and rejects every pending request', async () => {
  const { server, client } = await openClient();
  try {
    const resultPromise = client.request('invalid.frame');
    await server.waitForRequest();
    const closed = once(client, 'close');
    server.sendRaw('{not-json}\n');
    await assert.rejects(resultPromise, hasCode('ERR_PROTOCOL'));
    await closed;
    assert.equal(client.status, SOCKET_STATUS.DISCONNECTED);
  } finally {
    await cleanup(server, client);
  }
});

test('rejects the 129th request while 128 requests are pending', async () => {
  const { server, client } = await openClient(5_000);
  try {
    const requests = Array.from({ length: MAX_PENDING_REQUESTS }, (_, index) => (
      client.request(`pending.${index}`)
    ));
    assert.equal(client.pendingCount, MAX_PENDING_REQUESTS);
    await assert.rejects(client.request('pending.over-limit'), hasCode('ERR_PENDING_LIMIT'));
    const settled = Promise.allSettled(requests);
    await client.disconnect();
    const results = await settled;
    assert.ok(results.every(({ reason }) => reason?.code === 'ERR_SOCKET_DISCONNECTED'));
  } finally {
    await cleanup(server, client);
  }
});

test('settles pre-write failures and waits for close before reconnecting', async () => {
  const { server, client } = await openClient();
  try {
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(client.request('cyclic', cyclic), hasCode('ERR_INVALID_REQUEST'));
    assert.equal(client.pendingCount, 0);
    await client.disconnect();
    assert.equal(client.status, SOCKET_STATUS.DISCONNECTED);
    await client.connect();
    assert.equal(client.status, SOCKET_STATUS.CONNECTED);
  } finally {
    await cleanup(server, client);
  }
});

test('fake server cleanup removes its temporary Unix socket directory', async () => {
  const server = await createFakeHerdrServer();
  const directory = server.directory;
  await server.close();
  assert.equal(existsSync(directory), false);
});
