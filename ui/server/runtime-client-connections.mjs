const runtimeError = (code) => Object.assign(new Error(code), { code });

async function closeClient(client) {
  const close = typeof client?.close === 'function' ? client.close
    : (typeof client?.disconnect === 'function' ? client.disconnect : null);
  if (!close) return;
  try { await close.call(client); } catch {}
}

function operationFor(client) {
  let closed = false;
  return {
    client,
    detached: false,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeClient(client);
    },
  };
}

export class RuntimeClientConnections {
  constructor({ createClient, isCurrent }) {
    this._createClient = createClient;
    this._isCurrent = isCurrent;
    this.rpcClient = null;
    this.subscriberClient = null;
    this._operation = null;
    this._pending = null;
    this._active = null;
  }

  async requestSnapshot(token, options) {
    if (this._pending) throw runtimeError('ERR_RUNTIME_BUSY');
    const operation = { client: null, detached: false, close: async () => {} };
    this._operation = operation;
    const pending = this._runSnapshot(token, options, operation);
    this._pending = pending;
    try { return await pending; }
    finally {
      if (this._pending === pending) this._pending = null;
      if (this._operation === operation) this._operation = null;
    }
  }

  async _runSnapshot(token, options, operation) {
    const client = await this._createClient(options);
    if (!client || typeof client.connect !== 'function' || typeof client.request !== 'function') {
      throw runtimeError('ERR_RUNTIME_CLIENT');
    }
    operation.client = client;
    operation.close = operationFor(client).close;
    if (operation.detached || !this._isCurrent(token)) {
      await operation.close();
      return null;
    }
    this._active = operation;
    this.rpcClient = client;
    try {
      await client.connect();
      const response = await client.request('session.snapshot', {});
      return this._isCurrent(token) ? response : null;
    } finally {
      if (this._active === operation) this._active = null;
      if (this.rpcClient === client) this.rpcClient = null;
      await operation.close();
    }
  }

  async close() {
    const operation = this._operation;
    this._operation = null;
    this._pending = null;
    if (!operation) return;
    operation.detached = true;
    if (this._active === operation) this._active = null;
    if (this.rpcClient === operation.client) this.rpcClient = null;
    await operation.close();
  }
}
