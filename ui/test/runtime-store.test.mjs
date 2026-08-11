import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSnapshot, RuntimeSnapshotError } from '../server/runtime-state-normalizer.mjs';
import { RuntimeStore } from '../server/runtime-store.mjs';

const connection = { state: 'connected', version: '0.8.0', protocol: 19, errorCode: 'err_socket' };

function snapshot({ includeSecondPane = true } = {}) {
  const agents = [{
    pane_id: 'p-z', workspace_id: 'w-z', tab_id: 't-z', name: 'Zed', display_agent: 'Claude',
    agent_status: 'working', title: 'z title', focused: true, revision: 9,
    cwd: '/private/secret', foreground_cwd: '/private/secret', agent_session: { value: 'secret' },
    tokens: { secret: 'do-not-copy' }, terminal_id: 'tty-secret', worktree: '/private/worktree',
  }];
  if (includeSecondPane) agents.push({
    pane_id: 'p-a', workspace_id: 'w-a', tab_id: 't-a', name: null, display_agent: null,
    agent_status: 'idle', title: null, focused: false, revision: 2,
  });
  return {
    version: '0.8.0', protocol: 19,
    workspaces: [
      { workspace_id: 'w-z', number: 1, label: 'Z space', pane_count: 1, tab_count: 1, agent_status: 'working', focused: true },
      { workspace_id: 'w-a', number: 2, label: 'A space', pane_count: 1, tab_count: 1, agent_status: 'idle', focused: false },
    ],
    tabs: [
      { tab_id: 't-z', workspace_id: 'w-z', number: 1, label: 'Z tab', pane_count: 1, agent_status: 'working', focused: true },
      { tab_id: 't-a', workspace_id: 'w-a', number: 2, label: 'A tab', pane_count: 1, agent_status: 'idle', focused: false },
    ],
    agents,
  };
}

test('normalization sorts and exposes only the public redacted shape', () => {
  const normalized = normalizeSnapshot(snapshot(), connection);
  assert.deepEqual(normalized.connection, {
    state: 'connected', version: '0.8.0', protocol: 19, errorCode: 'ERR_SOCKET',
  });
  assert.deepEqual(normalized.workspaces.map(({ id, number }) => [id, number]), [['w-z', 1], ['w-a', 2]]);
  assert.deepEqual(normalized.tabs.map(({ id, number }) => [id, number]), [['t-z', 1], ['t-a', 2]]);
  assert.deepEqual(normalized.agents.map(({ paneId }) => paneId), ['p-z', 'p-a']);
  assert.deepEqual(normalized.agents[0], {
    paneId: 'p-z', workspaceId: 'w-z', tabId: 't-z', name: 'Zed', display: 'Claude',
    status: 'working', title: 'z title', focused: true, revision: 9,
  });
  for (const forbidden of ['cwd', 'foreground_cwd', 'agent_session', 'tokens', 'terminal_id', 'worktree']) {
    assert.equal(JSON.stringify(normalized).includes(forbidden), false, forbidden);
  }
});

test('replacement is authoritative, clears missing selection, and emits clones', () => {
  const store = new RuntimeStore();
  const changes = [];
  const eventLengths = [];
  store.onChange((value) => { changes.push(value); eventLengths.push(value.agents.length); value.agents.pop(); });
  store.replaceSnapshot(snapshot());
  store.selectPane('p-a');
  const input = snapshot({ includeSecondPane: false });
  store.replaceSnapshot(input);
  input.agents[0].name = 'mutated after replace';
  const current = store.getSnapshot();
  assert.equal(current.selectedPaneId, null);
  assert.deepEqual(current.agents.map(({ paneId }) => paneId), ['p-z']);
  assert.equal(current.agents[0].name, 'Zed');
  assert.equal(changes.length, 3);
  assert.equal(eventLengths[0], 2);
});

test('same-connection replacement keeps selection while its pane remains', () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot());
  store.selectPane('p-z');
  store.replaceSnapshot(snapshot({ includeSecondPane: false }));
  assert.equal(store.getSnapshot().selectedPaneId, 'p-z');
});

test('reconnect clears all runtime IDs before a fresh authoritative snapshot', () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot());
  store.selectPane('p-z');
  store.resetForReconnect({ errorCode: 'ERR_SOCKET' });
  assert.deepEqual(store.getSnapshot(), {
    connection: { state: 'reconnecting', version: '0.8.0', protocol: 19, errorCode: 'ERR_SOCKET' },
    workspaces: [], tabs: [], agents: [], selectedPaneId: null,
  });
  store.replaceSnapshot(snapshot({ includeSecondPane: false }));
  assert.equal(store.getSnapshot().selectedPaneId, null);
  assert.deepEqual(store.getSnapshot().agents.map(({ paneId }) => paneId), ['p-z']);
  store.clearRuntime();
  assert.equal(store.getSnapshot().connection.state, 'disconnected');
  assert.equal(store.getSnapshot().agents.length, 0);
});

test('returned snapshots and connection errors cannot mutate internal state', () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot());
  const copy = store.snapshot();
  copy.workspaces[0].label = 'changed';
  copy.agents.length = 0;
  store.setConnection({ state: 'reconnecting', error: 'raw secret /path', errorCode: 'bad code' });
  const current = store.getSnapshot();
  assert.equal(current.workspaces[0].label, 'Z space');
  assert.equal(current.agents.length, 2);
  assert.deepEqual(current.connection, {
    state: 'reconnecting', version: '0.8.0', protocol: 19, errorCode: 'ERR_CONNECTION',
  });
});

test('selection only accepts existing panes and stale state is rejected', () => {
  const store = new RuntimeStore();
  store.replaceSnapshot(snapshot());
  store.selectPane('missing');
  assert.equal(store.getSnapshot().selectedPaneId, null);
  store.selectPane('p-a');
  assert.equal(store.getSnapshot().selectedPaneId, 'p-a');
  assert.throws(() => normalizeSnapshot({ workspaces: [] }), (error) => error instanceof RuntimeSnapshotError);
  assert.throws(() => store.selectPane(42), (error) => error.code === 'ERR_RUNTIME_SNAPSHOT');
});

test('name fallback uses display_agent and then agent, and cross-workspace tabs are invalid', () => {
  const display = snapshot({ includeSecondPane: false });
  display.agents[0].name = null;
  display.agents[0].display_agent = 'Display name';
  assert.equal(normalizeSnapshot(display).agents[0].name, 'Display name');
  display.agents[0].display_agent = null;
  display.agents[0].agent = 'Agent name';
  assert.equal(normalizeSnapshot(display).agents[0].name, 'Agent name');

  const wrongWorkspace = snapshot({ includeSecondPane: false });
  wrongWorkspace.agents[0].tab_id = 't-a';
  assert.throws(() => normalizeSnapshot(wrongWorkspace), (error) => error instanceof RuntimeSnapshotError);
});
