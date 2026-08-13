import { EventEmitter } from 'node:events';

import {
  CONNECTION_STATES,
  AGENT_STATUSES,
  normalizeConnectionMetadata,
  normalizeSnapshot,
  RuntimeSnapshotError,
} from './runtime-state-normalizer.mjs';

export { CONNECTION_STATES, AGENT_STATUSES, normalizeSnapshot, RuntimeSnapshotError };

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function invalid() {
  throw new RuntimeSnapshotError();
}

export class RuntimeStore extends EventEmitter {
  constructor({ connection } = {}) {
    super();
    this._state = freeze({
      connection: normalizeConnectionMetadata({ ...(connection ?? {}), state: connection?.state ?? 'disconnected' }),
      workspaces: [],
      tabs: [],
      agents: [],
      selectedPaneId: null,
    });
  }

  getSnapshot() {
    return clone(this._state);
  }

  snapshot() {
    return this.getSnapshot();
  }

  onChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('change callback must be a function');
    this.on('change', callback);
    return () => this.off('change', callback);
  }

  _publish(state) {
    this._state = freeze(state);
    this.emit('change', this.getSnapshot());
    return this.getSnapshot();
  }

  replaceSnapshot(input, connection) {
    const next = normalizeSnapshot(input, connection ?? { state: 'connected', errorCode: this._state.connection.errorCode });
    next.selectedPaneId = this._state.selectedPaneId && next.agents.some((item) => item.paneId === this._state.selectedPaneId)
      ? this._state.selectedPaneId
      : null;
    return this._publish(next);
  }

  clearRuntime(connection = {}) {
    const nextConnection = normalizeConnectionMetadata({
      ...this._state.connection,
      ...connection,
      state: connection.state ?? 'disconnected',
    });
    return this._publish({ connection: nextConnection, workspaces: [], tabs: [], agents: [], selectedPaneId: null });
  }

  resetForReconnect(connection = {}) {
    return this.clearRuntime({ ...connection, state: 'reconnecting' });
  }

  setConnection(connection = {}) {
    const nextConnection = normalizeConnectionMetadata({ ...this._state.connection, ...connection });
    return this._publish({ ...this._state, connection: nextConnection });
  }

  selectPane(paneId) {
    if (paneId !== null && typeof paneId !== 'string') invalid();
    const selectedPaneId = paneId !== null && this._state.agents.some((item) => item.paneId === paneId) ? paneId : null;
    if (selectedPaneId === this._state.selectedPaneId) return this.getSnapshot();
    return this._publish({ ...this._state, selectedPaneId });
  }
}

export const createRuntimeStore = (options) => new RuntimeStore(options);
