import { EventEmitter } from 'node:events';
import { discoverHerdr, EXPECTED_HERDR_PROTOCOL } from './herdr-discovery.mjs';
import { HerdrSocketClient } from './herdr-socket-client.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import { RuntimeClientConnections } from './runtime-client-connections.mjs';
import { snapshotFromResponse, stableRuntimeCode } from './runtime-event-subscriptions.mjs';

export const SNAPSHOT_DEBOUNCE_MS = 40;
export const POLL_INTERVAL_MS = 1_000;
export const RECONNECT_MIN_MS = 250;
export const RECONNECT_MAX_MS = 5_000;

export class RuntimeEvents extends EventEmitter {
  constructor({
    store = new RuntimeStore(), discover = discoverHerdr, clientFactory, createClient, client,
    timers = globalThis, pollIntervalMs = POLL_INTERVAL_MS,
    reconnectMinMs = RECONNECT_MIN_MS, reconnectMaxMs = RECONNECT_MAX_MS,
    requestTimeoutMs, expectedProtocol = EXPECTED_HERDR_PROTOCOL,
  } = {}) {
    super();
    this.store = store;
    this._discover = discover;
    this._createClient = clientFactory ?? createClient ?? (client ? () => client
      : (options) => new HerdrSocketClient(options));
    this._setTimeout = (timers.setTimeout ?? setTimeout).bind(timers);
    this._clearTimeout = (timers.clearTimeout ?? clearTimeout).bind(timers);
    this._pollIntervalMs = pollIntervalMs;
    this._reconnectMinMs = reconnectMinMs;
    this._reconnectMaxMs = reconnectMaxMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this._expectedProtocol = expectedProtocol;
    this._started = false;
    this._generation = 0;
    this._startPromise = null;
    this._inFlight = null;
    this._pollTimer = null;
    this._reconnectTimer = null;
    this._options = null;
    this._reconnecting = false;
    this._backoffMs = reconnectMinMs;
    this._connections = new RuntimeClientConnections({
      createClient: this._createClient,
      isCurrent: (token) => this._isCurrent(token),
    });
  }

  get client() { return this._connections.rpcClient; }

  start() {
    if (this._started) return this._startPromise ?? Promise.resolve(this);
    this._started = true;
    const token = ++this._generation;
    this._startPromise = this._attempt(token, true);
    return this._startPromise;
  }

  async stop() {
    this._started = false;
    this._generation += 1;
    this._cancel('_pollTimer');
    this._cancel('_reconnectTimer');
    this._inFlight = null;
    this._options = null;
    this._reconnecting = false;
    await this._connections.close();
    this.store.clearRuntime({ state: 'disconnected', errorCode: null });
  }

  async refresh() {
    if (!this._started) return this.start();
    this._cancel('_pollTimer');
    return this._attempt(this._generation);
  }

  _attempt(token, discover = false) {
    if (!this._isCurrent(token)) return Promise.resolve(null);
    if (this._inFlight) return this._inFlight;
    const attempt = this._performAttempt(token, discover);
    this._inFlight = attempt;
    attempt.finally(() => {
      if (this._inFlight === attempt) this._inFlight = null;
    }).catch(() => {});
    return attempt;
  }

  async _performAttempt(token, discover) {
    try {
      if (discover || !this._options) {
        const discovered = await this._discover();
        if (!this._isCurrent(token)) return null;
        this._options = {
          socketPath: discovered.socketPath,
          ...(this._requestTimeoutMs ? { requestTimeoutMs: this._requestTimeoutMs } : {}),
        };
      }

      const response = await this._connections.requestSnapshot(token, this._options);
      if (!this._isCurrent(token)) return null;
      const snapshot = snapshotFromResponse(response);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || snapshot.protocol !== this._expectedProtocol) {
        throw Object.assign(new Error(), { code: 'ERR_RUNTIME_INCOMPATIBLE' });
      }
      const result = this.store.replaceSnapshot(snapshot, {
        state: 'connected', version: snapshot.version, protocol: snapshot.protocol,
      });
      if (!this._isCurrent(token)) return null;
      this._reconnecting = false;
      this._backoffMs = this._reconnectMinMs;
      this._schedulePoll(token);
      return result;
    } catch (error) {
      if (this._isCurrent(token)) {
        try { this._handleFailure(error, token); } catch {}
      }
      return null;
    }
  }

  _handleFailure(error, token) {
    if (!this._isCurrent(token)) return;
    const code = stableRuntimeCode(error, 'ERR_SOCKET_DISCONNECTED');
    this._reconnecting = true;
    this._cancel('_pollTimer');
    if (typeof this.store.resetForReconnect === 'function') {
      this.store.resetForReconnect({ errorCode: code });
    } else if (typeof this.store.clearRuntime === 'function') {
      this.store.clearRuntime({ state: 'reconnecting', errorCode: code });
    } else {
      this.store.setConnection({ state: 'reconnecting', errorCode: code });
    }
    try { this.emit('connection-error', { code }); } catch {}
    this._scheduleReconnect(token);
  }

  _schedulePoll(token) {
    if (!this._isCurrent(token) || this._pollTimer || this._reconnectTimer) return;
    this._pollTimer = this._setTimeout(() => {
      this._pollTimer = null;
      if (!this._isCurrent(token) || this._reconnecting) return;
      void this._attempt(token).catch(() => {});
    }, this._pollIntervalMs);
  }

  _scheduleReconnect(token) {
    if (!this._isCurrent(token) || this._reconnectTimer) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._reconnectMaxMs,
      Math.max(this._reconnectMinMs, delay * 2));
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._isCurrent(token)) return;
      this._reconnecting = false;
      void this._attempt(token).catch(() => {});
    }, delay);
  }

  _cancel(field) {
    if (this[field] === null) return;
    this._clearTimeout(this[field]);
    this[field] = null;
  }

  _isCurrent(token) { return this._started && token === this._generation; }
}

export const RuntimeCoordinator = RuntimeEvents;
export const createRuntimeEvents = (options) => new RuntimeEvents(options);
export const createRuntimeCoordinator = createRuntimeEvents;
