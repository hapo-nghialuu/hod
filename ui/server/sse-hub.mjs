import { securityHeaders } from './security-policy.mjs';

export const MAX_SSE_CLIENTS = 16;
export const MAX_SSE_EVENT_BYTES = 24 * 1024 * 1024;
export const MAX_SSE_WRITABLE_BYTES = 32 * 1024 * 1024;
export const SSE_HEARTBEAT_MS = 15_000;

function eventName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name)) {
    throw Object.assign(new Error('invalid SSE event name'), { code: 'ERR_SSE_EVENT_NAME' });
  }
}

export function formatSseEvent(name, payload, maxBytes = MAX_SSE_EVENT_BYTES) {
  eventName(name);
  let json;
  try { json = JSON.stringify(payload); } catch { throw Object.assign(new Error('SSE payload is not JSON'), { code: 'ERR_SSE_PAYLOAD' }); }
  if (json === undefined) throw Object.assign(new Error('SSE payload is not JSON'), { code: 'ERR_SSE_PAYLOAD' });
  const frame = `event: ${name}\ndata: ${json}\n\n`;
  if (Buffer.byteLength(frame) > maxBytes) {
    throw Object.assign(new Error('SSE event is too large'), { code: 'ERR_SSE_EVENT_LARGE' });
  }
  return frame;
}

function writableLength(response) {
  return Number.isFinite(response?.writableLength) && response.writableLength >= 0
    ? response.writableLength : 0;
}

export class SseHub {
  constructor({
    maxClients = MAX_SSE_CLIENTS,
    maxEventBytes = MAX_SSE_EVENT_BYTES,
    maxWritableBytes = MAX_SSE_WRITABLE_BYTES,
    heartbeatMs = SSE_HEARTBEAT_MS,
    timers = globalThis,
  } = {}) {
    if (!Number.isSafeInteger(maxClients) || maxClients < 1) throw new TypeError('maxClients is invalid');
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new TypeError('maxEventBytes is invalid');
    if (!Number.isSafeInteger(maxWritableBytes) || maxWritableBytes < 1) throw new TypeError('maxWritableBytes is invalid');
    this.maxClients = maxClients;
    this.maxEventBytes = maxEventBytes;
    this.maxWritableBytes = maxWritableBytes;
    this.clients = new Map();
    this.closed = false;
    this._setInterval = (timers.setInterval ?? setInterval).bind(timers);
    this._clearInterval = (timers.clearInterval ?? clearInterval).bind(timers);
    this._heartbeatTimer = this._setInterval(() => this.heartbeat(), heartbeatMs);
    this._heartbeatTimer?.unref?.();
  }

  get clientCount() { return this.clients.size; }

  addClient(response) {
    if (this.closed || !response || typeof response.write !== 'function') return false;
    if (this.clients.size >= this.maxClients) {
      response.writeHead?.(503, { ...securityHeaders(), 'Content-Length': '0', 'Retry-After': '1' });
      response.end?.();
      return false;
    }
    const onClose = () => this.removeClient(response);
    const onError = () => this.removeClient(response);
    response.on?.('close', onClose);
    response.on?.('error', onError);
    this.clients.set(response, { onClose, onError });
    if (!response.headersSent) {
      response.writeHead?.(200, {
        ...securityHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      response.flushHeaders?.();
    }
    this._write(response, ': connected\n\n');
    return this.clients.has(response);
  }

  connect(response) { return this.addClient(response); }

  removeClient(response) {
    const record = this.clients.get(response);
    if (!record) return false;
    this.clients.delete(response);
    response.off?.('close', record.onClose);
    response.off?.('error', record.onError);
    response.removeListener?.('close', record.onClose);
    response.removeListener?.('error', record.onError);
    return true;
  }

  _disconnect(response) {
    this.removeClient(response);
    try { if (!response.writableEnded) response.end?.(); } catch { response.destroy?.(); }
  }

  _write(response, frame) {
    if (!this.clients.has(response) || response.destroyed || response.writableEnded) return false;
    if (writableLength(response) > this.maxWritableBytes) { this._disconnect(response); return false; }
    try { response.write(frame); } catch { this._disconnect(response); return false; }
    if (writableLength(response) > this.maxWritableBytes) this._disconnect(response);
    return this.clients.has(response);
  }

  heartbeat() {
    for (const response of [...this.clients.keys()]) this._write(response, ': heartbeat\n\n');
  }

  publish(name, payload) {
    let frame;
    try {
      frame = formatSseEvent(name, payload, this.maxEventBytes);
    } catch (error) {
      if (error?.code !== 'ERR_SSE_EVENT_LARGE') throw error;
      // A bounded signal lets the browser fetch authoritative state instead of
      // waiting forever after an oversized state/transcript frame.
      frame = formatSseEvent('resync', { gap: true, event: name }, this.maxEventBytes);
    }
    let delivered = 0;
    for (const response of [...this.clients.keys()]) if (this._write(response, frame)) delivered += 1;
    return delivered;
  }

  broadcast(name, payload) { return this.publish(name, payload); }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._heartbeatTimer !== null) this._clearInterval(this._heartbeatTimer);
    for (const response of [...this.clients.keys()]) {
      this.removeClient(response);
      try { if (!response.writableEnded) response.end?.(); } catch { response.destroy?.(); }
    }
    this.clients.clear();
  }

  cleanup() { this.close(); }
}

export function createSseHub(options) {
  return new SseHub(options);
}

export const SSEHub = SseHub;
export const createSSEHub = createSseHub;
