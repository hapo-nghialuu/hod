import { capabilitiesForState } from './ui-store.mjs';

const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5000;

function safeCall(callback, ...args) {
  try {
    const result = callback?.(...args);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {}
}

function safeCode(error, toCode) {
  try { return toCode?.(error) ?? 'ERR_UNAVAILABLE'; } catch { return 'ERR_UNAVAILABLE'; }
}

export function createRuntimeSync(options = {}) {
  const api = options.api;
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  const retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  let source = null;
  let sourceGeneration = 0;
  let retryTimer = null;
  let retryDelay = retryMinMs;
  let refreshGeneration = 0;
  let settingsGeneration = 0;
  let stopped = false;
  let settingsEnabled = true;

  function closeSource() {
    sourceGeneration += 1;
    const current = source;
    source = null;
    try { current?.close?.(); } catch {}
  }

  function scheduleRetry() {
    if (stopped || retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryMaxMs, retryDelay * 2);
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      open();
    }, delay);
  }

  async function refresh(reason = 'manual') {
    if (stopped) return options.getState?.() ?? null;
    const requestGeneration = ++refreshGeneration;
    let failure = null;
    let state;
    let stateReceived = false;
    try {
      state = await api.getState();
      stateReceived = true;
    } catch (error) {
      failure = error;
    }
    if (stopped || requestGeneration !== refreshGeneration) return options.getState?.() ?? null;
    if (stateReceived) {
      settingsEnabled = capabilitiesForState(state).settings;
      try { options.onState?.(state); } catch (error) { failure ??= error; }
      if (stopped || requestGeneration !== refreshGeneration) return options.getState?.() ?? null;
      if (settingsEnabled && typeof api.getSettings === 'function') {
        try {
          const selectedWorkspace = options.getState?.()?.selectedWorkspace ?? null;
          const settingsRequestGeneration = settingsGeneration;
          const settings = await api.getSettings(selectedWorkspace);
          const currentWorkspace = options.getState?.()?.selectedWorkspace ?? null;
          const responseWorkspace = settings?.selectedWorkspaceId;
          const responseMatches = !Object.hasOwn(settings ?? {}, 'selectedWorkspaceId')
            || (responseWorkspace == null ? null : String(responseWorkspace)) === currentWorkspace;
          if (!stopped && requestGeneration === refreshGeneration && settingsGeneration === settingsRequestGeneration
            && currentWorkspace === selectedWorkspace && responseMatches && settingsEnabled) {
            try { options.onSettings?.(settings); } catch (error) { failure ??= error; }
          }
        } catch (error) { failure ??= error; }
      }
    }
    if (stopped || requestGeneration !== refreshGeneration) return options.getState?.() ?? null;
    if (failure) safeCall(options.onStatus, 'refresh failed', safeCode(failure, options.errorCode));
    return options.getState?.() ?? null;
  }

  function open() {
    if (stopped) return;
    closeSource();
    const generation = sourceGeneration;
    const current = () => !stopped && generation === sourceGeneration;
    try {
      const next = api.openEvents({
        onOpen() {
          if (!current()) return;
          retryDelay = retryMinMs;
          safeCall(options.onOpen);
          void refresh('open').catch(() => {});
        },
        onError(error) {
          if (!current()) return;
          closeSource();
          safeCall(options.onError, error);
          void refresh('error').catch(() => {});
          scheduleRetry();
        },
        onMalformed() { if (current()) safeCall(options.onMalformed); },
        onEvent(type, payload, event) {
          if (!current()) return;
          if (type === 'resync') void refresh('resync').catch(() => {});
          if (type === 'state') settingsEnabled = capabilitiesForState(payload?.state ?? payload).settings;
          if (type === 'settings' && !settingsEnabled) return;
          safeCall(options.onEvent, type, payload, event);
        },
      });
      if (!current()) { try { next?.close?.(); } catch {} } else source = next;
    } catch (error) {
      if (!current()) return;
      safeCall(options.onError, error);
      void refresh('error').catch(() => {});
      scheduleRetry();
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (retryTimer !== null) clearTimeoutImpl(retryTimer);
    retryTimer = null;
    closeSource();
  }

  function invalidateSettings() { settingsGeneration += 1; }

  return Object.freeze({ open, refresh, stop, invalidateSettings });
}
