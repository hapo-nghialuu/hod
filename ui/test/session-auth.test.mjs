import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE_NAME,
  SessionAuth,
  createSessionAuth,
} from '../server/session-auth.mjs';

function fixedBytes(size) {
  return Buffer.alloc(size, 0xab);
}

test('bootstrap exchange is single-use and creates a random strict local cookie', () => {
  const auth = createSessionAuth({ bootstrapToken: 'boot-secret', randomBytes: fixedBytes });
  assert.equal(auth.exchange('wrong-token'), null);
  const result = auth.exchangeBootstrapToken('boot-secret');
  assert.equal(result.authenticated, true);
  assert.equal(result.sessionToken.length > 20, true);
  assert.equal(result.setCookie.startsWith(`${SESSION_COOKIE_NAME}=`), true);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Strict/);
  assert.match(result.setCookie, /Path=\//);
  assert.match(result.setCookie, /Max-Age=3600/);
  assert.equal(result.setCookie.includes('Secure'), false);
  assert.equal(result.setCookie.includes('boot-secret'), false);
  assert.equal(auth.exchange('boot-secret'), null);
  assert.equal(auth.bootstrapUsed, true);
});

test('the session cookie authorizes a later page reload without the bootstrap token', () => {
  let now = 1_000;
  const auth = new SessionAuth({
    bootstrapToken: 'one-time',
    randomBytes: fixedBytes,
    now: () => now,
  });
  const result = auth.exchange('one-time');
  const cookie = result.setCookie.split(';', 1)[0];
  assert.equal(auth.isAuthorized({ headers: { cookie } }), true);
  assert.equal(auth.authenticate({ headers: { Cookie: cookie } }), true);
  assert.equal(auth.isAuthorized({ headers: { cookie: `${cookie}; other=1` } }), true);
  now += 60 * 60 * 1000;
  assert.equal(auth.isAuthorized({ headers: { cookie } }), false);
});

test('invalid and altered cookies do not authorize', () => {
  const auth = new SessionAuth({ bootstrapToken: 'bootstrap', randomBytes: fixedBytes });
  const result = auth.exchange('bootstrap');
  const cookie = result.setCookie.split(';', 1)[0];
  assert.equal(auth.isAuthorized({ headers: { cookie: `${cookie}x` } }), false);
  assert.equal(auth.isAuthorized({ headers: { cookie: 'hod_session=not-the-token' } }), false);
  assert.equal(auth.isAuthorized({ headers: {} }), false);
});
