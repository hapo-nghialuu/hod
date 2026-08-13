import { normalize } from 'node:path';
import { discoverHerdr, EXPECTED_HERDR_PROTOCOL } from './herdr-discovery.mjs';
import { HerdrSocketClient, DEFAULT_REQUEST_TIMEOUT_MS } from './herdr-socket-client.mjs';
import { snapshotFromResponse } from './runtime-event-subscriptions.mjs';
import { canonicalDirectory, HOD_ROLE_SETTINGS_ERROR_CODES } from './settings/hod-role-inspector.mjs';
import { HOD_ROLES, createHodRoleSettings } from './settings/hod-role-settings.mjs';
import { createHerdrConfigSettings } from './settings/herdr-config-settings.mjs';
import { createSettingsController } from './settings/settings-controller.mjs';

export const GLOBAL_SETTINGS_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 512;
const PATH_KEYS = new Set([
  'path', 'cwd', 'foreground_cwd', 'foregroundCwd', 'project', 'projectRoot', 'project_root',
  'checkoutPath', 'checkout_path', 'worktree', 'worktreeRoot', 'worktree_root', 'directory', 'root',
]);

export class GlobalSettingsError extends Error {
  constructor(code, message = 'Global settings request failed') {
    super(message); this.name = 'GlobalSettingsError'; this.code = code;
  }
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message) { throw new GlobalSettingsError(code, message); }
function text(value, max, code) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code, 'Workspace metadata is invalid');
  return value.trim();
}
function field(item, snake, camel = snake) { return item?.[snake] ?? item?.[camel]; }
function workspaceId(item) { return text(field(item, 'workspace_id', 'workspaceId') ?? item?.id, MAX_ID_LENGTH, 'ERR_WORKSPACE_ID'); }
function paneWorkspaceId(item) {
  if (!record(item)) fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is invalid');
  return text(field(item, 'workspace_id', 'workspaceId') ?? item?.workspace?.id,
    MAX_ID_LENGTH, 'ERR_WORKSPACE_SNAPSHOT');
}
function panesOf(snapshot) { return Array.isArray(snapshot?.agents) ? snapshot.agents : (Array.isArray(snapshot?.panes) ? snapshot.panes : []); }
function pathValue(value) { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null; }
function normalizedPath(value) {
  const path = pathValue(value);
  if (!path) return null;
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}
function bounded(value, timeoutMs, code) {
  const timer = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : GLOBAL_SETTINGS_TIMEOUT_MS;
  let handle;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => { handle = setTimeout(() => reject(new GlobalSettingsError(code)), timer); }),
  ]).finally(() => clearTimeout(handle));
}

export function workspaceChoices(snapshot) {
  if (!record(snapshot) || !Array.isArray(snapshot.workspaces)) fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is invalid');
  const seen = new Set();
  return snapshot.workspaces.map((item) => {
    if (!record(item)) fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is invalid');
    const id = workspaceId(item);
    if (seen.has(id)) fail('ERR_WORKSPACE_AMBIGUOUS', 'Workspace identity is ambiguous');
    seen.add(id);
    const labelValue = item.label;
    const label = typeof labelValue === 'string' && labelValue.trim() !== ''
      ? labelValue.trim().slice(0, MAX_LABEL_LENGTH) : id;
    return { workspaceId: id, label };
  });
}

export function selectWorkspaceCandidate(snapshot, requestedId) {
  const id = text(requestedId, MAX_ID_LENGTH, 'ERR_WORKSPACE_ID');
  const choices = workspaceChoices(snapshot);
  const index = choices.findIndex((item) => item.workspaceId === id);
  if (index < 0) fail('ERR_WORKSPACE_NOT_FOUND', 'Workspace is not current');
  const workspace = snapshot.workspaces[index];
  const worktree = workspace.worktree;
  if (record(worktree) && Object.hasOwn(worktree, 'checkout_path')) {
    const checkoutPath = pathValue(worktree.checkout_path);
    if (!checkoutPath) fail('ERR_WORKSPACE_UNSAFE', 'Workspace checkout is unsafe');
    return { workspaceId: id, label: choices[index].label, path: checkoutPath, source: 'checkout' };
  }

  const matching = panesOf(snapshot).filter((pane) => paneWorkspaceId(pane) === id);
  const rootControllers = matching.filter((pane) => {
    const tokens = pane?.tokens;
    return record(tokens) && tokens.hod_role === 'controller' && !Object.hasOwn(tokens, 'hod_parent') && pathValue(pane.cwd);
  });
  if (rootControllers.length > 1) fail('ERR_WORKSPACE_AMBIGUOUS', 'Workspace coordinator is ambiguous');
  if (rootControllers.length === 1) {
    const cwd = pathValue(rootControllers[0].cwd);
    return { workspaceId: id, label: choices[index].label, path: cwd, source: 'controller' };
  }

  const targets = new Set(matching.map((pane) => normalizedPath(pane?.cwd)).filter(Boolean));
  if (targets.size > 1) fail('ERR_WORKSPACE_AMBIGUOUS', 'Workspace directory is ambiguous');
  const cwd = targets.values().next().value;
  if (!cwd) fail('ERR_WORKSPACE_UNSAFE', 'Workspace directory is unavailable');
  return { workspaceId: id, label: choices[index].label, path: cwd, source: 'pane' };
}

