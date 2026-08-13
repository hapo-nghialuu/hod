import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NdjsonFrameDecoder } from '../server/ndjson-frame-decoder.mjs';
import {
  HerdrSocketClient,
  MAX_LINE_BYTES,
} from '../server/herdr-socket-client.mjs';
import { createFakeHerdrServer } from './helpers/fake-herdr-server.mjs';

async function openClient(maxLineBytes) {
  const server = await createFakeHerdrServer();
  const client = new HerdrSocketClient({ socketPath: server.socketPath, maxLineBytes });
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

test('uses a bounded 32 MiB default frame limit', () => {
  assert.equal(MAX_LINE_BYTES, 32 * 1024 * 1024);
  assert.equal(new NdjsonFrameDecoder().maxLineBytes, MAX_LINE_BYTES);
});

test('decoder applies an injected positive integer frame limit', () => {
  const decoder = new NdjsonFrameDecoder(1024);
  assert.equal(decoder.maxLineBytes, 1024);
  assert.throws(() => decoder.push('x'.repeat(1025)), hasCode('ERR_LINE_TOO_LARGE'));
  assert.throws(() => new NdjsonFrameDecoder(0), /positive integer/);
});

test('client closes on an incoming frame over its injected limit', async () => {
  const { server, client } = await openClient(1024);
  try {
    const resultPromise = client.request('oversized.frame');
    await server.waitForRequest();
    const closed = once(client, 'close');
    server.sendRaw('x'.repeat(1025));
    await assert.rejects(resultPromise, hasCode('ERR_LINE_TOO_LARGE'));
    await closed;
  } finally {
    await cleanup(server, client);
  }
});

test('client rejects an outgoing frame over its injected limit', async () => {
  const { server, client } = await openClient(4096);
  try {
    await assert.rejects(
      client.request('oversized.request', 'x'.repeat(4096)),
      hasCode('ERR_LINE_TOO_LARGE'),
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    await cleanup(server, client);
  }
});
