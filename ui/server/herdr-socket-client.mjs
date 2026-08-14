import { EventEmitter } from 'node:events';

import { MAX_LINE_BYTES } from './ndjson-frame-decoder.mjs';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HerdrRequestRegistry,
} from './herdr-request-registry.mjs';
import { HerdrSocketTransport, SOCKET_STATUS } from './herdr-socket-transport.mjs';

export { MAX_LINE_BYTES } from './ndjson-frame-decoder.mjs';
export { DEFAULT_REQUEST_TIMEOUT_MS, MAX_PENDING_REQUESTS } from './herdr-request-registry.mjs';
export { SOCKET_STATUS } from './herdr-socket-transport.mjs';

export class HerdrSocketError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'HerdrSocketError';
    this.code = code;
  }
}

function socketError(code, message, cause) {
  return new HerdrSocketError(code, message, cause ? { cause } : undefined);
}

function responseError(body) {
  const code = typeof body?.code === 'string' ? body.code : 'ERR_HERDR_RESPONSE';
  const message = typeof body?.message === 'string' ? body.message : 'Herdr request failed';
  return socketError(code, message);
}

export class HerdrSocketClient extends EventEmitter {
  constructor({
    socketPath,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxLineBytes = MAX_LINE_BYTES,
  } = {}) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lastError = null;
    this._transport = new HerdrSocketTransport(socketPath, maxLineBytes);
    this.maxLineBytes = this._transport.maxLineBytes;
    this._requests = new HerdrRequestRegistry(requestTimeoutMs);
    this._bindTransport();
  }

  get status() {
    return this._transport.status;
  }

  get state() {
    return this.status;
  }

  get pendingCount() {
    return this._requests.size;
  }

  onEvent(callback) {
    this.on('event', callback);
    return () => this.off('event', callback);
  }

  onStatus(callback) {
    this.on('status', callback);
    return () => this.off('status', callback);
  }

  connect() {
    return this._transport.connect().then(() => this);
  }

  request(method, params = {}, options = {}) {
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(socketError('ERR_INVALID_REQUEST', 'method must be a non-empty string'));
    }
    if (this.status !== SOCKET_STATUS.CONNECTED) {
      return Promise.reject(socketError('ERR_NOT_CONNECTED', 'Herdr socket is not connected'));
    }
    const timeoutMs = typeof options === 'number'
      ? options
      : (options?.timeoutMs ?? this.requestTimeoutMs);
    let request;
    try {
      request = this._requests.register(timeoutMs);
    } catch (error) {
      return Promise.reject(socketError(error.code, error.message, error));
    }

    let line;
    try {
      line = JSON.stringify({ id: request.id, method, params });
    } catch (error) {
      const requestError = socketError('ERR_INVALID_REQUEST', 'Request params are not JSON-serializable', error);
      this._requests.reject(request.id, requestError);
      return request.promise;
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      const requestError = socketError('ERR_LINE_TOO_LARGE', 'Herdr request exceeds the line limit');
      this._requests.reject(request.id, requestError);
      return request.promise;
    }

    this._transport.writeLine(line, (error) => this._requests.reject(request.id, error));
    return request.promise;
  }

  async disconnect(reason = socketError('ERR_SOCKET_DISCONNECTED', 'Herdr socket disconnected')) {
    const error = reason instanceof Error ? reason : socketError('ERR_SOCKET_DISCONNECTED', String(reason));
    this._requests.rejectAll(error);
    await this._transport.disconnect(error);
  }

  close(reason) {
    return this.disconnect(reason);
  }

  _bindTransport() {
    this._transport.on('frame', (frame) => this._handleFrame(frame));
    this._transport.on('status', (status, details) => {
      if (details?.error) this.lastError = details.error;
      this.emit('status', status, details);
      this.emit('state', status, details);
    });
    this._transport.on('socket-error', (error) => {
      this.lastError = error;
      this.emit('socket-error', error);
    });
    this._transport.on('protocol-error', (error) => this._fail(error));
    this._transport.on('close', (error) => {
      this.lastError = error;
      this._requests.rejectAll(error);
      this.emit('close', error);
    });
  }

  _handleFrame({ kind, value }) {
    if (kind === 'event') {
      try {
        this.emit('event', value);
      } catch (error) {
        this.emit('event-error', error);
      }
      return;
    }
    if (kind === 'success') this._requests.resolve(value.id, value.result);
    else this._requests.reject(value.id, responseError(value.error));
  }

  _fail(error) {
    this.lastError = error;
    this.emit('protocol-error', error);
    this._requests.rejectAll(error);
  }
}
