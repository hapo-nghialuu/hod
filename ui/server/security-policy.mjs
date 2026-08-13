// Pure policy helpers for the loopback HTTP boundary. The caller must pass
// the actual port selected by the listening server; a loopback bind alone is
// not an authorization boundary.

import { timingSafeEqual } from 'node:crypto';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cache-Control': 'no-store',
});

function validPort(port) {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

export function advertisedHost(port) {
  if (!validPort(port)) throw new TypeError('port must be an integer in 0..65535');
  return `127.0.0.1:${port}`;
}

export function expectedOrigin(port) {
  return `http://${advertisedHost(port)}`;
}

export function isAllowedHost(host, port) {
  return typeof host === 'string' && validPort(port) && host === advertisedHost(port);
}

export function isExpectedOrigin(origin, port) {
  return typeof origin === 'string' && validPort(port) && origin === expectedOrigin(port);
}

// Retain the standalone loopback predicate for callers that need a hostname
// check. Request authorization must use isAllowedHost() instead.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export function isLoopbackHost(host, port) {
  if (port !== undefined) return isAllowedHost(host, port);
  return typeof host === 'string' && LOOPBACK_HOSTS.has(host);
}

// Exact-origin validation requires the runtime port. Safe requests that may
// omit Origin must use requestPolicy(), never this helper with a missing port.
export function isAllowedOrigin(origin, port) {
  return isExpectedOrigin(origin, port);
}

export function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

export function requestPolicy({ host, origin, method = 'GET', port } = {}) {
  if (!isAllowedHost(host, port)) return false;
  return isSafeMethod(method) ? origin === undefined || isExpectedOrigin(origin, port)
    : isExpectedOrigin(origin, port);
}

export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(value.replace(/^"|"$/g, '')); } catch { /* skip */ }
  }
  return out;
}

export function securityHeaders() {
  return { ...SECURITY_HEADERS };
}
