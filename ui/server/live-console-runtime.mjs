import { discoverHerdr } from './herdr-discovery.mjs';
import { RuntimeEvents } from './runtime-events.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import { TranscriptWatcher } from './transcript-watcher.mjs';
import { SseHub } from './sse-hub.mjs';
import { createApiController } from './api-controller.mjs';
import { createSettingsController } from './settings/settings-controller.mjs';
import { createHodRoleSettings } from './settings/hod-role-settings.mjs';
import { createHerdrConfigSettings } from './settings/herdr-config-settings.mjs';
import { RuntimeSseBridge } from './runtime-sse-bridge.mjs';
import { TranscriptSelectionCoordinator } from './transcript-selection-coordinator.mjs';
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
function stableCode(error, fallback) {
  const raw = typeof error?.code === 'string' ? error.code : fallback;
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return CODE.test(code) ? code : fallback;
}
function serviceOrCreate(value, options, factory) {
  if (value && typeof value.list === 'function') return value;
  return options ? factory(options) : value ?? null;
}
function publishingSettings(base, refresh) {
  const get = base.get ?? base.getSettings;
  if (typeof get !== 'function') throw new TypeError('settings controller is required');
  const hod = base.postHod ?? base.updateHod;
  const herdr = base.postHerdr ?? base.updateHerdr;
  const mutate = (method) => typeof method === 'function' ? async (body) => {
    const result = await method.call(base, body);
    try { await refresh(); } catch {}
    return result;
  } : undefined;
  const postHod = mutate(hod);
  const postHerdr = mutate(herdr);
  return Object.freeze({
    ...base,
    get: get.bind(base), getSettings: get.bind(base),
    ...(postHod ? { postHod, updateHod: postHod } : {}),
    ...(postHerdr ? { postHerdr, updateHerdr: postHerdr } : {}),
  });
}
export class LiveConsoleRuntime {
  constructor(options = {}) {
    const runtimeOptions = options.runtimeEventsOptions ?? {};
    const suppliedEvents = options.runtimeEvents ?? options.events;
    this.runtimeStore = options.runtimeStore ?? options.store ?? new RuntimeStore();
    this._discover = options.discover ?? options.discoverHerdr ?? runtimeOptions.discover
      ?? suppliedEvents?.discover ?? suppliedEvents?._discover ?? discoverHerdr;
    this.runtimeEvents = suppliedEvents ?? new RuntimeEvents({
      ...runtimeOptions, store: this.runtimeStore, discover: this._discover,
    });
    this.transcriptWatcher = options.transcriptWatcher ?? options.watcher
      ?? new TranscriptWatcher(options.transcriptWatcherOptions ?? options.watcherOptions);
    const hod = serviceOrCreate(options.hodRoleSettings ?? options.hodSettings ?? options.hod,
      options.hodRoleSettingsOptions ?? options.hodSettingsOptions, createHodRoleSettings);
    const herdr = serviceOrCreate(options.herdrConfigSettings ?? options.herdrSettings ?? options.herdr,
      options.herdrConfigSettingsOptions ?? options.herdrSettingsOptions, createHerdrConfigSettings);
    const baseSettings = options.settingsController ?? options.settings ?? (
      hod && herdr ? createSettingsController({ hodRoleSettings: hod, herdrConfigSettings: herdr }) : null
    );
    if (!baseSettings) throw new TypeError('settings controller or settings services are required');
    this.sseHub = options.sseHub ?? options.hub ?? new SseHub(options.sseHubOptions);
    this.hodRoleSettings = hod;
    this.herdrConfigSettings = herdr;
    this._settingsBase = baseSettings;
    this._started = false;
    this._startPromise = null;
    this._stopPromise = null;
    this.sseBridge = options.runtimeSseBridge ?? options.sseBridge ?? new RuntimeSseBridge({
      runtimeStore: this.runtimeStore, transcriptWatcher: this.transcriptWatcher, sseHub: this.sseHub,
    });
    this.transcriptSelection = new TranscriptSelectionCoordinator({
      runtimeStore: this.runtimeStore, transcriptWatcher: this.transcriptWatcher,
      discover: this._discover, onGap: (payload) => this.sseBridge.publishTranscript?.(payload),
    });
    this.settingsController = publishingSettings(baseSettings, () => this._refreshSettings());
    this.apiController = options.apiController ?? options.api ?? createApiController({
      ...(options.apiControllerOptions ?? {}), runtimeStore: this.runtimeStore,
      settingsController: this.settingsController, selectTranscript: (paneId) => this.selectTranscript(paneId),
    });
    this.store = this.runtimeStore;
    this.events = this.runtimeEvents;
    this.watcher = this.transcriptWatcher;
    this.hub = this.sseHub;
    this.api = this.apiController;
    this._closeOwnedResources = options.closeOwnedResources !== false;
    this._ownsHub = !options.sseHub && !options.hub;
  }
  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this._started) return this._startPromise ?? Promise.resolve(this);
    this._started = true;
    try { this.sseBridge.start?.(); } catch (error) { this._runtimeFailure(error); }
    this.transcriptSelection.start();
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
    if (!this._started && !this._startPromise) {
      if (this._closeOwnedResources && this._ownsHub) {
        try { this.sseHub.close?.(); } catch {}
      }
      return Promise.resolve(this);
    }
    this._started = false;
    try { this.sseBridge.stop?.(); } catch {}
    this.transcriptSelection.stop();
    this._stopPromise = (async () => {
      await Promise.allSettled([
        Promise.resolve().then(() => this.runtimeEvents.stop?.()),
        Promise.resolve().then(() => this.transcriptWatcher.stop?.()),
      ]);
      if (this._closeOwnedResources && this._ownsHub) {
        try { this.sseHub.close?.(); } catch {}
      }
      this._startPromise = null;
      this._stopPromise = null;
      return this;
    })();
    return this._stopPromise;
  }
  async selectTranscript(paneId) {
    return this.transcriptSelection.select(paneId);
  }
  _runtimeFailure(error) {
    if (!this._started) return;
    const code = stableCode(error, 'ERR_HERDR_UNAVAILABLE');
    try {
      const current = this.runtimeStore.getSnapshot?.() ?? {};
      const staleRuntime = current.workspaces?.length > 0 || current.tabs?.length > 0
        || current.agents?.length > 0 || current.selectedPaneId !== null;
      if (current.connection?.state !== 'reconnecting' || current.connection?.errorCode !== code || staleRuntime) {
        if (typeof this.runtimeStore.resetForReconnect === 'function') this.runtimeStore.resetForReconnect({ errorCode: code });
        else if (typeof this.runtimeStore.clearRuntime === 'function') this.runtimeStore.clearRuntime({ state: 'reconnecting', errorCode: code });
        else this.runtimeStore.setConnection?.({ state: 'reconnecting', errorCode: code });
      }
    } catch {}
  }
  async _refreshSettings() {
    try {
      const value = await this._settingsBase.get?.() ?? await this._settingsBase.getSettings();
      if (this._started) this.sseBridge.publishSettings?.(value);
      return value;
    } catch { return null; }
  }
}
export const createLiveConsoleRuntime = (options) => new LiveConsoleRuntime(options);
export const LiveRuntime = LiveConsoleRuntime;
export const createLiveRuntime = createLiveConsoleRuntime;
