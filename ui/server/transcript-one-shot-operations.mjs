import {
  closeTranscriptClient,
  TranscriptWatcherError,
} from './transcript-text-limit.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function disconnectedError() {
  return new TranscriptWatcherError('ERR_SOCKET_DISCONNECTED');
}

export class TranscriptOneShotOperation {
  constructor({ createClient, socketPath, requestTimeoutMs }) {
    this._createClient = createClient;
    this._socketPath = socketPath;
    this._requestTimeoutMs = requestTimeoutMs;
    this._cancel = deferred();
    this._factory = null;
    this._client = null;
    this._clientClosePromise = Promise.resolve();
    this._closedClient = null;
    this._closePromise = Promise.resolve();
    this._closed = false;
    this._requestStarted = false;
  }

  request(method, params, { timeoutMs = this._requestTimeoutMs } = {}) {
    if (this._requestStarted) {
      return Promise.reject(new TranscriptWatcherError('ERR_SECOND_REQUEST'));
    }
    this._requestStarted = true;
    return this._run(method, params, timeoutMs);
  }

  close() {
    if (this._closed) return this._closePromise;
    this._closed = true;
    this._cancel.reject(disconnectedError());
    const client = this._client;
    this._client = null;
    const factory = this._factory;
    this._closePromise = Promise.all([
      this._closeClient(client),
      factory ? factory.then((created) => this._closeClient(created), () => {}) : Promise.resolve(),
    ]).then(() => undefined);
    return this._closePromise;
  }

  async _run(method, params, timeoutMs) {
    if (this._closed) throw disconnectedError();
    this._factory = Promise.resolve().then(() => this._createClient({
      socketPath: this._socketPath,
      requestTimeoutMs: this._requestTimeoutMs,
    }));
    this._factory.then((client) => {
      if (this._closed) void this._closeClient(client);
    }, () => {});

    const client = await this._race(this._factory);
    if (this._closed) {
      await this._closeClient(client);
      throw disconnectedError();
    }
    this._client = client;
    try {
      await this._race(Promise.resolve().then(() => client.connect()));
      return await this._race(Promise.resolve().then(() => client.request(
        method,
        params,
        { timeoutMs },
      )));
    } finally {
      const current = this._client;
      this._client = null;
      await this._closeClient(current);
    }
  }

  _race(promise) {
    return Promise.race([promise, this._cancel.promise]);
  }

  _closeClient(client) {
    if (!client || this._closedClient === client) return this._clientClosePromise;
    this._closedClient = client;
    this._clientClosePromise = Promise.resolve().then(() => closeTranscriptClient(client));
    return this._clientClosePromise;
  }
}
