import { createServer as nodeCreateServer } from 'node:http';

import {
  expectedOrigin,
  isAllowedHost,
  requestPolicy,
  securityHeaders,
} from './security-policy.mjs';
import { SessionAuth } from './session-auth.mjs';
import { StaticFileServer } from './static-files.mjs';
import { SseHub } from './sse-hub.mjs';
import { readJsonBody, RequestBodyError } from './request-body.mjs';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 0;

const SAFE_ERRORS = Object.freeze({
  ERR_INVALID_HOST: 'Host is invalid', ERR_INVALID_ORIGIN: 'Origin is not allowed',
  ERR_UNAUTHORIZED: 'Authentication required', ERR_BOOTSTRAP: 'Bootstrap token is invalid',
  ERR_METHOD_NOT_ALLOWED: 'Method is not allowed', ERR_API: 'Unable to handle API request',
  ERR_STATIC: 'Static resource is unavailable', ERR_STATIC_PATH: 'Static path is invalid',
});
const API_GET_ROUTES = new Set(['/api/state', '/api/settings']);
const API_POST_ROUTES = new Set(['/api/transcript/select', '/api/settings/hod', '/api/settings/herdr']);

function errorBody(code, message = SAFE_ERRORS[code] ?? 'Request failed') {
  return { error: { code, message } };
}

function sendJson(response, method, status, body) {
  if (response.writableEnded || response.destroyed || response.headersSent) return false;
  let payload;
  try { payload = Buffer.from(JSON.stringify(body)); }
  catch { status = 500; payload = Buffer.from(JSON.stringify(errorBody('ERR_API'))); }
  try {
    response.writeHead(status, {
      ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(payload.byteLength),
    });
    response.end(method === 'HEAD' ? undefined : payload);
    return true;
  } catch { response.destroy?.(); return false; }
}

function sendError(response, method, status, code) {
  return sendJson(response, method, status, errorBody(code));
}

function sendEmpty(response, status, headers = {}) {
  if (response.writableEnded || response.destroyed || response.headersSent) return false;
  try {
    response.writeHead(status, { ...securityHeaders(), 'Content-Length': '0', ...headers });
    response.end();
    return true;
  } catch { response.destroy?.(); return false; }
}

function pathOf(request) {
  try { return new URL(request.url ?? '/', 'http://hod.local').pathname; } catch { return null; }
}

function isApiPath(pathname) { return pathname === '/api' || pathname?.startsWith('/api/'); }
function forwardedHost(headers) { return headers?.['x-forwarded-host'] !== undefined || headers?.forwarded !== undefined; }

function staticError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 404;
  const code = typeof error?.code === 'string' && /^ERR_STATIC_[A-Z_]+$/.test(error.code)
    ? (SAFE_ERRORS[error.code] ? error.code : 'ERR_STATIC') : 'ERR_STATIC';
  return { status, code };
}

