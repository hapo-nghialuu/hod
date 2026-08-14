import { clearChildren, createElement, setAttribute } from './dom-helpers.mjs';
import { createConfirmDialog } from './confirm-dialog.mjs';
import { createProjectSelector, projectRows } from './settings-project-selector.mjs';
import { ACTIONS } from './ui-store.mjs';

const ROLES = Object.freeze(['controller', 'impl', 'reviewer']);
const SOURCES = new Set(['config', 'default', 'env', 'file', 'fallback', 'herdr', 'runtime', 'system', 'cli']);
const CONNECTION_RESET_STATUSES = new Set(['connecting', 'reconnecting', 'disconnected']);

function resetsWorkspaceSelection(action) {
  if (action?.type === ACTIONS.RECONNECTING) return true;
  if (action?.type !== ACTIONS.CONNECTION) return false;
  const connection = action.connection ?? action.payload;
  const status = typeof connection === 'string' ? connection : connection?.status ?? connection?.state;
  return CONNECTION_RESET_STATUSES.has(status);
}

function statusClass(status) {
  return status === 'matches' || status === 'ok' ? 'status-ok' : status === 'different' || status === 'invalid' ? 'status-err' : 'status-warn';
}
function roleRows(settings) {
  const rows = settings?.hod?.roles;
  if (Array.isArray(rows)) { const byRole = new Map(rows.map((row) => [String(row?.role ?? ''), row])); return ROLES.map((role) => byRole.get(role) ?? { role, status: 'missing', unsafe: false }); }
  if (rows && typeof rows === 'object') return ROLES.map((role) => ({ role, ...(rows[role] ?? { status: 'missing', unsafe: false }) }));
  return ROLES.map((role) => ({ role, status: 'missing', unsafe: false }));
}
function herdrRows(settings) {
  const preferred = settings?.herdr?.settings;
  if (Array.isArray(preferred)) return preferred;
  if (preferred && typeof preferred === 'object') return Object.entries(preferred).map(([key, item]) => item && typeof item === 'object' && 'value' in item ? { key, ...item } : { key, value: item });
  return Array.isArray(settings?.herdr?.items) ? settings.herdr.items : [];
}
function projectScoped(settings) {
  if (!settings || typeof settings !== 'object') return true;
  return Object.hasOwn(settings, 'selectedWorkspaceId') || Array.isArray(settings.projects) || Array.isArray(settings.workspaces);
}
function roleAction(status, unsafe) {
  if (unsafe) return { label: '[UNSAFE]', force: false, disabled: true };
  if (status === 'matches') return { label: '[OK]', force: false, disabled: true };
  if (status === 'different') return { label: '[OVERWRITE]', force: true, disabled: false };
  return { label: '[INSTALL]', force: false, disabled: false };
}
export function settingControlId(key, index = 0) {
  const codepoints = [...String(key)].map((char) => char.codePointAt(0).toString(16)).join('-') || 'setting';
  return `herdr-setting-${codepoints}-${index}`;
}

