import { clearChildren, createElement, setAttribute, textContent } from './dom-helpers.mjs';
import { createConfirmDialog } from './confirm-dialog.mjs';

const ROLES = Object.freeze(['controller', 'impl', 'reviewer']);
const SOURCES = new Set(['config', 'default', 'env', 'file', 'fallback', 'herdr', 'runtime', 'system', 'cli']);

function statusClass(status) {
  if (status === 'matches' || status === 'ok') return 'status-ok';
  if (status === 'different' || status === 'invalid') return 'status-err';
  return 'status-warn';
}

function roleRows(settings) {
  const rows = settings?.hod?.roles;
  if (Array.isArray(rows)) {
    const byRole = new Map(rows.map((row) => [String(row?.role ?? ''), row]));
    return ROLES.map((role) => byRole.get(role) ?? { role, status: 'missing', unsafe: false });
  }
  if (rows && typeof rows === 'object') return ROLES.map((role) => ({ role, ...(rows[role] ?? { status: 'missing', unsafe: false }) }));
  return ROLES.map((role) => ({ role, status: 'missing', unsafe: false }));
}

function herdrRows(settings) {
  const preferred = settings?.herdr?.settings;
  if (Array.isArray(preferred)) return preferred;
  if (preferred && typeof preferred === 'object') return Object.entries(preferred).map(([key, item]) => item && typeof item === 'object' && 'value' in item ? { key, ...item } : { key, value: item });
  if (Array.isArray(settings?.herdr?.items)) return settings.herdr.items;
  return [];
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

function roleRow(documentRef, item, pending) {
  const role = String(item?.role ?? 'role');
  const status = String(item?.status ?? 'missing');
  const unsafe = item?.unsafe === true;
  const action = roleAction(status, unsafe);
  const button = createElement('button', {
    class: 'bracket-button settings-action',
    type: 'button',
    'data-action': 'role-save',
    'data-role': role,
    'data-force': action.force ? 'true' : 'false',
    disabled: action.disabled || pending,
  }, [action.label], documentRef);
  return createElement('article', { class: 'settings-row role-row' }, [
    createElement('strong', { class: 'setting-key' }, [role], documentRef),
    createElement('span', { class: `tag ${statusClass(unsafe ? 'invalid' : status)}` }, [
      unsafe ? '[UNSAFE] disabled' : `[${status.toUpperCase()}]`,
    ], documentRef),
    button,
  ], documentRef);
}

function settingType(item) {
  const type = item?.metadata?.type;
  if (type === 'boolean' || type === 'integer' || type === 'string') return type;
  if (typeof item?.value === 'boolean') return 'boolean';
  if (Number.isInteger(item?.value)) return 'integer';
  return 'string';
}

function inputFor(documentRef, item, id) {
  const metadata = item?.metadata ?? {};
  const type = settingType(item);
  const attrs = { id, class: 'setting-control', 'data-setting-input': '', type: type === 'boolean' ? 'checkbox' : type === 'integer' ? 'number' : 'text' };
  let control;
  if (type === 'string' && Array.isArray(metadata.enum)) {
    control = createElement('select', attrs, [], documentRef);
    for (const value of metadata.enum) control.appendChild(createElement('option', { value: String(value) }, [String(value)], documentRef));
    control.value = String(item?.value ?? metadata.default ?? '');
  } else {
    control = createElement('input', attrs, [], documentRef);
    if (type === 'boolean') control.checked = item?.value === true;
    else control.value = String(item?.value ?? metadata.default ?? '');
  }
  if (metadata.min !== undefined) setAttribute(control, 'min', metadata.min);
  if (metadata.max !== undefined) setAttribute(control, 'max', metadata.max);
  return control;
}

function readValue(control, item) {
  const type = settingType(item);
  if (type === 'boolean') return control.checked === true;
  if (type === 'integer') return Number(control.value);
  return String(control.value ?? '');
}

function sourceState(item) {
  const source = typeof item?.source === 'string' ? item.source.toLowerCase() : '';
  return { source, valid: SOURCES.has(source) };
}

function settingRow(documentRef, item, pending, index) {
  const key = String(item?.key ?? 'setting');
  const metadata = item?.metadata ?? {};
  const source = sourceState(item);
  const id = settingControlId(key, index);
  const control = inputFor(documentRef, item, id);
  const save = createElement('button', {
    class: 'bracket-button settings-action',
    type: 'button',
    'data-action': 'setting-save',
    disabled: pending || !source.valid,
  }, ['[ APPLY ]'], documentRef);
  control.setAttribute?.('data-setting-key', key);
  if (!source.valid) control.disabled = true;
  const sourceLabel = source.valid ? `SOURCE ${source.source}` : 'INVALID SOURCE';
  const reload = metadata.restart === true ? 'RESTART' : 'RELOAD';
  return createElement('article', { class: `settings-row herdr-row${source.valid ? '' : ' is-invalid'}` }, [
    createElement('label', { class: 'setting-label', for: id }, [key], documentRef),
    createElement('span', { class: `setting-source ${source.valid ? '' : 'status-err'}` }, [sourceLabel], documentRef),
    createElement('span', { class: 'setting-apply-mode' }, [reload], documentRef),
    control,
    save,
  ], documentRef);
}

function render(documentRef, root, settings, pending) {
  clearChildren(root);
  const hod = createElement('section', { class: 'settings-section', 'aria-labelledby': 'hod-settings-title' }, [
    createElement('h3', { class: 'settings-subtitle', id: 'hod-settings-title' }, ['HOD ROLE PROFILES'], documentRef),
  ], documentRef);
  for (const item of roleRows(settings)) hod.appendChild(roleRow(documentRef, item, pending.has(`role:${item.role}`)));
  root.appendChild(hod);
  const herdr = createElement('section', { class: 'settings-section', 'aria-labelledby': 'herdr-settings-title' }, [
    createElement('h3', { class: 'settings-subtitle', id: 'herdr-settings-title' }, ['HERDR SETTINGS'], documentRef),
  ], documentRef);
  const rows = herdrRows(settings);
  if (!rows.length) herdr.appendChild(createElement('p', { class: 'empty-state' }, ['No Herdr settings reported.'], documentRef));
  rows.forEach((item, index) => herdr.appendChild(settingRow(documentRef, item, pending.has(`setting:${item.key}`), index)));
  root.appendChild(herdr);
}

export function createSettingsView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const store = options.store;
  const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="settings"]');
  if (!store || !root) return Object.freeze({ destroy() {} });
  const confirm = options.confirmDialog ?? createConfirmDialog({ documentRef });
  const pending = new Set();
  const onHodSave = async (role, force) => {
    const key = `role:${role}`;
    if (pending.has(key)) return;
    pending.add(key);
    render(documentRef, root, store.getState().settings, pending);
    const token = force ? 'OVERWRITE HOD ROLE' : 'INSTALL HOD ROLE';
    try {
      if (await confirm.confirm({ title: 'Confirm HOD role', message: `${token} · ${role}` })) {
        await options.onHodSave?.({ role, force, confirmation: token });
      }
    } finally { pending.delete(key); render(documentRef, root, store.getState().settings, pending); }
  };
  const onHerdrSave = async (item, control) => {
    const key = `setting:${item.key}`;
    if (pending.has(key)) return;
    pending.add(key);
    render(documentRef, root, store.getState().settings, pending);
    try {
      if (await confirm.confirm({ title: 'Apply Herdr setting', message: `APPLY HERDR SETTING · ${item.key}` })) {
        await options.onHerdrSave?.({ key: item.key, value: readValue(control, item), confirmation: 'APPLY HERDR SETTING' });
      }
    } finally { pending.delete(key); render(documentRef, root, store.getState().settings, pending); }
  };
  const onClick = (event) => {
    const button = event.target?.closest?.('[data-action]');
    if (!button || (typeof root.contains === 'function' && !root.contains(button))) return;
    if (button.getAttribute('data-action') === 'role-save') {
      void onHodSave(button.getAttribute('data-role'), button.getAttribute('data-force') === 'true').catch(() => {});
      return;
    }
    if (button.getAttribute('data-action') === 'setting-save') {
      const row = button.closest?.('.herdr-row');
      const control = row?.querySelector?.('[data-setting-input]');
      const key = button.closest?.('.herdr-row')?.querySelector?.('[data-setting-key]')?.getAttribute?.('data-setting-key');
      const item = herdrRows(store.getState().settings).find((candidate) => String(candidate.key) === key);
      if (item && control) void onHerdrSave(item, control).catch(() => {});
    }
  };
  const renderCurrent = (state = store.getState()) => render(documentRef, root, state.settings, pending);
  root.addEventListener?.('click', onClick);
  const unsubscribe = store.subscribe(renderCurrent);
  renderCurrent();
  return Object.freeze({ destroy() { unsubscribe(); root.removeEventListener?.('click', onClick); confirm.destroy?.(); } });
}

export const mountSettingsView = createSettingsView;
export { herdrRows, roleRows };
