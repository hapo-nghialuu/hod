import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAuthoritativeSnapshotReader,
  createGlobalSettingsController,
  resolveWorkspaceTarget,
  selectWorkspaceCandidate,
  workspaceChoices,
} from '../server/global-settings.mjs';

const snapshot = (workspace = {}) => ({
  protocol: 19,
  workspaces: [{ workspace_id: 'w1', label: 'One', ...workspace }],
  agents: [],
});

test('authoritative settings snapshots use a fresh bounded socket request', async () => {
  const calls = []; let discoveries = 0; let closes = 0;
  const reader = createAuthoritativeSnapshotReader({
    requestTimeoutMs: 20,
    discover: async () => { discoveries += 1; return { socketPath: `/private/herdr-${discoveries}.sock` }; },
    clientFactory: ({ socketPath }) => ({
      async connect() { calls.push(['connect', socketPath]); },
      async request(method) { calls.push(['request', method]); return { type: 'session_snapshot', snapshot: snapshot() }; },
      async close() { closes += 1; },
    }),
  });
  assert.equal((await reader()).workspaces[0].workspace_id, 'w1');
  assert.equal((await reader()).workspaces[0].workspace_id, 'w1');
  assert.equal(discoveries, 2); assert.equal(closes, 2);
  assert.deepEqual(calls.map(([method]) => method), ['connect', 'request', 'connect', 'request']);
});

test('authoritative settings snapshot timeout fails closed', async () => {
  const reader = createAuthoritativeSnapshotReader({
    requestTimeoutMs: 5,
    discover: async () => ({ socketPath: '/private/herdr.sock' }),
    clientFactory: () => ({ async connect() {}, request() { return new Promise(() => {}); }, async close() {} }),
  });
  await assert.rejects(reader(), { code: 'ERR_WORKSPACE_SNAPSHOT' });
});

test('workspace target precedence uses checkout, root coordinator, then one normalized cwd target', async () => {
  const checkout = snapshot({ worktree: { checkout_path: '/checkout' } });
  assert.deepEqual(selectWorkspaceCandidate(checkout, 'w1'), {
    workspaceId: 'w1', label: 'One', path: '/checkout', source: 'checkout',
  });
  const coordinator = snapshot({ worktree: {} });
  coordinator.agents = [
    { workspace_id: 'w1', cwd: '/pane', foreground_cwd: '/wrong', tokens: { hod_role: 'controller', hod_parent: 'child' } },
    { workspace_id: 'w1', cwd: '/coordinator', foreground_cwd: '/wrong', tokens: { hod_role: 'controller' } },
    { workspace_id: 'w1', cwd: '/other', tokens: { hod_role: 'controller', hod_parent: 'child' } },
  ];
  assert.equal(selectWorkspaceCandidate(coordinator, 'w1').path, '/coordinator');
  const duplicateCwd = snapshot({ worktree: {} });
  duplicateCwd.agents = [
    { workspace_id: 'w1', foreground_cwd: '/injected', cwd: '/repo-a' },
    { workspace_id: 'w1', cwd: '/repo-a/.' },
  ];
  assert.equal(selectWorkspaceCandidate(duplicateCwd, 'w1').path, '/repo-a');
  const missingCoordinatorCwd = snapshot({ worktree: {} });
  missingCoordinatorCwd.agents = [
    { workspace_id: 'w1', foreground_cwd: '/injected', tokens: { hod_role: 'controller' } },
    { workspace_id: 'w1', cwd: '/fallback' },
  ];
  assert.deepEqual(selectWorkspaceCandidate(missingCoordinatorCwd, 'w1'), {
    workspaceId: 'w1', label: 'One', path: '/fallback', source: 'pane',
  });
  await assert.rejects(resolveWorkspaceTarget(snapshot({ worktree: { checkout_path: '/missing' } }), 'w1', {
    canonicalize: async () => { throw new Error('unsafe'); },
  }), { code: 'ERR_WORKSPACE_UNSAFE' });
});