function roleRow(documentRef, item, pending, projectSelected) {
  const role = String(item?.role ?? 'role'); const status = String(item?.status ?? 'missing'); const unsafe = item?.unsafe === true; const action = roleAction(status, unsafe);
  const button = createElement('button', { class: 'bracket-button settings-action', type: 'button', 'data-action': 'role-save', 'data-role': role, 'data-force': action.force ? 'true' : 'false', disabled: action.disabled || pending || !projectSelected }, [action.label], documentRef);
  return createElement('article', { class: 'settings-row role-row' }, [
    createElement('strong', { class: 'setting-key' }, [role], documentRef),
    createElement('span', { class: `tag ${statusClass(unsafe ? 'invalid' : status)}` }, [unsafe ? '[UNSAFE] disabled' : `[${status.toUpperCase()}]`], documentRef), button,
  ], documentRef);
}
function settingType(item) {
  const type = item?.metadata?.type;
  if (type === 'boolean' || type === 'integer' || type === 'string') return type;
  return typeof item?.value === 'boolean' ? 'boolean' : Number.isInteger(item?.value) ? 'integer' : 'string';
}
function inputFor(documentRef, item, id) {
  const metadata = item?.metadata ?? {}; const type = settingType(item);
  const attrs = { id, class: 'setting-control', 'data-setting-input': '', type: type === 'boolean' ? 'checkbox' : type === 'integer' ? 'number' : 'text' };
  let control;
  if (type === 'string' && Array.isArray(metadata.enum)) {
    control = createElement('select', attrs, [], documentRef);
    for (const value of metadata.enum) control.appendChild(createElement('option', { value: String(value) }, [String(value)], documentRef));
    control.value = String(item?.value ?? metadata.default ?? '');
  } else {
    control = createElement('input', attrs, [], documentRef);
    if (type === 'boolean') control.checked = item?.value === true; else control.value = String(item?.value ?? metadata.default ?? '');
  }
  if (metadata.min !== undefined) setAttribute(control, 'min', metadata.min);
  if (metadata.max !== undefined) setAttribute(control, 'max', metadata.max);
  return control;
}
function readValue(control, item) { const type = settingType(item); return type === 'boolean' ? control.checked === true : type === 'integer' ? Number(control.value) : String(control.value ?? ''); }
function settingRow(documentRef, item, pending, index) {
  const key = String(item?.key ?? 'setting'); const metadata = item?.metadata ?? {}; const source = typeof item?.source === 'string' ? item.source.toLowerCase() : ''; const valid = SOURCES.has(source); const id = settingControlId(key, index); const control = inputFor(documentRef, item, id);
  const save = createElement('button', { class: 'bracket-button settings-action', type: 'button', 'data-action': 'setting-save', disabled: pending || !valid }, ['[ APPLY ]'], documentRef);
  control.setAttribute?.('data-setting-key', key); if (!valid) control.disabled = true;
  return createElement('article', { class: `settings-row herdr-row${valid ? '' : ' is-invalid'}` }, [
    createElement('label', { class: 'setting-label', for: id }, [key], documentRef),
    createElement('span', { class: `setting-source ${valid ? '' : 'status-err'}` }, [valid ? `SOURCE ${source}` : 'INVALID SOURCE'], documentRef),
    createElement('span', { class: 'setting-apply-mode' }, [metadata.restart === true ? 'RESTART' : 'RELOAD'], documentRef), control, save,
  ], documentRef);
}
function render(documentRef, root, settings, pending, selectedWorkspace) {
  clearChildren(root); const scoped = projectScoped(settings);
  if (scoped) root.appendChild(createProjectSelector(documentRef, settings, selectedWorkspace, pending.has('workspace')));
  const projectSelected = !scoped || (typeof selectedWorkspace === 'string' && selectedWorkspace !== '');
  const hod = createElement('section', { class: 'settings-section', 'aria-labelledby': 'hod-settings-title' }, [createElement('h3', { class: 'settings-subtitle', id: 'hod-settings-title' }, ['HOD ROLE PROFILES'], documentRef)], documentRef);
  for (const item of roleRows(settings)) hod.appendChild(roleRow(documentRef, item, pending.has(`role:${item.role}`), projectSelected));
  root.appendChild(hod);
  const herdr = createElement('section', { class: 'settings-section', 'aria-labelledby': 'herdr-settings-title' }, [createElement('h3', { class: 'settings-subtitle', id: 'herdr-settings-title' }, ['HERDR SETTINGS · GLOBAL'], documentRef)], documentRef);
  const rows = herdrRows(settings); if (!rows.length) herdr.appendChild(createElement('p', { class: 'empty-state' }, ['No Herdr settings reported.'], documentRef));
  rows.forEach((item, index) => herdr.appendChild(settingRow(documentRef, item, pending.has(`setting:${item.key}`), index))); root.appendChild(herdr);
}

