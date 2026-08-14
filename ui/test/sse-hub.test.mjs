import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  MAX_SSE_CLIENTS,
  SseHub,
  formatSseEvent,
} from '../server/sse-hub.mjs';

class FakeResponse extends EventEmitter {
  constructor({ autoLength = false } = {}) {
    super();
    this.autoLength = autoLength;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.writableLength = 0;
    this.chunks = [];
    this.statusCode = 0;
    this.headers = {};
  }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() { this.flushed = true; }
  write(chunk) {
    this.chunks.push(String(chunk));
    if (this.autoLength) this.writableLength += Buffer.byteLength(String(chunk));
    return true;
  }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.end(); }
}

function fakeTimers() {
  const state = { timer: null, cleared: null, unref: false };
  state.timers = {
    setInterval(fn, ms) {
      state.timer = { fn, ms, unref() { state.unref = true; } };
      return state.timer;
    },
    clearInterval(timer) { state.cleared = timer; },
  };
  return state;
}

test('SSE frames are named JSON and accept a transcript around 20 MiB', () => {
  const frame = formatSseEvent('state', { agents: [] });
  assert.equal(frame, 'event: state\ndata: {"agents":[]}\n\n');
  assert.throws(() => formatSseEvent('bad name', {}), { code: 'ERR_SSE_EVENT_NAME' });
  const hub = new SseHub({ maxWritableBytes: 32 * 1024 * 1024, timers: fakeTimers().timers });
  const response = new FakeResponse();
  assert.equal(hub.addClient(response), true);
  const transcript = 'x'.repeat(20 * 1024 * 1024 - 256);
  assert.equal(hub.publish('transcript', { paneId: 'p1', text: transcript }), 1);
  assert.match(response.chunks.at(-1), /^event: transcript\ndata: \{"paneId":"p1","text":"x/);
  hub.close();
});

test('oversized state publishes a bounded browser resync signal', () => {
  const hub = new SseHub({ maxEventBytes: 128, timers: fakeTimers().timers });
  const response = new FakeResponse();
  assert.equal(hub.addClient(response), true);
  assert.equal(hub.publish('state', { agents: ['x'.repeat(512)] }), 1);
  assert.match(response.chunks.at(-1), /^event: resync\ndata: \{"gap":true,"event":"state"\}\n\n$/);
  hub.close();
});

test('client count is capped and close/error events clean clients up', () => {
  const timers = fakeTimers();
  const hub = new SseHub({ timers: timers.timers });
  const clients = Array.from({ length: MAX_SSE_CLIENTS }, () => new FakeResponse());
  for (const client of clients) assert.equal(hub.addClient(client), true);
  const rejected = new FakeResponse();
  assert.equal(hub.addClient(rejected), false);
  assert.equal(rejected.statusCode, 503);
  assert.equal(hub.clientCount, MAX_SSE_CLIENTS);
  clients[0].emit('close');
  assert.equal(hub.clientCount, MAX_SSE_CLIENTS - 1);
  hub.close();
  assert.equal(hub.clientCount, 0);
  assert.equal(timers.cleared, timers.timer);
  assert.equal(timers.unref, true);
  assert.equal(clients.slice(1).every((client) => client.writableEnded), true);
});

test('slow clients are evicted once writableLength exceeds the bounded cap', () => {
  const hub = new SseHub({ maxWritableBytes: 32, timers: fakeTimers().timers });
  const response = new FakeResponse();
  assert.equal(hub.addClient(response), true);
  response.writableLength = 33;
  assert.equal(hub.publish('state', { ok: true }), 0);
  assert.equal(hub.clientCount, 0);
  assert.equal(response.writableEnded, true);
  hub.cleanup();
});
