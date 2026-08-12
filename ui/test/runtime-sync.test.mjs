import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient } from '../public/modules/api-client.mjs';
import { createRuntimeSync } from '../public/modules/runtime-sync.mjs';
import { SseHub } from '../server/sse-hub.mjs';

const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

class FakeSource {
  constructor(handlers) { this.handlers = handlers; this.closed = 0; }
  emit(name, value) {
    if (name === 'open') this.handlers.onOpen?.(value);
    else if (name === 'error') this.handlers.onError?.(value);
    else this.handlers.onEvent?.(name, value);
  }
  close() { this.closed += 1; }
}

class EventSourceFromFrames {
  static current;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    EventSourceFromFrames.current = this;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  emit(name, data) {
    this.listeners.get(name)?.({ data });
  }

  close() {
    this.closed = true;
  }
}

class FakeResponse {
  constructor() {
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.writableLength = 0;
  }

  on() {}

  writeHead() {}

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function timers() {
  const tasks = [];
  return {
    tasks,
    setTimeout(fn, ms) { const task = { fn, ms }; tasks.push(task); return task; },
    clearTimeout(task) { const index = tasks.indexOf(task); if (index >= 0) tasks.splice(index, 1); },
  };
}

test('open, error, and bounded resync signals refresh runtime and settings', async () => {
  const clock = timers(); const sources = []; const states = []; const settings = []; let calls = 0;
  const api = {
    getState: async () => ({ revision: ++calls }),
    getSettings: async () => ({ revision: ++calls }),
    openEvents: (handlers) => { const source = new FakeSource(handlers); sources.push(source); return source; },
  };
  const sync = createRuntimeSync({ api, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout,
    onState: (value) => states.push(value), onSettings: (value) => settings.push(value), errorCode: () => 'ERR_SOCKET' });
  sync.open(); sources[0].emit('open'); await flush();
  sources[0].emit('resync', { gap: true }); await flush();
  sources[0].emit('error', new Error('socket')); await flush();
  assert.equal(states.length, 3); assert.equal(settings.length, 3);
  assert.equal(clock.tasks.length, 1); assert.equal(sources[0].closed, 1);
  sync.stop();
});

test('observer capabilities skip settings while legacy settings 404 remains a failure', async () => {
  const clock = timers(); const sources = []; const statuses = []; let phase = 0; let settingsCalls = 0;
  const api = {
    getState: async () => ({ capabilities: { settings: phase++ > 0 } }),
    getSettings: async () => { settingsCalls += 1; throw Object.assign(new Error('route'), { status: 404 }); },
    openEvents: (handlers) => { const source = new FakeSource(handlers); sources.push(source); return source; },
  };
  const sync = createRuntimeSync({ api, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout,
    onStatus: (message, code) => statuses.push([message, code]) });
  sync.open(); sources[0].emit('open'); await flush();
  assert.equal(settingsCalls, 0); assert.deepEqual(statuses.at(-1), ['refresh complete', 'OK']);
  sources[0].emit('resync', {}); await flush();
  assert.equal(settingsCalls, 1); assert.deepEqual(statuses.at(-1), ['refresh failed', 'ERR_UNAVAILABLE']);
  sync.stop();
});

test('an oversized SseHub resync reaches runtime refresh through EventSource', async () => {
  const clock = timers();
  const states = [];
  const settings = [];
  const malformed = [];
  let stateCalls = 0;
  let settingsCalls = 0;
  const api = createApiClient({
    EventSourceImpl: EventSourceFromFrames,
    fetchImpl: async (path) => {
      if (path === '/api/state') return jsonResponse({ revision: ++stateCalls });
      if (path === '/api/settings') return jsonResponse({ revision: ++settingsCalls });
      throw new Error(`unexpected path: ${path}`);
    },
  });
  const sync = createRuntimeSync({
    api,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    onState: (value) => states.push(value),
    onSettings: (value) => settings.push(value),
    onMalformed: () => malformed.push(true),
  });

  sync.open();
  const source = EventSourceFromFrames.current;
  source.emit('open');
  await flush();
  assert.equal(stateCalls, 1);
  assert.equal(settingsCalls, 1);

  const hub = new SseHub({
    maxEventBytes: 128,
    timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
  const response = new FakeResponse();
  assert.equal(hub.addClient(response), true);
  assert.equal(hub.publish('state', { agents: ['x'.repeat(512)] }), 1);
  const frame = response.chunks.at(-1);
  const match = /^event: ([^\n]+)\ndata: ([^\n]+)\n\n$/.exec(frame);
  assert.ok(match);
  assert.equal(match[1], 'resync');

  source.emit(match[1], match[2]);
  await flush();
  assert.equal(stateCalls, 2);
  assert.equal(settingsCalls, 2);
  assert.deepEqual(states.at(-1), { revision: 2 });
  assert.deepEqual(settings.at(-1), { revision: 2 });

  source.emit('resync', '{malformed');
  await flush();
  assert.equal(stateCalls, 2);
  assert.equal(settingsCalls, 2);
  assert.equal(malformed.length, 1);
  sync.stop();
  hub.close();
});

test('a late failed refresh cannot overwrite a newer connection refresh', async () => {
  const clock = timers(); const sources = []; const states = []; const settings = [];
  let resolveSettings; let stateCalls = 0; let settingsCalls = 0;
  const api = {
    getState: () => Promise.resolve({ revision: ++stateCalls }),
    getSettings: () => (++settingsCalls === 1
      ? new Promise((resolve) => { resolveSettings = resolve; }) : Promise.resolve({ revision: 2 })),
    openEvents: (handlers) => { const source = new FakeSource(handlers); sources.push(source); return source; },
  };
  const sync = createRuntimeSync({ api, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout,
    onState: (value) => states.push(value), onSettings: (value) => settings.push(value) });
  sync.open(); sources[0].emit('open'); await flush();
  sources[0].emit('error', new Error('socket')); await flush();
  assert.deepEqual(states, [{ revision: 1 }, { revision: 2 }]); assert.deepEqual(settings, [{ revision: 2 }]);
  resolveSettings({ revision: 1 }); await flush();
  assert.deepEqual(settings, [{ revision: 2 }]);
  sync.stop();
});
