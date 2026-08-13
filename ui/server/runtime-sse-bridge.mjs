function snapshotOf(store) {
  if (typeof store?.getSnapshot === 'function') return store.getSnapshot();
  if (typeof store?.snapshot === 'function') return store.snapshot();
  throw new TypeError('runtime store is required');
}

function subscribe(source, event, callback, onChange = false) {
  const method = onChange ? source?.onChange : source?.onTranscript;
  if (typeof method === 'function') {
    const remove = method.call(source, callback);
    return typeof remove === 'function' ? remove : () => {};
  }
  if (typeof source?.on !== 'function') return () => {};
  source.on(event, callback);
  return () => source.off?.(event, callback) ?? source.removeListener?.(event, callback);
}

function copy(value) {
  try { return structuredClone(value); } catch { return value; }
}

function publicTranscript(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const paneId = value.paneId ?? value.pane_id;
  if (typeof paneId !== 'string' || paneId.trim() === '') return null;
  const output = { paneId: paneId.trim() };
  if (typeof value.text === 'string') output.text = value.text;
  if (Number.isSafeInteger(value.revision) && value.revision >= 0) output.revision = value.revision;
  for (const key of ['truncated', 'gap', 'reconnecting', 'bridgeTruncated']) {
    if (typeof value[key] === 'boolean') output[key] = value[key];
  }
  return output;
}

function publicSettings(value) {
  const roles = Array.isArray(value?.hod?.roles) ? value.hod.roles.map(({ role, status, unsafe }) => ({ role, status, unsafe })) : [];
  const settings = Array.isArray(value?.herdr?.settings) ? value.herdr.settings.map(({ key, value: settingValue, source, metadata }) => {
    const output = { key, value: settingValue, source };
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      output.metadata = {};
      for (const name of ['type', 'enum', 'restart', 'default', 'description']) {
        if (Object.hasOwn(metadata, name)) output.metadata[name] = copy(metadata[name]);
      }
    }
    return output;
  }) : [];
  return { hod: { roles }, herdr: { settings } };
}

export class RuntimeSseBridge {
  constructor({ runtimeStore, store, transcriptWatcher, watcher, sseHub, hub } = {}) {
    this.store = runtimeStore ?? store;
    this.watcher = transcriptWatcher ?? watcher;
    this.hub = sseHub ?? hub;
    if (!this.store || !this.watcher || typeof this.hub?.publish !== 'function') {
      throw new TypeError('runtime store, transcript watcher, and SSE hub are required');
    }
    this._started = false;
    this._removeStore = null;
    this._removeTranscript = null;
  }

  start() {
    if (this._started) return this;
    this._started = true;
    this._removeStore = subscribe(this.store, 'change', (snapshot) => {
      this._publishRuntime(snapshot);
    }, true);
    this._removeTranscript = subscribe(this.watcher, 'transcript', (payload) => {
      this.publishTranscript(payload);
    });
    return this;
  }

  stop() {
    if (!this._started) return this;
    this._started = false;
    for (const field of ['_removeStore', '_removeTranscript']) {
      const remove = this[field];
      this[field] = null;
      try { remove?.(); } catch { /* listener cleanup is best effort */ }
    }
    return this;
  }

  publishTranscript(payload) {
    if (!this._started) return 0;
    const transcript = publicTranscript(payload);
    return transcript ? this._publish('transcript', transcript) : 0;
  }

  publishSettings(settings) {
    if (!this._started) return 0;
    return this._publish('settings', publicSettings(settings));
  }

  _publishRuntime(snapshot) {
    const value = snapshot ?? snapshotOf(this.store);
    this._publish('connection', copy(value?.connection ?? {}));
    this._publish('state', copy(value));
  }

  _publish(name, payload) {
    try { return this.hub.publish(name, copy(payload)); } catch { return 0; }
  }
}

export const createRuntimeSseBridge = (options) => new RuntimeSseBridge(options);
export const RuntimeSSEBridge = RuntimeSseBridge;
export const createRuntimeSSEBridge = createRuntimeSseBridge;
