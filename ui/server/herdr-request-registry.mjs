export const MAX_PENDING_REQUESTS = 128;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class HerdrRequestRegistry {
  constructor(defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new TypeError('defaultTimeoutMs must be a positive integer');
    }
    this.defaultTimeoutMs = defaultTimeoutMs;
    this._pending = new Map();
    this._nextId = 0;
  }

  get size() {
    return this._pending.size;
  }

  register(timeoutMs = this.defaultTimeoutMs) {
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      throw registryError('ERR_PENDING_LIMIT', 'Too many pending Herdr requests');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw registryError('ERR_INVALID_TIMEOUT', 'timeoutMs must be a positive integer');
    }

    const id = `hod-${++this._nextId}`;
    let settle;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.delete(id)) return;
        reject(registryError('ERR_REQUEST_TIMEOUT', 'Herdr request timed out'));
      }, timeoutMs);
      settle = (value, error) => {
        if (!this._pending.delete(id)) return false;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
        return true;
      };
      this._pending.set(id, settle);
    });
    return { id, promise };
  }

  resolve(id, value) {
    return this._settle(id, value);
  }

  reject(id, error) {
    return this._settle(id, undefined, error);
  }

  rejectAll(error) {
    const pending = [...this._pending.values()];
    for (const settle of pending) settle(undefined, error);
    this._pending.clear();
  }

  _settle(id, value, error) {
    const settle = this._pending.get(id);
    return settle ? settle(value, error) : false;
  }
}
