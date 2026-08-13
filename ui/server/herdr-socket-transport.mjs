import { EventEmitter } from 'node:events';
import net from 'node:net';

import {
  MAX_LINE_BYTES,
  NdjsonFrameDecoder,
  NdjsonFrameError,
} from './ndjson-frame-decoder.mjs';

export const SOCKET_STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSING: 'closing',
});

function transportError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export class HerdrSocketTransport extends EventEmitter {
  constructor(socketPath, maxLineBytes = MAX_LINE_BYTES) {
    super();
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new TypeError('socketPath must be a non-empty Unix socket path');
    }
    this.socketPath = socketPath;
    this.status = SOCKET_STATUS.DISCONNECTED;
    this.lastError = null;
    this._socket = null;
    this._connectPromise = null;
    this._connectReject = null;
    this._closeReason = null;
    this._decoder = new NdjsonFrameDecoder(maxLineBytes);
    this.maxLineBytes = this._decoder.maxLineBytes;
  }

  connect() {
    if (this.status === SOCKET_STATUS.CONNECTED) return Promise.resolve(this);
    if (this.status === SOCKET_STATUS.CONNECTING) return this._connectPromise;
    if (this._socket) return this.disconnect().then(() => this.connect());

    this.lastError = null;
    this._setStatus(SOCKET_STATUS.CONNECTING);
    const socket = net.createConnection({ path: this.socketPath });
    this._socket = socket;
    let connected = false;
    let settled = false;
    let promise;
    promise = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (this._connectPromise === promise) this._connectPromise = null;
        this._connectReject = null;
        if (error) reject(error);
        else resolve(this);
      };

      this._connectReject = finish;
      socket.once('connect', () => {
        connected = true;
        this._setStatus(SOCKET_STATUS.CONNECTED);
        finish();
      });
      socket.on('data', (chunk) => this._receive(chunk));
      socket.on('error', (error) => {
        this.lastError = error;
        this.emit('socket-error', error);
        if (!connected) {
          finish(error);
          socket.destroy();
        }
      });
      socket.once('close', () => this._handleClose(socket, connected));
    });
    this._connectPromise = promise;
    return promise;
  }

  writeLine(line, onError) {
    if (this.status !== SOCKET_STATUS.CONNECTED || !this._socket) {
      onError?.(transportError('ERR_NOT_CONNECTED', 'Herdr socket is not connected'));
      return false;
    }
    try {
      this._socket.write(`${line}\n`, (error) => {
        if (!error) return;
        const writeError = transportError('ERR_SOCKET_WRITE', 'Failed to write Herdr request', error);
        this.lastError = error;
        onError?.(writeError);
        this._socket?.destroy();
      });
      return true;
    } catch (error) {
      const writeError = transportError('ERR_SOCKET_WRITE', 'Failed to write Herdr request', error);
      this.lastError = error;
      onError?.(writeError);
      this._socket?.destroy();
      return false;
    }
  }

  async disconnect(reason = transportError('ERR_SOCKET_DISCONNECTED', 'Herdr socket disconnected')) {
    const error = reason instanceof Error ? reason : transportError('ERR_SOCKET_DISCONNECTED', String(reason));
    const socket = this._socket;
    this._closeReason = error;
    if (!socket) {
      this._setStatus(SOCKET_STATUS.DISCONNECTED, error);
      return;
    }
    this._setStatus(SOCKET_STATUS.CLOSING, error);
    await new Promise((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    });
  }

  close(reason) {
    return this.disconnect(reason);
  }

  _setStatus(status, error) {
    if (this.status === status) return;
    const previous = this.status;
    this.status = status;
    this.emit('status', status, { previous, error });
    this.emit('state', status, { previous, error });
  }

  _receive(chunk) {
    try {
      for (const frame of this._decoder.push(chunk)) this.emit('frame', frame);
    } catch (error) {
      const protocolError = error instanceof NdjsonFrameError
        ? transportError(error.code, error.message, error)
        : transportError('ERR_PROTOCOL', 'Invalid Herdr JSON frame', error);
      this.lastError = protocolError;
      this.emit('protocol-error', protocolError);
      this._socket?.destroy();
    }
  }

  _handleClose(socket, connected) {
    if (this._socket !== socket) return;
    this._socket = null;
    const incomplete = this._decoder.hasPartialFrame;
    this._decoder.reset();
    const error = this._closeReason
      || (incomplete ? transportError('ERR_PROTOCOL', 'Herdr socket closed with an incomplete frame') : null)
      || this.lastError
      || transportError('ERR_SOCKET_DISCONNECTED', 'Herdr socket disconnected');
    this._closeReason = null;
    if (!connected && this._connectReject) this._connectReject(error);
    this._connectReject = null;
    this._setStatus(SOCKET_STATUS.DISCONNECTED, error);
    this.emit('close', error);
  }
}
