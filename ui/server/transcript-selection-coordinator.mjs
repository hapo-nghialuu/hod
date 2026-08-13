import { discoverHerdr } from './herdr-discovery.mjs';

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeError(error, fallback) {
  const raw = typeof error?.code === 'string' ? error.code : fallback;
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const stable = CODE.test(code) ? code : fallback;
  return Object.assign(new Error(stable), { code: stable });
}

function subscribe(store, callback) {
  if (typeof store.onChange === 'function') return store.onChange(callback);
  if (typeof store.on !== 'function') return () => {};
  store.on('change', callback);
  return () => store.off?.('change', callback) ?? store.removeListener?.('change', callback);
}

function hasPane(snapshot, paneId) {
  return Array.isArray(snapshot?.agents) && snapshot.agents.some((agent) => agent?.paneId === paneId);
}

function publicTranscript(value, paneId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = { paneId };
  if (typeof value.text === 'string') output.text = value.text;
  if (Number.isSafeInteger(value.revision) && value.revision >= 0) output.revision = value.revision;
  for (const key of ['truncated', 'gap', 'reconnecting', 'bridgeTruncated']) {
    if (typeof value[key] === 'boolean') output[key] = value[key];
  }
  return output;
}

export class TranscriptSelectionCoordinator {
  constructor({ runtimeStore, store, transcriptWatcher, watcher, discover = discoverHerdr, onGap } = {}) {
    this.store = runtimeStore ?? store;
    this.watcher = transcriptWatcher ?? watcher;
    this.discover = discover;
    this.onGap = onGap;
    if (!this.store || !this.watcher) throw new TypeError('runtime store and transcript watcher are required');
    this._started = false;
    this._removeStore = null;
    this._desiredPaneId = null;
    this._generation = 0;
    this._needsResume = false;
  }

  start() {
    if (this._started) return this;
    this._started = true;
    this._removeStore = subscribe(this.store, (snapshot) => this._runtimeChanged(snapshot));
    return this;
  }

  stop() {
    if (!this._started) return this;
    this._started = false;
    this._generation += 1;
    this._desiredPaneId = null;
    this._needsResume = false;
    try { this._removeStore?.(); } catch {}
    this._removeStore = null;
    this._cancelWatcher();
    return this;
  }

  async select(paneId) {
    if (typeof paneId !== 'string' || paneId.trim() === '') throw safeError(null, 'ERR_INVALID_PANE_ID');
    if (!this._started) throw safeError(null, 'ERR_RUNTIME_STOPPED');
    const id = paneId.trim();
    if (!hasPane(this._snapshot(), id)) throw safeError(null, 'ERR_PANE_NOT_FOUND');
    this._desiredPaneId = id;
    this._needsResume = false;
    const generation = ++this._generation;
    this._cancelWatcher();
    return this._select(id, false, generation);
  }

  async _select(paneId, reconnecting, generation) {
    try {
      const discovered = await this.discover();
      if (!this._current(paneId, generation)) return null;
      const socketPath = typeof discovered === 'string' ? discovered : discovered?.socketPath;
      if (typeof socketPath !== 'string' || socketPath.trim() === '') throw safeError(null, 'ERR_DISCOVERY_SOCKET');
      const selection = { socketPath: socketPath.trim(), paneId };
      if (reconnecting) selection.reconnecting = true;
      const payload = await this.watcher.select(selection);
      return this._current(paneId, generation) ? publicTranscript(payload, paneId) : null;
    } catch (error) {
      if (!this._current(paneId, generation)) return null;
      throw safeError(error, 'ERR_TRANSCRIPT_SELECT');
    }
  }

  _runtimeChanged(snapshot) {
    if (!this._started) return;
    const state = snapshot?.connection?.state;
    if (state === 'reconnecting') {
      if (!this._needsResume) {
        this._needsResume = true;
        this._generation += 1;
        this._cancelWatcher();
        if (this._desiredPaneId) {
          try { this.onGap?.({ paneId: this._desiredPaneId, text: '', gap: true, reconnecting: true, truncated: false }); } catch {}
        }
      }
      return;
    }
    if (state !== 'connected') return;
    if (this._desiredPaneId && !hasPane(snapshot, this._desiredPaneId)) {
      this._desiredPaneId = null;
      this._needsResume = false;
      this._generation += 1;
      this._cancelWatcher();
      return;
    }
    if (this._needsResume && this._desiredPaneId) {
      const paneId = this._desiredPaneId;
      const generation = ++this._generation;
      this._needsResume = false;
      void this._select(paneId, true, generation).catch(() => {});
    }
  }

  _snapshot() { return this.store.getSnapshot?.() ?? this.store.snapshot?.(); }

  _current(paneId, generation) {
    return this._started && generation === this._generation
      && this._desiredPaneId === paneId && hasPane(this._snapshot(), paneId);
  }

  _cancelWatcher() {
    try { Promise.resolve(this.watcher.clear?.()).catch(() => {}); } catch {}
  }
}

export const createTranscriptSelectionCoordinator = (options) => new TranscriptSelectionCoordinator(options);
export const TranscriptSelector = TranscriptSelectionCoordinator;
