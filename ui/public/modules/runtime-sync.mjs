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
  let stopped = false;

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
    const results = await Promise.allSettled([
      Promise.resolve().then(() => api.getState()),
      Promise.resolve().then(() => api.getSettings()),
    ]);
    if (stopped || requestGeneration !== refreshGeneration) return options.getState?.() ?? null;
    let failure = results.find((result) => result.status === 'rejected')?.reason ?? null;
    if (results[0].status === 'fulfilled') {
      try { options.onState?.(results[0].value); } catch (error) { failure ??= error; }
    }
    if (results[1].status === 'fulfilled') {
      try { options.onSettings?.(results[1].value); } catch (error) { failure ??= error; }
    }
    if (failure) {
      safeCall(options.onStatus, 'refresh failed', safeCode(failure, options.errorCode));
    } else {
      safeCall(options.onStatus, 'refresh complete', 'OK');
    }
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

  return Object.freeze({ open, refresh, stop });
}
