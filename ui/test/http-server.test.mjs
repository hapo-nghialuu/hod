import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as nodeRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionAuth } from '../server/session-auth.mjs';
import { SseHub } from '../server/sse-hub.mjs';
import { createHttpServer } from '../server/http-server.mjs';
import { GlobalObserverApiController } from '../server/global-observer-api-controller.mjs';
import { startHodUi } from '../server.mjs';

const apps = [];
const root = await mkdtemp(join(tmpdir(), 'hod-http-'));
await writeFile(join(root, 'index.html'), '<main>loopback</main>');

afterEach(async () => { while (apps.length) await apps.pop().close(); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function app() {
  const calls = [];
  const auth = new SessionAuth({ bootstrapToken: 'bootstrap-only' });
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const controller = { async handle(request) {
    calls.push(request);
    if (request.path === '/api/state') return { status: 200, body: { ok: true } };
    if (request.path === '/api/settings/hod') return { status: 201, body: { role: request.body.role } };
    return null;
  } };
  const server = createHttpServer({ port: 0, bootstrapToken: 'bootstrap-only', sessionAuth: auth,
    apiController: controller, sseHub: hub, publicRoot: root });
  await server.listen(); apps.push(server);
  return { server, calls, hub };
}

async function request(server, path, options = {}) {
  const port = server.port;
  return fetch(`http://127.0.0.1:${port}${path}`, { ...options,
    headers: { Host: `127.0.0.1:${port}`, ...(options.headers ?? {}) },
  });
}

function rawRequest(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = nodeRequest({ hostname: '127.0.0.1', port: server.port, path, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
    });
    request.once('error', reject);
    request.end();
  });
}

test('startHodUi preserves a class controller receiver over real loopback HTTP', async () => {
  const agents = Array.from({ length: 5 }, (_, index) => ({ paneId: `pane-${index + 1}` }));
  const runtimeStore = { getSnapshot: () => ({ agents }), selectPane() {} };
  const controller = new GlobalObserverApiController({ runtimeStore,
    selectTranscript: async (paneId) => ({ paneId, text: 'selected', revision: 1 }) });
  const runtime = { apiController: controller, async start() {}, async stop() {} };
  const direct = await runtime.apiController.handle({ method: 'GET', path: '/api/state' });
  assert.equal(direct.status, 200); assert.equal(direct.body.agents.length, 5);
  const processRef = { argv: ['node', 'server.mjs'], env: {}, platform: 'linux', cwd: () => root,
    on() {}, off() {} };
  const started = await startHodUi({ process: processRef, output: { stdout: [] },
    argv: ['--runtime-only', '--no-open'], parseOptions: () => ({ port: 0, open: false, runtimeOnly: true }),
    resolveRuntimePaths: () => ({ publicRoot: root, herdrBin: 'herdr' }),
    createRuntimeOnly: () => runtime, randomBytes: (size) => Buffer.alloc(size, 1) });
  apps.push(started);
  const origin = started.origin;
  const token = decodeURIComponent(new URL(started.launchUrl).hash.slice('#token='.length));
  const boot = await request(started.httpServer, '/api/session', { method: 'POST', headers: { Origin: origin, 'X-HOD-Bootstrap': token } });
  const cookie = boot.headers.get('set-cookie').split(';', 1)[0];
  const state = await request(started.httpServer, '/api/state', { headers: { Cookie: cookie } });
  assert.equal(state.status, 200); assert.equal((await state.json()).agents.length, 5);
  const transcript = await request(started.httpServer, '/api/transcript/select', {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paneId: 'pane-1' }),
  });
  assert.equal(transcript.status, 200); assert.equal((await transcript.json()).text, 'selected');
});

test('exact loopback host/origin, one-time bootstrap, cookie reload, and API delegation', async () => {
  const { server, calls } = await app();
  const origin = `http://127.0.0.1:${server.port}`;
  const bootstrap = await request(server, '/api/session', { method: 'POST', headers: { Origin: origin, 'X-HOD-Bootstrap': 'bootstrap-only' } });
  assert.equal(bootstrap.status, 204);
  assert.match(bootstrap.headers.get('set-cookie'), /^hod_session=/);
  assert.equal((await request(server, '/api/session', { method: 'POST', headers: { Origin: origin, 'X-HOD-Bootstrap': 'bootstrap-only' } })).status, 401);
  const cookie = bootstrap.headers.get('set-cookie').split(';', 1)[0];
  assert.deepEqual(await (await request(server, '/api/state', { headers: { Cookie: cookie } })).json(), { ok: true });
  const saved = await request(server, '/api/settings/hod', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"role":"impl"}' });
  assert.equal(saved.status, 201);
  assert.deepEqual(calls.at(-1).body, { role: 'impl' });
});

test('rejects unauthenticated, wrong host/origin, and unsupported methods without CORS escape', async () => {
  const { server } = await app();
  const origin = `http://127.0.0.1:${server.port}`;
  assert.equal((await request(server, '/api/state')).status, 401);
  assert.equal((await rawRequest(server, '/', { Host: `localhost:${server.port}` })).statusCode, 400);
  assert.equal((await request(server, '/', { headers: { Origin: 'http://localhost' } })).status, 403);
  assert.equal((await request(server, '/', { method: 'OPTIONS', headers: { Origin: origin } })).status, 405);
});

test('rejects JSON type, malformed body, and byte-cap failures with stable errors', async () => {
  const { server } = await app();
  const origin = `http://127.0.0.1:${server.port}`;
  const boot = await request(server, '/api/session', { method: 'POST', headers: { Origin: origin, 'X-HOD-Bootstrap': 'bootstrap-only' } });
  const cookie = boot.headers.get('set-cookie').split(';', 1)[0];
  const base = { method: 'POST', headers: { Origin: origin, Cookie: cookie } };
  for (const [headers, body, status, code] of [
    [{}, '{}', 415, 'ERR_UNSUPPORTED_MEDIA_TYPE'],
    [{ 'Content-Type': 'application/json' }, '{', 400, 'ERR_INVALID_JSON'],
    [{ 'Content-Type': 'text/plain' }, '{}', 415, 'ERR_UNSUPPORTED_MEDIA_TYPE'],
  ]) {
    const response = await request(server, '/api/settings/hod', { ...base, headers: { ...base.headers, ...headers }, body });
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
  }
  const huge = await request(server, '/api/settings/hod', { ...base, headers: { ...base.headers, 'Content-Type': 'application/json' }, body: `{"role":"${'x'.repeat(33 * 1024)}"}` });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error.code, 'ERR_BODY_TOO_LARGE');
});

test('static GET/HEAD and SSE handshake/cleanup work over real loopback HTTP', async () => {
  const { server, hub } = await app();
  const get = await request(server, '/');
  assert.equal(get.status, 200); assert.equal(await get.text(), '<main>loopback</main>');
  assert.equal(get.headers.get('cache-control'), 'no-store');
  const head = await request(server, '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const boot = await request(server, '/api/session', { method: 'POST', headers: { Origin: `http://127.0.0.1:${server.port}`, 'X-HOD-Bootstrap': 'bootstrap-only' } });
  const cookie = boot.headers.get('set-cookie').split(';', 1)[0];
  const eventResponse = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } });
  assert.equal(eventResponse.status, 200); assert.equal(hub.clientCount, 1);
  await eventResponse.body.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hub.clientCount, 0);
});
