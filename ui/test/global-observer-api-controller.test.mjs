import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeStore } from '../server/runtime-store.mjs';
import {
  createGlobalObserverApiController,
  GLOBAL_OBSERVER_CAPABILITIES,
} from '../server/global-observer-api-controller.mjs';

function makeStore() {
  const store = new RuntimeStore();
  store.replaceSnapshot({
    workspaces: [{ workspace_id: 'w1', number: 1, label: 'Workspace', pane_count: 1,
      tab_count: 1, agent_status: 'working', focused: true }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: 'Tab', pane_count: 1,
      agent_status: 'working', focused: true }],
    agents: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', name: 'Agent',
      agent_status: 'working', focused: true, revision: 1 }],
  });
  return store;
}

function protectedOptionFixture(runtimeStore) {
  const options = { runtimeStore };
  for (const name of [
    'settingsController', 'settings', 'hodRoleSettings', 'herdrConfigSettings',
    'project', 'projectRoot', 'config', 'configPath', 'templatesRoot',
  ]) {
    Object.defineProperty(options, name, {
      get() { throw new Error(`protected option touched: ${name}`); },
    });
  }
  return options;
}

test('state exposes explicit observer capabilities and no settings service is constructed', async () => {
  const controller = createGlobalObserverApiController(protectedOptionFixture(makeStore()));
  const state = await controller.handle({ method: 'GET', path: '/api/state' });
  assert.deepEqual(state.body.capabilities, GLOBAL_OBSERVER_CAPABILITIES);
  assert.equal('settingsController' in controller, false);
});

test('settings routes return ERR_ROUTE without settings I/O', async () => {
  const forbiddenStore = new Proxy({}, {
    get(_target, name) { throw new Error(`runtime/settings I/O touched: ${String(name)}`); },
  });
  const controller = createGlobalObserverApiController(protectedOptionFixture(forbiddenStore));
  for (const request of [
    { method: 'GET', path: '/api/settings' },
    { method: 'POST', path: '/api/settings/hod', body: { role: 'impl' } },
    { method: 'POST', path: '/api/settings/herdr', body: { key: 'theme.name', value: 'terminal' } },
  ]) {
    assert.deepEqual(await controller.handle(request), { status: 404, body: { error: { code: 'ERR_ROUTE' } } });
  }
});

test('transcript selection is read-only and strips unapproved fields', async () => {
  const store = makeStore();
  let selected;
  const controller = createGlobalObserverApiController({
    runtimeStore: store,
    selectTranscript: async (paneId) => {
      selected = paneId;
      return { paneId, text: 'visible', revision: 4, gap: false, secret: 'drop', command: 'drop' };
    },
  });
  const result = await controller.handle({ method: 'POST', path: '/api/transcript/select', body: { paneId: ' p1 ' } });
  assert.deepEqual(result, { status: 200, body: { paneId: 'p1', text: 'visible', revision: 4, gap: false } });
  assert.equal(selected, 'p1');
  assert.equal(store.getSnapshot().selectedPaneId, 'p1');
  assert.equal(await controller.handle({ method: 'POST', path: '/api/agent/control', body: {} }), null);
});

test('valid empty transcript at revision zero remains a success payload', async () => {
  const controller = createGlobalObserverApiController({ runtimeStore: makeStore(), selectTranscript: async (paneId) => ({
    paneId, text: '', revision: 0, secret: 'drop',
  }) });
  assert.deepEqual(await controller.handle({ method: 'POST', path: '/api/transcript/select', body: { paneId: 'p1' } }), {
    status: 200, body: { paneId: 'p1', text: '', revision: 0 },
  });
});

test('null and malformed selector results fail closed without leaking source details', async () => {
  for (const selected of [null, { paneId: 'p1', revision: 0 }, { paneId: 'other', text: 'x', revision: 0 },
    { paneId: 'p1', text: 'x', revision: -1 }]) {
    const controller = createGlobalObserverApiController({ runtimeStore: makeStore(), selectTranscript: async () => selected });
    const result = await controller.handle({ method: 'POST', path: '/api/transcript/select', body: { paneId: 'p1' } });
    assert.deepEqual(result, { status: 502, body: { error: { code: 'ERR_TRANSCRIPT_INVALID', message: 'Transcript response is invalid' } } });
    assert.doesNotMatch(JSON.stringify(result), /socket|path|private|secret/i);
  }
});
