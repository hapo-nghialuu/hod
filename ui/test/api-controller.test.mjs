import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeStore } from '../server/runtime-store.mjs';
import { createApiController } from '../server/api-controller.mjs';

function store() {
  const runtime = new RuntimeStore();
  runtime.replaceSnapshot({
    workspaces: [{ workspace_id: 'workspace-1', number: 1, label: 'Main', pane_count: 1, tab_count: 1, agent_status: 'working', focused: true }],
    tabs: [{ tab_id: 'tab-1', workspace_id: 'workspace-1', number: 1, label: 'Tab', pane_count: 1, agent_status: 'working', focused: true }],
    agents: [{ pane_id: 'pane-1', workspace_id: 'workspace-1', tab_id: 'tab-1', name: 'Agent', agent_status: 'working', focused: true, revision: 1 }],
  });
  return runtime;
}

function settings(overrides = {}) {
  return {
    async get() { return { hod: { roles: [] }, herdr: { settings: [] } }; },
    async postHod(body) { return { role: body.role, status: 'matches', unsafe: false }; },
    async postHerdr(body) { return { setting: { key: body.key, value: body.value, source: 'config', metadata: {} }, backupCreated: false, restartRequired: false }; },
    ...overrides,
  };
}

function request(method, path, body) { return { method, path, body }; }

test('GET state/settings and transcript selection match public frontend contracts', async () => {
  const runtime = store();
  let selectedPane;
  const controller = createApiController({
    runtimeStore: runtime,
    settingsController: settings(),
    selectTranscript: async (paneId) => { selectedPane = paneId; return { paneId, text: 'visible', revision: 3, gap: false, secret: 'drop' }; },
  });
  const state = await controller.handle(request('GET', '/api/state'));
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, runtime.getSnapshot());
  const settingState = await controller.handle(request('GET', '/api/settings'));
  assert.deepEqual(settingState.body, { hod: { roles: [] }, herdr: { settings: [] } });
  const transcript = await controller.handle(request('POST', '/api/transcript/select', { paneId: ' pane-1 ' }));
  assert.deepEqual(transcript, { status: 200, body: { paneId: 'pane-1', text: 'visible', revision: 3, gap: false } });
  assert.equal(selectedPane, 'pane-1');
  assert.equal(runtime.getSnapshot().selectedPaneId, 'pane-1');
});

test('invalid bodies, unknown panes, and unhandled routes are stable', async () => {
  const controller = createApiController({ runtimeStore: store(), settingsController: settings() });
  assert.deepEqual(await controller.handle(request('POST', '/api/transcript/select', { paneId: ' ' })), {
    status: 400, body: { error: { code: 'ERR_INVALID_PANE_ID', message: 'paneId is invalid' } },
  });
  assert.equal((await controller.handle(request('POST', '/api/transcript/select', { paneId: 'missing' }))).status, 404);
  assert.deepEqual(await controller.handle(request('POST', '/api/settings/hod', null)), {
    status: 400, body: { error: { code: 'ERR_INVALID_BODY', message: 'Request body is invalid' } },
  });
  assert.equal(await controller.handle(request('GET', '/api/nope')), null);
});

test('mutation routes delegate and redact thrown sensitive errors', async () => {
  const calls = [];
  const controller = createApiController({
    runtimeStore: store(),
    settingsController: settings({
      async postHod(body) { calls.push(['hod', body]); return { role: 'impl', status: 'matches', unsafe: false }; },
      async postHerdr(body) { calls.push(['herdr', body]); return { setting: { key: body.key, value: body.value, source: 'config', metadata: {} } }; },
    }),
  });
  assert.equal((await controller.handle(request('POST', '/api/settings/hod', { role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE', secret: 'drop' }))).status, 200);
  assert.equal((await controller.handle(request('POST', '/api/settings/herdr', { key: 'theme.name', value: 'terminal', confirmation: 'APPLY HERDR SETTING', secret: 'drop' }))).status, 200);
  assert.deepEqual(calls, [
    ['hod', { role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE' }],
    ['herdr', { key: 'theme.name', value: 'terminal', confirmation: 'APPLY HERDR SETTING' }],
  ]);

  const failing = createApiController({ runtimeStore: store(), settingsController: settings({
    async postHod() { throw new Error('TOKEN /private/workspace argv terminal output'); },
  }) });
  const result = await failing.handle(request('POST', '/api/settings/hod', { role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE' }));
  assert.deepEqual(result, { status: 500, body: { error: { code: 'ERR_SETTINGS_UPDATE', message: 'Unable to update settings' } } });
  assert.equal(JSON.stringify(result).includes('TOKEN'), false);
});
