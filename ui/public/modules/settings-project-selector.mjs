import { createElement } from './dom-helpers.mjs';

export function projectRows(settings) {
  const rows = settings?.projects ?? settings?.workspaces;
  if (!Array.isArray(rows)) return [];
  return rows.map((item) => ({
    workspaceId: String(item?.workspaceId ?? item?.workspace_id ?? item?.id ?? ''),
    label: String(item?.label ?? item?.workspaceId ?? item?.id ?? 'workspace'),
  })).filter((item) => item.workspaceId !== '');
}

export function createProjectSelector(documentRef, settings, selectedWorkspace, pending) {
  const id = 'settings-workspace-selector';
  const select = createElement('select', {
    id,
    class: 'setting-control',
    'data-action': 'settings-project',
    'aria-label': 'Project or space',
    disabled: pending,
  }, [], documentRef);
  select.appendChild(createElement('option', { value: '' }, ['Choose a project or space'], documentRef));
  for (const project of projectRows(settings)) {
    select.appendChild(createElement('option', { value: project.workspaceId }, [project.label], documentRef));
  }
  select.value = selectedWorkspace ?? '';
  return createElement('section', { class: 'settings-section', 'aria-labelledby': 'settings-project-title' }, [
    createElement('h3', { class: 'settings-subtitle', id: 'settings-project-title' }, ['PROJECT SETTINGS'], documentRef),
    createElement('label', { class: 'setting-label', for: id }, ['Project or space target'], documentRef),
    select,
    createElement('p', { class: 'settings-selection-status', role: 'status', 'aria-live': 'polite' }, [
      pending ? 'Loading project settings…' : selectedWorkspace ? 'Project target selected.' : 'No project target selected.',
    ], documentRef),
  ], documentRef);
}
