export const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export const errorWithCode = (code) => Object.assign(new Error(code), { code });

export class ManualTimers {
  constructor() {
    this.entries = [];
    this.nextId = 1;
  }

  setTimeout(callback, delay) {
    const entry = {
      id: this.nextId,
      callback,
      delay,
      fired: false,
      cleared: false,
      clearCount: 0,
    };
    this.nextId += 1;
    this.entries.push(entry);
    return entry;
  }

  clearTimeout(handle) {
    const entry = typeof handle === 'number'
      ? this.entries.find((candidate) => candidate.id === handle)
      : handle;
    if (!entry || entry.cleared) return;
    entry.cleared = true;
    entry.clearCount += 1;
  }

  pendingTimers() {
    return this.entries.filter((entry) => !entry.fired && !entry.cleared);
  }

  pendingDelays() {
    return this.pendingTimers().map(({ delay }) => delay);
  }

  scheduledDelays() {
    return this.entries.map(({ delay }) => delay);
  }

  async runNext() {
    const entry = this.pendingTimers()[0];
    if (!entry) throw new Error('no pending manual timer');
    entry.fired = true;
    await entry.callback();
    await flush();
    return entry;
  }
}

export class OneShotTranscriptClient {
  constructor(firstResponse) {
    this.firstResponse = firstResponse;
    this.events = [];
    this.pending = new Set();
    this.connected = false;
  }

  get requests() {
    return this.events.filter((event) => event.type === 'request');
  }

  get closes() {
    return this.events.filter((event) => event.type === 'close').length;
  }

  async connect() {
    this.connected = true;
    this.events.push({ type: 'connect' });
  }

  request(method, params, options) {
    const call = { method, params, options };
    this.events.push({ type: 'request', ...call });
    if (this.requests.length > 1) return Promise.reject(errorWithCode('ERR_SECOND_REQUEST'));

    const response = typeof this.firstResponse === 'function'
      ? this.firstResponse(call)
      : this.firstResponse;
    const source = response && typeof response === 'object' && 'promise' in response
      ? response.promise
      : response;
    let pending;
    const promise = new Promise((resolve, reject) => {
      pending = { resolve, reject };
      this.pending.add(pending);
    });
    const settle = (callback) => (value) => {
      if (this.pending.delete(pending)) callback(value);
    };
    Promise.resolve(source).then(settle(pending.resolve), settle(pending.reject));
    return promise;
  }

  close() {
    this.connected = false;
    this.events.push({ type: 'close' });
    const error = errorWithCode('ERR_SOCKET_DISCONNECTED');
    for (const pending of this.pending) pending.reject(error);
    this.pending.clear();
  }
}
