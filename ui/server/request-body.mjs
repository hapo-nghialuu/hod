export const MAX_REQUEST_BODY_BYTES = 32 * 1024;
export const MAX_JSON_BODY_BYTES = MAX_REQUEST_BODY_BYTES;

export class RequestBodyError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.status = status;
  }
}

function bodyError(code, status, message) {
  return new RequestBodyError(code, status, message);
}

function resume(request) {
  try { request.resume?.(); } catch { /* request may already be closed */ }
}

function contentLength(headers) {
  const value = headers?.['content-length'] ?? headers?.['Content-Length'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

export function acceptsJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;
  let charsetSeen = false;
  for (const parameter of parts) {
    if (!parameter) return false;
    const separator = parameter.indexOf('=');
    if (separator <= 0 || parameter.slice(0, separator).trim().toLowerCase() !== 'charset') return false;
    if (charsetSeen) return false;
    charsetSeen = true;
    const charset = parameter.slice(separator + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    if (charset !== 'utf-8') return false;
  }
  return true;
}

function cleanup(request, listeners) {
  for (const [event, listener] of listeners) {
    request.off?.(event, listener);
    request.removeListener?.(event, listener);
  }
}

export function readJsonBody(request, { maxBytes = MAX_REQUEST_BODY_BYTES } = {}) {
  if (!request || typeof request.on !== 'function') {
    return Promise.reject(bodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body'));
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const type = request.headers?.['content-type'] ?? request.headers?.['Content-Type'];
  if (!acceptsJsonContentType(type)) {
    resume(request);
    return Promise.reject(bodyError('ERR_UNSUPPORTED_MEDIA_TYPE', 415, 'Request must use application/json'));
  }
  const length = contentLength(request.headers);
  if (length < 0) {
    resume(request);
    return Promise.reject(bodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body'));
  }
  if (length !== null && length > maxBytes) {
    resume(request);
    return Promise.reject(bodyError('ERR_BODY_TOO_LARGE', 413, 'Request body is too large'));
  }

  return new Promise((resolve, reject) => {
    let total = 0;
    let ended = false;
    let settled = false;
    const chunks = [];
    const listeners = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup(request, listeners);
      if (error) { resume(request); reject(error); } else resolve(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      let buffer;
      try { buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); }
      catch { finish(bodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body')); return; }
      total += buffer.byteLength;
      if (total > maxBytes) {
        finish(bodyError('ERR_BODY_TOO_LARGE', 413, 'Request body is too large'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      ended = true;
      if (length !== null && total !== length) {
        finish(bodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body'));
        return;
      }
      let parsed;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
        parsed = JSON.parse(text);
      } catch { finish(bodyError('ERR_INVALID_JSON', 400, 'Request body is invalid JSON')); return; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(bodyError('ERR_INVALID_BODY', 400, 'Request body must be a JSON object'));
        return;
      }
      finish(null, parsed);
    };
    const onAborted = () => finish(bodyError('ERR_REQUEST_ABORTED', 400, 'Request body was interrupted'));
    const onError = () => finish(bodyError('ERR_REQUEST_BODY', 400, 'Unable to read request body'));
    const onClose = () => { if (!ended) onAborted(); };
    for (const [event, listener] of [['data', onData], ['end', onEnd], ['aborted', onAborted], ['error', onError], ['close', onClose]]) {
      listeners.push([event, listener]);
      request.on(event, listener);
    }
    if (request.destroyed) onAborted();
  });
}

export const parseJsonBody = readJsonBody;