export async function resolveWorkspaceTarget(snapshot, requestedId, options = {}) {
  const candidate = selectWorkspaceCandidate(snapshot, requestedId);
  const canonicalize = options.canonicalize ?? ((path) => canonicalDirectory(path, HOD_ROLE_SETTINGS_ERROR_CODES.CONFIG));
  let projectRoot;
  try { projectRoot = await canonicalize(candidate.path); } catch { fail('ERR_WORKSPACE_UNSAFE', 'Workspace directory is unsafe'); }
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') fail('ERR_WORKSPACE_UNSAFE', 'Workspace directory is unsafe');
  return { workspaceId: candidate.workspaceId, label: candidate.label, projectRoot };
}

export function createAuthoritativeSnapshotReader(options = {}) {
  const discover = options.discover ?? discoverHerdr;
  const createClient = options.clientFactory ?? ((clientOptions) => new HerdrSocketClient(clientOptions));
  const timeoutMs = options.requestTimeoutMs ?? GLOBAL_SETTINGS_TIMEOUT_MS;
  const expectedProtocol = options.expectedProtocol ?? EXPECTED_HERDR_PROTOCOL;
  return async function readSnapshot() {
    let client;
    try {
      const discovered = await bounded(discover(), timeoutMs, 'ERR_WORKSPACE_SNAPSHOT');
      if (!record(discovered) || typeof discovered.socketPath !== 'string' || discovered.socketPath.trim() === '') {
        fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is unavailable');
      }
      client = await bounded(createClient({ socketPath: discovered.socketPath, requestTimeoutMs: timeoutMs }), timeoutMs, 'ERR_WORKSPACE_SNAPSHOT');
      if (!client || typeof client.connect !== 'function' || typeof client.request !== 'function') fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is unavailable');
      await bounded(client.connect(), timeoutMs, 'ERR_WORKSPACE_SNAPSHOT');
      const response = await bounded(client.request('session.snapshot', {}, { timeoutMs }), timeoutMs, 'ERR_WORKSPACE_SNAPSHOT');
      const snapshot = snapshotFromResponse(response);
      if (!record(snapshot) || snapshot.protocol !== expectedProtocol) fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is incompatible');
      return snapshot;
    } catch (error) {
      if (error instanceof GlobalSettingsError) throw error;
      fail('ERR_WORKSPACE_SNAPSHOT', 'Workspace snapshot is unavailable');
    } finally {
      try { await bounded(client?.close?.(), timeoutMs, 'ERR_WORKSPACE_SNAPSHOT'); } catch {}
    }
  };
}

const inertHod = Object.freeze({
  async list() { return HOD_ROLES.map((role) => ({ role, status: 'missing', unsafe: false })); },
  async install() { fail('ERR_WORKSPACE_REQUIRED', 'A workspace must be selected'); },
});
const emptyHerdr = Object.freeze({ async list() { return []; }, async update() { fail('ERR_SETTINGS_UNAVAILABLE'); } });

function settingsFor(hod, herdr) { return createSettingsController({ hodRoleSettings: hod, herdrConfigSettings: herdr }); }
function stripWorkspace(body) {
  const { workspaceId: _workspaceId, ...input } = body;
  return input;
}
function assertSafeBody(body) {
  if (!record(body)) fail('ERR_INVALID_BODY', 'Request body is invalid');
  for (const key of Object.keys(body)) if (PATH_KEYS.has(key)) fail('ERR_INVALID_BODY', 'Request body is invalid');
}

export function createGlobalSettingsController(options = {}) {
  const readSnapshot = options.readSnapshot ?? options.snapshotReader;
  const globalHerdr = options.globalHerdrConfigSettings ?? options.herdrConfigSettings ?? emptyHerdr;
  const createProjectHod = options.createProjectHod ?? ((projectRoot) => {
    if (!options.hodRoleSettingsOptions) fail('ERR_SETTINGS_UNAVAILABLE');
    return createHodRoleSettings({ ...options.hodRoleSettingsOptions, projectRoot });
  });
  if (typeof readSnapshot !== 'function') throw new TypeError('authoritative snapshot reader is required');
  let mutationQueue = Promise.resolve();
  const targetOptions = options.canonicalize ? { canonicalize: options.canonicalize } : {};
  const serialize = (operation) => { const result = mutationQueue.then(operation); mutationQueue = result.catch(() => {}); return result; };

  async function get(workspaceId = null) {
    const snapshot = await readSnapshot();
    const projects = workspaceChoices(snapshot);
    const selectedWorkspaceId = workspaceId == null ? null : text(workspaceId, MAX_ID_LENGTH, 'ERR_WORKSPACE_ID');
    const hod = selectedWorkspaceId === null ? inertHod : createProjectHod((await resolveWorkspaceTarget(snapshot, selectedWorkspaceId, targetOptions)).projectRoot);
    const result = await settingsFor(hod, globalHerdr).get();
    return {
      projects, selectedWorkspaceId,
      hod: { roles: result.hod.roles },
      herdr: { scope: 'global', settings: result.herdr.settings },
    };
  }

  function postHod(body = {}) {
    return serialize(async () => {
      assertSafeBody(body);
      const workspaceId = text(body.workspaceId, MAX_ID_LENGTH, 'ERR_WORKSPACE_REQUIRED');
      const snapshot = await readSnapshot();
      const target = await resolveWorkspaceTarget(snapshot, workspaceId, targetOptions);
      const hod = createProjectHod(target.projectRoot);
      return settingsFor(hod, globalHerdr).postHod(stripWorkspace(body));
    });
  }
  function postHerdr(body = {}) {
    return serialize(async () => {
      assertSafeBody(body);
      return settingsFor(inertHod, globalHerdr).postHerdr(stripWorkspace(body));
    });
  }
  return Object.freeze({ get, getSettings: get, postHod, updateHod: postHod, postHerdr, updateHerdr: postHerdr });
}

export const createGlobalSettings = createGlobalSettingsController;