export function createSettingsView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document; const store = options.store; const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="settings"]');
  if (!store || !root) return Object.freeze({ destroy() {} });
  const confirm = options.confirmDialog ?? createConfirmDialog({ documentRef }); const pending = new Set(); let selectionRequestId = 0; let destroyed = false;
  const selectedWorkspace = () => store.getState().selectedWorkspace ?? null; const ownsSelection = (requestId) => !destroyed && requestId === selectionRequestId;
  const renderCurrent = (state = store.getState()) => { if (!destroyed) render(documentRef, root, state.settings, pending, state.selectedWorkspace); };
  const onWorkspaceSelect = async (workspaceId) => {
    const requestId = ++selectionRequestId; pending.add('workspace'); renderCurrent();
    try {
      options.onWorkspaceStart?.(workspaceId);
      const settings = await options.onWorkspaceSelect?.(workspaceId);
      const responseWorkspace = settings?.selectedWorkspaceId;
      const requestedWorkspace = workspaceId == null ? null : String(workspaceId);
      if (Object.hasOwn(settings ?? {}, 'selectedWorkspaceId')
        && (responseWorkspace == null ? null : String(responseWorkspace)) !== requestedWorkspace) {
        throw Object.assign(new Error('Selected workspace response is stale'), { code: 'ERR_STALE_SETTINGS' });
      }
      if (!ownsSelection(requestId)) return;
      store.dispatch({ type: ACTIONS.SETTINGS_REPLACE, settings });
      if (!ownsSelection(requestId)) return;
      store.dispatch({ type: ACTIONS.WORKSPACE_SET, selectedWorkspace: workspaceId });
      if (ownsSelection(requestId)) options.onWorkspaceLoaded?.(workspaceId);
    } catch (error) { if (ownsSelection(requestId)) options.onWorkspaceError?.(error); }
    finally { if (ownsSelection(requestId)) { pending.delete('workspace'); renderCurrent(); } }
  };
  const onHodSave = async (role, force) => {
    const scoped = projectScoped(store.getState().settings); const workspaceId = selectedWorkspace(); if (scoped && !workspaceId) return; const key = `role:${role}`; if (pending.has(key)) return; pending.add(key); renderCurrent(); const token = force ? 'OVERWRITE HOD ROLE' : 'INSTALL HOD ROLE';
    try {
      if (await confirm.confirm({ title: 'Confirm HOD role', message: `${token} · ${role}` })) {
        const request = { role, force, confirmation: token }; if (scoped) request.workspaceId = workspaceId; await options.onHodSave?.(request);
      }
    }
    finally { pending.delete(key); renderCurrent(); }
  };
  const onHerdrSave = async (item, control) => {
    const scoped = projectScoped(store.getState().settings); const workspaceId = selectedWorkspace(); const key = `setting:${item.key}`; if (pending.has(key)) return; pending.add(key); renderCurrent();
    try {
      if (await confirm.confirm({ title: 'Apply Herdr setting', message: `APPLY HERDR SETTING · ${item.key}` })) {
        const request = { key: item.key, value: readValue(control, item), confirmation: 'APPLY HERDR SETTING' }; if (scoped) request.workspaceId = workspaceId; await options.onHerdrSave?.(request);
      }
    }
    finally { pending.delete(key); renderCurrent(); }
  };
  const onChange = (event) => { const select = event.target?.closest?.('[data-action="settings-project"]'); if (select && (!root.contains || root.contains(select))) void onWorkspaceSelect(select.value || null); };
  const onClick = (event) => {
    const button = event.target?.closest?.('[data-action]'); if (!button || (root.contains && !root.contains(button))) return;
    if (button.getAttribute('data-action') === 'role-save') { void onHodSave(button.getAttribute('data-role'), button.getAttribute('data-force') === 'true').catch(() => {}); return; }
    if (button.getAttribute('data-action') === 'setting-save') {
      const row = button.closest?.('.herdr-row'); const control = row?.querySelector?.('[data-setting-input]'); const key = row?.querySelector?.('[data-setting-key]')?.getAttribute?.('data-setting-key'); const item = herdrRows(store.getState().settings).find((candidate) => String(candidate.key) === key);
      if (item && control) void onHerdrSave(item, control).catch(() => {});
    }
  };
  root.addEventListener?.('click', onClick); root.addEventListener?.('change', onChange);
  const onStoreChange = (state, action) => {
    if (destroyed) return;
    if (resetsWorkspaceSelection(action)) { selectionRequestId += 1; pending.delete('workspace'); }
    renderCurrent(state);
  };
  const unsubscribe = store.subscribe(onStoreChange); renderCurrent();
  return Object.freeze({ destroy() { destroyed = true; selectionRequestId += 1; pending.clear(); unsubscribe(); root.removeEventListener?.('click', onClick); root.removeEventListener?.('change', onChange); confirm.destroy?.(); } });
}
export const mountSettingsView = createSettingsView;
export { herdrRows, roleRows, projectRows };
