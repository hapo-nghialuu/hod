import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { parseCookies, secureEqual } from './security-policy.mjs';

export const SESSION_COOKIE_NAME = 'hod_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60;
export const DEFAULT_TOKEN_BYTES = 32;

function randomToken(randomBytes, size) {
  const bytes = randomBytes(size);
  if (!Buffer.isBuffer(bytes)) throw new TypeError('randomBytes must return a Buffer');
  return bytes.toString('base64url');
}

function cookieValue(token, maxAge) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function cookieHeader(request) {
  if (typeof request === 'string') return request;
  return request?.headers?.cookie ?? request?.headers?.Cookie;
}

export class SessionAuth {
  constructor({
    bootstrapToken,
    cookieName = SESSION_COOKIE_NAME,
    maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
    tokenBytes = DEFAULT_TOKEN_BYTES,
    randomBytes = nodeRandomBytes,
    now = () => Date.now(),
  } = {}) {
    if (typeof bootstrapToken !== 'string' || bootstrapToken.length === 0) {
      throw new TypeError('bootstrapToken must be a non-empty string');
    }
    if (typeof cookieName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) {
      throw new TypeError('cookieName is invalid');
    }
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new TypeError('maxAgeSeconds must be a positive safe integer');
    }
    if (!Number.isSafeInteger(tokenBytes) || tokenBytes < 16) {
      throw new TypeError('tokenBytes must be at least 16');
    }
    if (typeof randomBytes !== 'function' || typeof now !== 'function') {
      throw new TypeError('randomBytes and now must be functions');
    }
    this.bootstrapToken = bootstrapToken;
    this.cookieName = cookieName;
    this.maxAgeSeconds = maxAgeSeconds;
    this.tokenBytes = tokenBytes;
    this._randomBytes = randomBytes;
    this._now = now;
    this._bootstrapUsed = false;
    this._sessionToken = null;
    this._expiresAt = 0;
  }

  exchangeBootstrapToken(candidate) {
    if (this._bootstrapUsed || !secureEqual(candidate, this.bootstrapToken)) return null;
    const token = randomToken(this._randomBytes, this.tokenBytes);
    this._bootstrapUsed = true;
    this._sessionToken = token;
    this._expiresAt = this._now() + this.maxAgeSeconds * 1000;
    const setCookie = this._setCookie(token);
    return { authenticated: true, sessionToken: token, token, setCookie };
  }

  exchange(candidate) {
    return this.exchangeBootstrapToken(candidate);
  }

  _setCookie(token) {
    return cookieValue(token, this.maxAgeSeconds).replace(`${SESSION_COOKIE_NAME}=`, `${this.cookieName}=`);
  }

  isAuthorized(request) {
    if (!this._sessionToken || this._now() >= this._expiresAt) return false;
    const cookies = parseCookies(cookieHeader(request));
    return secureEqual(cookies[this.cookieName], this._sessionToken);
  }

  authenticate(request) {
    return this.isAuthorized(request);
  }

  get sessionToken() {
    return this._sessionToken;
  }

  get bootstrapUsed() {
    return this._bootstrapUsed;
  }
}

export function createSessionAuth(options) {
  return new SessionAuth(options);
}

export function serializeSessionCookie(token, maxAge = SESSION_MAX_AGE_SECONDS) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('token is required');
  return cookieValue(token, maxAge);
}
