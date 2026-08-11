import { EventEmitter } from 'node:events';

export const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

export const runtimeError = (code) => Object.assign(new Error(code), { code });

export const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export class ManualTimers {
  constructor() {
    this.nextId = 0;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) { this.tasks.delete(id); }

  count(delay) {
    return [...this.tasks.values()].filter((task) => task.delay === delay).length;
  }

  async run(delay) {
    const entry = [...this.tasks.entries()].find(([, task]) => task.delay === delay);
    if (!entry) throw new Error(`missing timer ${delay}`);
    this.tasks.delete(entry[0]);
    entry[1].callback();
    await flush();
  }
}

export const sessionSnapshot = (revision = 1) => ({
  type: 'session_snapshot',
  snapshot: {
    version: '0.8.0',
    protocol: 19,
    workspaces: [{ workspace_id: 'w1', number: 1, label: 'Workspace', pane_count: 1,
      tab_count: 1, agent_status: 'working', focused: true }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: 'Tab', pane_count: 1,
      agent_status: 'working', focused: true }],
    agents: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', name: 'Agent',
      display_agent: 'Agent', agent_status: 'working', title: 'Title', focused: true, revision }],
  },
});

export class ContractRuntimeClient extends EventEmitter {
  constructor(name, response) {
    super();
    this.name = name;
    this.response = response;
    this.calls = [];
    this.closed = 0;
    this.connected = false;
  }

  onEvent(callback) { this.on('event', callback); return () => this.off('event', callback); }

  async connect() { this.connected = true; }

  request(method, params) {
    this.calls.push({ method, params });
    if (this.calls.length > 1) return Promise.reject(runtimeError('ERR_SECOND_REQUEST'));
    if (method === 'events.subscribe') {
      return Promise.reject(runtimeError('ERR_EVENTS_SUBSCRIBE_FORBIDDEN'));
    }
    if (method !== 'session.snapshot') return Promise.reject(runtimeError('ERR_UNEXPECTED_REQUEST'));
    return Promise.resolve(this.response);
  }

  close() { this.closed += 1; this.connected = false; }
}
