import { discoverHerdr } from './herdr-discovery.mjs';
import { RuntimeEvents } from './runtime-events.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import { TranscriptWatcher } from './transcript-watcher.mjs';
import { SseHub } from './sse-hub.mjs';
import { RuntimeSseBridge } from './runtime-sse-bridge.mjs';
import { TranscriptSelectionCoordinator } from './transcript-selection-coordinator.mjs';
import {
  createGlobalObserverApiController,
  GLOBAL_OBSERVER_CAPABILITIES,
} from './global-observer-api-controller.mjs';

function withCapabilities(snapshot) {
  return { ...snapshot, capabilities: { ...GLOBAL_OBSERVER_CAPABILITIES } };
}

function settleCall(call) {
  return Promise.resolve().then(call).catch(() => {});
}

function observerStoreView(store) {
  return {
    getSnapshot: () => withCapabilities(store.getSnapshot()),
    snapshot: () => withCapabilities(store.getSnapshot()),
    onChange: (callback) => store.onChange((snapshot) => callback(withCapabilities(snapshot))),
  };
}

export class GlobalObserverRuntime {
  constructor(options = {}) {
    const runtimeOptions = options.runtimeEventsOptions ?? {};
    const suppliedEvents = options.runtimeEvents ?? options.events;
    const env = options.env ?? process.env;
    const herdrBin = options.herdrBin ?? env?.HERDR_BIN ?? 'herdr';
    this.runtimeStore = options.runtimeStore ?? options.store ?? new RuntimeStore();
    this._discover = options.discover ?? options.discoverHerdr ?? runtimeOptions.discover
      ?? suppliedEvents?.discover ?? suppliedEvents?._discover
      ?? (() => discoverHerdr({ env, command: herdrBin }));
    this.runtimeEvents = suppliedEvents ?? new RuntimeEvents({
      ...runtimeOptions, store: this.runtimeStore, discover: this._discover,
    });
    this.transcriptWatcher = options.transcriptWatcher ?? options.watcher
      ?? new TranscriptWatcher(options.transcriptWatcherOptions ?? options.watcherOptions);
    this.sseHub = options.sseHub ?? options.hub ?? new SseHub(options.sseHubOptions);
    this.sseBridge = options.runtimeSseBridge ?? options.sseBridge ?? new RuntimeSseBridge({
      runtimeStore: observerStoreView(this.runtimeStore),
      transcriptWatcher: this.transcriptWatcher,
      sseHub: this.sseHub,
    });
    this.transcriptSelection = options.transcriptSelection ?? new TranscriptSelectionCoordinator({
      runtimeStore: this.runtimeStore,
      transcriptWatcher: this.transcriptWatcher,
      discover: this._discover,
      onGap: (payload) => this.sseBridge.publishTranscript?.(payload),
    });
    this.apiController = options.apiController ?? options.api
      ?? createGlobalObserverApiController({
        runtimeStore: this.runtimeStore,
        selectTranscript: (paneId) => this.selectTranscript(paneId),
      });
    this.capabilities = GLOBAL_OBSERVER_CAPABILITIES;
    this.store = this.runtimeStore;
    this.events = this.runtimeEvents;
    this.watcher = this.transcriptWatcher;
    this.hub = this.sseHub;
    this.api = this.apiController;
    this._started = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._ownsHub = !options.sseHub && !options.hub;
  }

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this._started) return this._startPromise ?? Promise.resolve(this);
    this._started = true;
    try { this.sseBridge.start?.(); } catch (error) { this._runtimeFailure(error); }
    try { this.transcriptSelection.start?.(); } catch {}
    let startResult;
    try { startResult = this.runtimeEvents.start?.(); }
    catch (error) { startResult = Promise.reject(error); }
    this._startPromise = (async () => {
      try { await startResult; } catch (error) { this._runtimeFailure(error); }
      return this;
    })();
    return this._startPromise;
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    const closeOwnedHub = () => this._ownsHub ? this.sseHub.close?.() : undefined;
    if (!this._started && !this._startPromise) {
      const cleanup = settleCall(closeOwnedHub).then(() => this);
      this._stopPromise = cleanup.finally(() => { this._stopPromise = null; });
      return this._stopPromise;
    }
    this._started = false;
    try { this.sseBridge.stop?.(); } catch {}
    try { this.transcriptSelection.stop?.(); } catch {}
    const cleanup = Promise.allSettled([
      Promise.resolve().then(() => this.runtimeEvents.stop?.()),
      Promise.resolve().then(() => this.transcriptWatcher.stop?.()),
    ]).then(() => settleCall(closeOwnedHub)).then(() => {
      this._startPromise = null;
      return this;
    });
    this._stopPromise = cleanup.finally(() => { this._stopPromise = null; });
    return this._stopPromise;
  }

  selectTranscript(paneId) { return this.transcriptSelection.select(paneId); }

  _runtimeFailure(error) {
    if (!this._started) return;
    const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code)
      ? error.code.toUpperCase() : 'ERR_HERDR_UNAVAILABLE';
    try { this.runtimeStore.resetForReconnect?.({ errorCode: code }); } catch {}
  }
}

export const createGlobalObserverRuntime = (options) => new GlobalObserverRuntime(options);
export const createRuntimeOnly = createGlobalObserverRuntime;
