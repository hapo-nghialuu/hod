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

function settingsService(overrides = {}) {
  return {
    async get(workspaceId = null) {
      return {
        projects: [{ workspaceId: 'w1', label: 'Workspace' }], selectedWorkspaceId: workspaceId,
        hod: { roles: [{ role: 'impl', status: workspaceId ? 'different' : 'missing', unsafe: false }] },
        herdr: { scope: 'global', settings: [] },
      };
    },
    async postHod(body) { return { role: body.role, status: 'matches', unsafe: false }; },
    async postHerdr(body) { return { setting: { key: body.key, value: body.value } }; },
    ...overrides,
  };
}

test('state exposes global observer capabilities and settings routes select by workspace ID', async () => {
  const calls = []; const controller = createGlobalObserverApiController({ runtimeStore: makeStore(), settingsController: settingsService({
    async get(workspaceId) { calls.push(['get', workspaceId]); return settingsService().get(workspaceId); },
    async postHod(body) { calls.push(['hod', body]); return settingsService().postHod(body); },
  }) });
  const state = await controller.handle({ method: 'GET', path: '/api/state' });
  assert.deepEqual(state.body.capabilities, GLOBAL_OBSERVER_CAPABILITIES);
  const initial = await controller.handle({ method: 'GET', path: '/api/settings' });
  assert.equal(initial.status, 200); assert.equal(initial.body.selectedWorkspaceId, null);
  assert.equal(initial.body.projects[0].workspaceId, 'w1');
  assert.equal(initial.body.hod.roles[0].status, 'missing');
  assert.equal(JSON.stringify(initial.body).includes('/'), false);
  const selected = await controller.handle({ method: 'GET', path: '/api/settings?workspaceId=w1' });
  assert.equal(selected.status, 200); assert.equal(selected.body.selectedWorkspaceId, 'w1');
  assert.deepEqual(calls, [['get', null], ['get', 'w1']]);
  assert.deepEqual(await controller.handle({ method: 'POST', path: '/api/settings/hod', body: {
    workspaceId: 'w1', role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE', projectRoot: '/tmp/escape',
  } }), { status: 400, body: { error: { code: 'ERR_INVALID_BODY', message: 'Request body is invalid' } } });
  assert.deepEqual(await controller.handle({ method: 'GET', path: '/api/settings?workspaceId=w1&cwd=/tmp/escape' }), {
    status: 400, body: { error: { code: 'ERR_INVALID_QUERY', message: 'Settings query is invalid' } },
  });
  assert.equal((await controller.handle({ method: 'POST', path: '/api/settings/hod?projectRoot=/tmp/escape', body: {
    workspaceId: 'w1', role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE',
  } })).body.error.code, 'ERR_INVALID_QUERY');
  for (const [path, body] of [
    ['/api/settings/hod', { workspaceId: 'w1', role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE', secret: 'drop' }],
    ['/api/settings/herdr', { workspaceId: 'w1', key: 'theme.name', value: 'terminal', confirmation: 'APPLY HERDR SETTING', worktreePath: '/tmp/escape' }],
  ]) {
    assert.deepEqual(await controller.handle({ method: 'POST', path, body }), {
      status: 400, body: { error: { code: 'ERR_INVALID_BODY', message: 'Request body is invalid' } },
    });
  }
  assert.deepEqual(calls, [['get', null], ['get', 'w1']]);
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
