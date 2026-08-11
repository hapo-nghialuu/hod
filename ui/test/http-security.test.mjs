import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CSP,
  PERMISSIONS_POLICY,
  SECURITY_HEADERS,
  advertisedHost,
  expectedOrigin,
  isAllowedHost,
  isAllowedOrigin,
  isExpectedOrigin,
  isLoopbackHost,
  parseCookies,
  requestPolicy,
  secureEqual,
} from '../server/security-policy.mjs';

test('security headers close script, framing, referrer, and cache escape hatches', () => {
  assert.ok(CSP.includes("default-src 'none'"));
  assert.ok(CSP.includes("script-src 'self'"));
  assert.ok(CSP.includes("connect-src 'self'"));
  assert.ok(!CSP.includes('unsafe-inline'));
  assert.ok(!CSP.includes('unsafe-eval'));
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['Permissions-Policy'], PERMISSIONS_POLICY);
  assert.equal(SECURITY_HEADERS['Cache-Control'], 'no-store');
});

test('advertised Host is exact and never accepts aliases or forwarded ports', () => {
  assert.equal(advertisedHost(4317), '127.0.0.1:4317');
  assert.equal(isAllowedHost('127.0.0.1:4317', 4317), true);
  for (const host of ['localhost:4317', '127.0.0.1', '127.0.0.1:4318', '[::1]:4317', 'evil:4317']) {
    assert.equal(isAllowedHost(host, 4317), false, host);
  }
  assert.throws(() => advertisedHost(65536), /port/);
});

test('mutations require exact HTTP Origin while safe reads may omit it', () => {
  assert.equal(expectedOrigin(4317), 'http://127.0.0.1:4317');
  assert.equal(isExpectedOrigin('http://127.0.0.1:4317', 4317), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4317', 4317), true);
  assert.equal(isAllowedOrigin(undefined), false);
  for (const origin of [undefined, 'null', 'http://localhost:4317', 'https://127.0.0.1:4317', 'http://127.0.0.1:4318']) {
    assert.equal(isAllowedOrigin(origin, 4317), false, String(origin));
  }
  const host = '127.0.0.1:4317';
  assert.equal(requestPolicy({ host, method: 'GET', port: 4317 }), true);
  assert.equal(requestPolicy({ host, method: 'HEAD', port: 4317 }), true);
  assert.equal(requestPolicy({ host, method: 'POST', port: 4317 }), false);
  assert.equal(requestPolicy({ host, origin: expectedOrigin(4317), method: 'POST', port: 4317 }), true);
  assert.equal(requestPolicy({ host: 'localhost:4317', origin: expectedOrigin(4317), method: 'POST', port: 4317 }), false);
});

test('standalone loopback and cookie helpers remain strict and non-throwing', () => {
  for (const good of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLoopbackHost(good), true);
  for (const bad of ['example.com', 'evil.localhost', '127.0.0.1.attacker.net', '']) assert.equal(isLoopbackHost(bad), false);
  assert.equal(secureEqual('abc', 'abc'), true);
  assert.equal(secureEqual('abc', 'abd'), false);
  assert.equal(secureEqual('abc', 'ab'), false);
  assert.deepEqual(parseCookies('a=1; b=hello%20world; bad=%zz'), { a: '1', b: 'hello world' });
});