export function createHttpServer(options = {}) {
  const auth = options.sessionAuth ?? options.auth
    ?? (typeof options.bootstrapToken === 'string' ? new SessionAuth({ bootstrapToken: options.bootstrapToken }) : null);
  if (!auth || typeof auth.isAuthorized !== 'function'
    || (typeof auth.exchangeBootstrapToken !== 'function' && typeof auth.exchange !== 'function')) {
    throw new TypeError('sessionAuth is required');
  }
  const staticServer = options.staticFileServer ?? options.static
    ?? (options.publicRoot || options.rootDirectory ? new StaticFileServer({ rootDirectory: options.publicRoot ?? options.rootDirectory }) : null);
  const hub = options.sseHub ?? options.events ?? new SseHub();
  const controller = options.apiController ?? options.controller ?? { async handle() { return null; } };
  const handleApi = controller.handle ?? controller.handleRequest ?? controller.route;
  if (typeof handleApi !== 'function') throw new TypeError('apiController is required');
  const createServer = options.createServer ?? nodeCreateServer;
  if (typeof createServer !== 'function') throw new TypeError('createServer must be a function');

  let actualPort = null;
  let hubClosed = false;
  const closeHub = () => { if (!hubClosed) { hubClosed = true; hub.close?.(); } };
  let server;

  const requestHandler = async (request, response) => {
    const address = server.address?.();
    const port = actualPort ?? (address && typeof address === 'object' ? address.port : null);
    const host = request.headers?.host;
    if (!Number.isInteger(port) || !isAllowedHost(host, port) || forwardedHost(request.headers)) {
      sendError(response, request.method, 400, 'ERR_INVALID_HOST'); return;
    }
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    if (!requestPolicy({ host, origin: request.headers?.origin, method, port })) {
      sendError(response, method, 403, 'ERR_INVALID_ORIGIN'); return;
    }
    const pathname = pathOf(request);
    if (!pathname) { sendError(response, method, 400, 'ERR_API'); return; }
    if (pathname === '/api/session') {
      if (method !== 'POST') { sendError(response, method, 405, 'ERR_METHOD_NOT_ALLOWED'); return; }
      request.resume?.();
      const candidate = request.headers?.['x-hod-bootstrap'];
      const exchange = (auth.exchangeBootstrapToken ?? auth.exchange).call(auth, candidate);
      if (!exchange) { sendError(response, method, 401, 'ERR_BOOTSTRAP'); return; }
      sendEmpty(response, 204, { 'Set-Cookie': exchange.setCookie });
      return;
    }
    if (isApiPath(pathname)) {
      const known = new Set(['/api/events', ...API_GET_ROUTES, ...API_POST_ROUTES]);
      if (!auth.isAuthorized(request)) { sendError(response, method, 401, 'ERR_UNAUTHORIZED'); return; }
      if (pathname === '/api/events') {
        if (method !== 'GET') { sendError(response, method, 405, 'ERR_METHOD_NOT_ALLOWED'); return; }
        const cleanup = () => {
          hub.removeClient?.(response);
          request.off?.('aborted', cleanup); request.off?.('close', cleanup); response.off?.('close', cleanup);
        };
        request.once?.('aborted', cleanup); request.once?.('close', cleanup); response.once?.('close', cleanup);
        if (!hub.addClient(response)) cleanup();
        return;
      }
      if (!known.has(pathname)) { sendError(response, method, 404, 'ERR_API_NOT_FOUND'); return; }
      if ((API_GET_ROUTES.has(pathname) && method !== 'GET') || (API_POST_ROUTES.has(pathname) && method !== 'POST')) {
        sendError(response, method, 405, 'ERR_METHOD_NOT_ALLOWED'); return;
      }
      let body;
      if (method === 'POST') {
        try { body = await readJsonBody(request); }
        catch (error) {
          const safe = error instanceof RequestBodyError ? error : new RequestBodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body');
          sendJson(response, method, safe.status, errorBody(safe.code, safe.message)); return;
        }
      }
      try {
        const result = await handleApi.call(controller, { method, path: request.url, body });
        if (!result) { sendError(response, method, 404, 'ERR_API_NOT_FOUND'); return; }
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
          sendError(response, method, 500, 'ERR_API'); return;
        }
        sendJson(response, method, result.status, result.body);
      } catch { sendError(response, method, 500, 'ERR_API'); }
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') { sendError(response, method, 405, 'ERR_METHOD_NOT_ALLOWED'); return; }
    if (!staticServer || typeof staticServer.read !== 'function') { sendError(response, method, 404, 'ERR_STATIC'); return; }
    try {
      const result = await staticServer.read(request.url, method);
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(result.status, { ...securityHeaders(), ...(result.headers ?? {}) });
      response.end(method === 'HEAD' ? undefined : result.body ?? undefined);
    } catch (error) { const safe = staticError(error); sendError(response, method, safe.status, safe.code); }
  };

  server = createServer((request, response) => { requestHandler(request, response).catch(() => sendError(response, request.method, 500, 'ERR_API')); });
  server.once?.('close', closeHub);

  const listen = (port = options.port ?? DEFAULT_HTTP_PORT, callback) => {
    if (typeof port === 'function') { callback = port; port = options.port ?? DEFAULT_HTTP_PORT; }
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer in 0..65535');
    const promise = Promise.resolve().then(() => staticServer?.load?.()).then(() => new Promise((resolve, reject) => {
      const onError = (error) => { reject(error); };
      const onListening = () => {
        server.off?.('error', onError); const address = server.address?.(); actualPort = address?.port;
        resolve({ host: LOOPBACK_HOST, port: actualPort, origin: expectedOrigin(actualPort) });
      };
      server.once?.('error', onError);
      server.listen(port, LOOPBACK_HOST, onListening);
    }));
    return promise.then((value) => { callback?.(); return value; }, (error) => { callback?.(error); throw error; });
  };
  const close = (callback) => {
    closeHub();
    const promise = new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      try { server.close((error) => error ? reject(error) : resolve()); } catch (error) { reject(error); }
    });
    return callback ? promise.then(() => callback(), callback) : promise;
  };
  return {
    server, httpServer: server, listen, start: listen, close, address: () => server.address?.(),
    requestHandler, sessionAuth: auth, apiController: controller, sseHub: hub,
    get port() { return actualPort; }, get listening() { return Boolean(server.listening); },
  };
}

export async function startHttpServer(options = {}) {
  const app = createHttpServer(options);
  await app.listen(options.port ?? DEFAULT_HTTP_PORT);
  return app;
}

export const createLocalHttpServer = createHttpServer;
