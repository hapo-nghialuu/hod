import { EventEmitter } from 'node:events';
import { HerdrSocketClient } from './herdr-socket-client.mjs';
import { TranscriptOneShotOperation } from './transcript-one-shot-operations.mjs';
import {
  limitTranscriptText, MAX_TRANSCRIPT_BYTES, isTranscriptTimeout,
  stableTranscriptError, TranscriptWatcherError, validatePaneRead,
} from './transcript-text-limit.mjs';
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_WAIT_TIMEOUT_MS + 5_000;
const MAX_RECENT_LINES = 4_096;
const PANE_READ_REQUEST = Object.freeze({ source: 'recent', lines: MAX_RECENT_LINES, format: 'ansi', strip_ansi: false });
function selectionError(selection) {
  return !selection || typeof selection !== 'object'
    || typeof selection.socketPath !== 'string' || selection.socketPath.trim() === ''
    || typeof selection.paneId !== 'string' || selection.paneId.trim() === '';
}
function sameTranscriptSnapshot(left, right) {
  return left !== null && right !== null
    && left.paneId === right.paneId && left.text === right.text
    && left.revision === right.revision && left.truncated === right.truncated
    && left.gap === right.gap && left.reconnecting === right.reconnecting
    && left.bridgeTruncated === right.bridgeTruncated;
}
function shouldRetryPolling(error) {
  return isTranscriptTimeout(error) || stableTranscriptError(error) === 'ERR_SOCKET_DISCONNECTED';
}
export class TranscriptWatcher extends EventEmitter {
  constructor({
    clientFactory,
    createClient,
    timers = globalThis,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    maxBytes = MAX_TRANSCRIPT_BYTES,
    pollIntervalMs = 1_000,
    retryMinMs = 250,
    retryMaxMs = 5_000,
  } = {}) {
    super();
    this._createClient = clientFactory ?? createClient
      ?? ((options) => new HerdrSocketClient(options));
    this._timers = timers;
    this._requestTimeoutMs = Math.max(requestTimeoutMs, waitTimeoutMs + 1_000);
    this._maxBytes = maxBytes;
    this._pollIntervalMs = pollIntervalMs;
    this._retryMinMs = retryMinMs;
    this._retryMaxMs = Math.max(retryMinMs, retryMaxMs);
    this._retryDelay = retryMinMs;
    this._generation = 0;
    this._activeOperation = null;
    this._timer = null;
    this._selection = null;
    this._lastEmittedSnapshot = null;
    this._stopped = false;
  }
  get selection() {
    return this._selection ? { ...this._selection } : null;
  }
  onChange(callback) {
    this.on('change', callback);
    return () => this.off('change', callback);
  }
  onTranscript(callback) {
    this.on('transcript', callback);
    return () => this.off('transcript', callback);
  }
  async select(selection) {
    if (selectionError(selection)) throw new TranscriptWatcherError('ERR_INVALID_SELECTION');
    this._stopped = false;
    const generation = ++this._generation;
    this._clearTimer();
    await this._cancelActiveOperation();
    if (!this._isCurrent(generation)) return null;
    this._selection = {
      socketPath: selection.socketPath,
      paneId: selection.paneId,
      reconnecting: selection.reconnecting === true,
    };
    this._lastEmittedSnapshot = null;
    this._retryDelay = this._retryMinMs;
    try {
      const payload = await this._readAndEmit(generation, true);
      if (!this._isCurrent(generation)) return null;
      this._schedule(generation, this._pollIntervalMs);
      return payload;
    } catch (error) {
      const safe = this._safeError(error);
      if (this._isCurrent(generation)) this._report(safe, generation);
      throw safe;
    }
  }
  async clear() {
    await this._cancelSelection();
  }
  async stop() {
    this._stopped = true;
    await this._cancelSelection();
  }
  async _cancelSelection() {
    const generation = ++this._generation;
    this._clearTimer();
    await this._cancelActiveOperation();
    if (generation === this._generation) {
      this._selection = null; this._lastEmittedSnapshot = null;
    }
  }
  async _readAndEmit(generation, initial) {
    const selection = this._selection;
    if (!selection || !this._isCurrent(generation)) return null;
    const response = await this._request(generation, 'pane.read', {
      pane_id: selection.paneId,
      ...PANE_READ_REQUEST,
    });
    if (!this._isCurrent(generation)) return null;
    const read = validatePaneRead(response, selection.paneId);
    const limited = limitTranscriptText(read.text, this._maxBytes);
    const reconnecting = initial && selection.reconnecting;
    const payload = {
      paneId: selection.paneId,
      text: limited.text,
      revision: read.revision,
      truncated: read.truncated || limited.bridgeTruncated,
      gap: Boolean(reconnecting || limited.bridgeTruncated),
      reconnecting: Boolean(reconnecting),
      bridgeTruncated: limited.bridgeTruncated,
    };
    const snapshot = Object.freeze({ ...payload });
    if (initial || !sameTranscriptSnapshot(snapshot, this._lastEmittedSnapshot)) {
      this._lastEmittedSnapshot = snapshot;
      this.emit('change', payload);
      this.emit('transcript', payload);
      this.emit('update', payload);
    }
    return payload;
  }
  async _poll(generation) {
    if (!this._isCurrent(generation)) return;
    try {
      const payload = await this._readAndEmit(generation, false);
      if (!payload || !this._isCurrent(generation)) return;
      this._retryDelay = this._retryMinMs;
      this._schedule(generation, this._pollIntervalMs);
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      this._report(error, generation);
      if (!shouldRetryPolling(error)) return;
      const delay = this._retryDelay;
      this._retryDelay = Math.min(this._retryMaxMs, Math.max(this._retryMinMs, delay * 2));
      this._schedule(generation, delay);
    }
  }
  async _request(generation, method, params) {
    const selection = this._selection;
    if (!selection || !this._isCurrent(generation)) return null;
    const operation = new TranscriptOneShotOperation({
      createClient: this._createClient,
      socketPath: selection.socketPath,
      requestTimeoutMs: this._requestTimeoutMs,
    });
    this._activeOperation = operation;
    try {
      return await operation.request(method, params, { timeoutMs: this._requestTimeoutMs });
    } finally {
      if (this._activeOperation === operation) this._activeOperation = null;
      await operation.close();
    }
  }
  _schedule(generation, delay) {
    if (!this._isCurrent(generation) || this._timer !== null) return;
    this._timer = this._timers.setTimeout(() => {
      this._timer = null;
      void this._poll(generation);
    }, delay);
  }
  _clearTimer() {
    if (this._timer === null) return;
    const timer = this._timer;
    this._timer = null;
    this._timers.clearTimeout(timer);
  }
  _cancelActiveOperation() {
    const operation = this._activeOperation;
    this._activeOperation = null;
    return operation ? operation.close() : Promise.resolve();
  }
  _safeError(error) {
    if (error instanceof TranscriptWatcherError) return error;
    return new TranscriptWatcherError(stableTranscriptError(error));
  }
  _report(error, generation) {
    if (!this._isCurrent(generation)) return;
    const safe = this._safeError(error);
    this.emit('watcher-error', { code: safe.code });
    if (this.listenerCount('error') > 0) this.emit('error', safe);
  }
  _isCurrent(generation) {
    return !this._stopped && generation === this._generation;
  }
}
export const createTranscriptWatcher = (options) => new TranscriptWatcher(options);
