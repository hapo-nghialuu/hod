const EVENT_NAMES = Object.freeze(['connection', 'state', 'transcript', 'settings', 'resync']);

export class ApiError extends Error {
  constructor(status, message = 'API request failed') {
    super(message);
    this.name = 'ApiError';
    this.status = Number.isInteger(status) ? status : 0;
  }
}

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is unavailable');
  return globalThis.fetch.bind(globalThis);
}

export function readBootstrapToken(locationRef = globalThis.location) {
  const hash = typeof locationRef?.hash === 'string' ? locationRef.hash : '';
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  return token ? token : null;
}

export function clearBootstrapFragment(locationRef = globalThis.location, historyRef = globalThis.history) {
  if (!historyRef || typeof historyRef.replaceState !== 'function') return false;
  const path = typeof locationRef?.pathname === 'string' ? locationRef.pathname : '';
  const search = typeof locationRef?.search === 'string' ? locationRef.search : '';
  historyRef.replaceState(null, '', `${path}${search}` || '/');
  return true;
}

async function responseJson(response) {
  if (response.status === 204) return null;
  if (typeof response.json === 'function') return response.json();
  if (typeof response.text === 'function') {
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  }
  return null;
}

export async function requestJson(fetchImpl, path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
  const init = { method, credentials: 'same-origin', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetchImpl(path, init);
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const ok = response?.ok ?? (status >= 200 && status < 300);
  if (!ok) throw new ApiError(status, `API request failed (${status || 'network'})`);
  return responseJson(response);
}

function eventPayload(event, onMalformed) {
  if (event?.data === undefined || event.data === '') return null;
  if (typeof event.data !== 'string') return event.data;
  try {
    return JSON.parse(event.data);
  } catch {
    onMalformed?.();
    return null;
  }
}

export function openEventStream(EventSourceImpl, options = {}) {
  if (typeof EventSourceImpl !== 'function') throw new Error('EventSource is unavailable');
  const source = new EventSourceImpl(options.url ?? '/api/events', { withCredentials: true });
  source.addEventListener?.('open', () => options.onOpen?.());
  source.addEventListener?.('error', (event) => options.onError?.(event));
  for (const name of EVENT_NAMES) {
    source.addEventListener?.(name, (event) => {
      const payload = eventPayload(event, options.onMalformed);
      if (payload !== null) options.onEvent?.(name, payload, event);
    });
  }
  return source;
}

export function createApiClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const locationRef = options.locationRef ?? globalThis.location;
  const historyRef = options.historyRef ?? globalThis.history;
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;
  const request = (path, requestOptions) => requestJson(fetchImpl, path, requestOptions);

  return {
    async bootstrapSession() {
      const token = readBootstrapToken(locationRef);
      if (!token) return { authenticated: false, tokenProvided: false };
      try {
        await request('/api/session', {
          method: 'POST',
          headers: { 'X-HOD-Bootstrap': token },
        });
        return { authenticated: true, tokenProvided: true };
      } finally {
        try { clearBootstrapFragment(locationRef, historyRef); } catch {}
      }
    },
    getState() {
      return request('/api/state');
    },
    getSettings() {
      return request('/api/settings');
    },
    selectTranscript(paneId) {
      return request('/api/transcript/select', { method: 'POST', body: { paneId } });
    },
    saveHodSettings({ role, force, confirmation } = {}) {
      return request('/api/settings/hod', {
        method: 'POST',
        body: { role, force, confirmation },
      });
    },
    saveHerdrSetting({ key, value, confirmation } = {}) {
      return request('/api/settings/herdr', {
        method: 'POST',
        body: { key, value, confirmation },
      });
    },
    openEvents(handlers = {}) {
      return openEventStream(EventSourceImpl, handlers);
    },
  };
}
