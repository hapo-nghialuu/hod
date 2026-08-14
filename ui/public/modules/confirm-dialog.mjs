import { setAttribute, textContent } from './dom-helpers.mjs';

function focusable(dialog) {
  return dialog?.querySelector?.('[data-confirm="ok"]');
}

function closeDialog(dialog) {
  if (typeof dialog?.close === 'function') dialog.close();
  else if (dialog) {
    dialog.open = false;
    dialog.removeAttribute?.('open');
  }
}

export function createConfirmDialog(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const dialog = options.dialog ?? documentRef?.getElementById?.('confirm-dialog');
  if (!dialog) {
    return Object.freeze({
      confirm: async () => false,
      destroy() {},
    });
  }

  const title = dialog.querySelector?.('#confirm-title');
  const message = dialog.querySelector?.('#confirm-message');
  const confirmButton = focusable(dialog);
  const cancelButton = dialog.querySelector?.('[data-confirm="cancel"]');
  let pending = null;
  let restoreFocus = null;

  function finish(accepted) {
    if (!pending) return;
    const result = pending;
    pending = null;
    closeDialog(dialog);
    result.resolve(accepted);
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  function onConfirm() { finish(true); }
  function onCancel() { finish(false); }
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      finish(false);
    }
  }

  confirmButton?.addEventListener?.('click', onConfirm);
  cancelButton?.addEventListener?.('click', onCancel);
  dialog.addEventListener?.('cancel', onCancel);
  dialog.addEventListener?.('keydown', onKeyDown);

  function confirm(request = {}) {
    if (pending) finish(false);
    restoreFocus = documentRef?.activeElement ?? null;
    if (title) textContent(title, request.title ?? 'Confirm action');
    if (message) textContent(message, request.message ?? 'Continue?');
    if (confirmButton) textContent(confirmButton, request.confirmLabel ?? 'Confirm');
    if (cancelButton) textContent(cancelButton, request.cancelLabel ?? 'Cancel');
    setAttribute(dialog, 'aria-busy', 'false');
    return new Promise((resolve) => {
      pending = { resolve };
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.open = true;
        setAttribute(dialog, 'open', '');
      }
      queueMicrotask(() => confirmButton?.focus?.());
    });
  }

  function destroy() {
    finish(false);
    confirmButton?.removeEventListener?.('click', onConfirm);
    cancelButton?.removeEventListener?.('click', onCancel);
    dialog.removeEventListener?.('cancel', onCancel);
    dialog.removeEventListener?.('keydown', onKeyDown);
  }

  return Object.freeze({ confirm, destroy });
}
