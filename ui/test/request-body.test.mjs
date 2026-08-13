import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  MAX_REQUEST_BODY_BYTES,
  acceptsJsonContentType,
  readJsonBody,
} from '../server/request-body.mjs';

class BodyRequest extends EventEmitter {
  constructor(headers, chunks = []) {
    super();
    this.headers = headers;
    this.chunks = chunks;
    this.destroyed = false;
    this.resumed = false;
  }
  resume() { this.resumed = true; }
  emitBody() {
    for (const chunk of this.chunks) this.emit('data', chunk);
    this.emit('end');
  }
}

async function parse(headers, body, chunks = [Buffer.from(body)]) {
  const request = new BodyRequest(headers, chunks);
  const result = readJsonBody(request);
  queueMicrotask(() => request.emitBody());
  return { request, result };
}

test('accepts application/json with optional UTF-8 charset only', () => {
  assert.equal(acceptsJsonContentType('application/json'), true);
  assert.equal(acceptsJsonContentType('application/json; charset=UTF-8'), true);
  for (const type of [undefined, 'text/plain', 'application/json; charset=latin1', 'application/json; foo=bar']) {
    assert.equal(acceptsJsonContentType(type), false);
  }
});

test('reads an object incrementally and rejects JSON primitives', async () => {
  const parsed = await parse({ 'content-type': 'application/json', 'content-length': '11' }, '{"ok":true}');
  assert.deepEqual(await parsed.result, { ok: true });
  const primitive = await parse({ 'content-type': 'application/json' }, '[]');
  await assert.rejects(primitive.result, { code: 'ERR_INVALID_BODY', status: 400 });
});

test('rejects missing media type, invalid JSON, and bodies above the byte cap', async () => {
  const missing = await parse({}, '{}');
  await assert.rejects(missing.result, { code: 'ERR_UNSUPPORTED_MEDIA_TYPE', status: 415 });
  const invalid = await parse({ 'content-type': 'application/json' }, '{');
  await assert.rejects(invalid.result, { code: 'ERR_INVALID_JSON', status: 400 });
  const tooLarge = new BodyRequest({ 'content-type': 'application/json', 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) });
  await assert.rejects(readJsonBody(tooLarge), { code: 'ERR_BODY_TOO_LARGE', status: 413 });
  assert.equal(tooLarge.resumed, true);
});

test('aborted streams reject and clean up without leaking raw errors', async () => {
  const request = new BodyRequest({ 'content-type': 'application/json' });
  const result = readJsonBody(request);
  request.emit('aborted');
  await assert.rejects(result, { code: 'ERR_REQUEST_ABORTED', status: 400, message: 'Request body was interrupted' });
  assert.equal(request.listenerCount('data'), 0);
  assert.equal(request.listenerCount('close'), 0);
});