test('membership, ambiguity, empty IDs, and unsafe paths fail closed', async () => {
  assert.deepEqual(workspaceChoices(snapshot()), [{ workspaceId: 'w1', label: 'One' }]);
  assert.throws(() => selectWorkspaceCandidate(snapshot(), ''), { code: 'ERR_WORKSPACE_ID' });
  assert.throws(() => selectWorkspaceCandidate(snapshot(), 'old'), { code: 'ERR_WORKSPACE_NOT_FOUND' });
  const ambiguous = snapshot({ worktree: {} });
  ambiguous.agents = [
    { workspace_id: 'w1', cwd: '/one', tokens: { hod_role: 'controller' } },
    { workspace_id: 'w1', cwd: '/two', tokens: { hod_role: 'controller' } },
  ];
  assert.throws(() => selectWorkspaceCandidate(ambiguous, 'w1'), { code: 'ERR_WORKSPACE_AMBIGUOUS' });
  const ambiguousFallback = snapshot({ worktree: {} });
  ambiguousFallback.agents = [{ workspace_id: 'w1', cwd: '/repo-a' }, { workspace_id: 'w1', cwd: '/repo-b' }];
  assert.throws(() => selectWorkspaceCandidate(ambiguousFallback, 'w1'), { code: 'ERR_WORKSPACE_AMBIGUOUS' });
  for (const workspace_id of [['w1'], { value: 'w1' }]) {
    const hostile = snapshot({ worktree: {} }); hostile.agents = [{ workspace_id, cwd: '/hostile' }];
    assert.throws(() => selectWorkspaceCandidate(hostile, 'w1'), { code: 'ERR_WORKSPACE_SNAPSHOT' });
  }
  assert.throws(() => selectWorkspaceCandidate(snapshot({ worktree: {} }), 'w1'), { code: 'ERR_WORKSPACE_UNSAFE' });
  assert.throws(() => selectWorkspaceCandidate(snapshot({ worktree: { checkout_path: ' ' } }), 'w1'), { code: 'ERR_WORKSPACE_UNSAFE' });
});

test('global settings never expose target paths and mutations resolve a fresh snapshot', async () => {
  const roots = ['/safe/one', '/safe/two']; let reads = 0; const hodRoots = []; const updates = [];
  const controller = createGlobalSettingsController({
    readSnapshot: async () => { reads += 1; return snapshot({ worktree: { checkout_path: roots[Math.min(reads - 1, 1)] } }); },
    canonicalize: async (projectRoot) => projectRoot,
    createProjectHod: (projectRoot) => {
      hodRoots.push(projectRoot);
      return {
        async list() { return [{ role: 'impl', status: 'missing', unsafe: false }]; },
        async install(input) { updates.push(input); return { role: input.role, status: 'matches', unsafe: false }; },
      };
    },
    globalHerdrConfigSettings: {
      async list() { return [{ key: 'theme.name', value: 'terminal', source: 'config', metadata: { type: 'string' } }]; },
      async update(input) { return { setting: { key: input.key, value: input.value, source: 'config', metadata: { type: 'string' } } }; },
    },
  });
  const initial = await controller.get();
  assert.equal(initial.selectedWorkspaceId, null);
  assert.equal(JSON.stringify(initial).includes('/safe/'), false);
  assert.equal(JSON.stringify(initial).includes('projectRoot'), false);
  await assert.rejects(controller.get('old'), { code: 'ERR_WORKSPACE_NOT_FOUND' });
  const selected = await controller.get('w1');
  assert.equal(selected.selectedWorkspaceId, 'w1');
  assert.equal(JSON.stringify(selected).includes('/safe/'), false);
  assert.deepEqual(hodRoots, ['/safe/two']);
  await assert.rejects(controller.postHod({ workspaceId: 'w1', role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE', cwd: '/unsafe' }), { code: 'ERR_INVALID_BODY' });
  await controller.postHod({ workspaceId: 'w1', role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE' });
  assert.deepEqual(updates, [{ role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE' }]);
  assert.deepEqual(hodRoots, ['/safe/two', '/safe/two']);
  assert.equal(reads, 4);
});
