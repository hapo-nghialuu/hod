import { createApiClient } from './modules/api-client.mjs';
import { createConsoleView } from './modules/console-view.mjs';
import { createDashboardView } from './modules/dashboard-view.mjs';
import { createSettingsView } from './modules/settings-view.mjs';
import { createTranscriptView } from './modules/transcript-view.mjs';
import { ACTIONS, createStore, reducer } from './modules/ui-store.mjs';
import { createRuntimeSync } from './modules/runtime-sync.mjs';

export function publicErrorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(error.code)) return error.code;
  if (Number.isInteger(error?.status) && error.status > 0) return `HTTP_${error.status}`;
  return 'ERR_UNAVAILABLE';
}

function connectionAction(status, error = null) {
  return { type: ACTIONS.CONNECTION, connection: { status, errorCode: error ? publicErrorCode(error) : null } };
}

function statusbar(store, message, status) {
  store.dispatch({ type: ACTIONS.STATUSBAR_SET, statusbar: { message, status } });
}

export function bootstrapApp(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  if (!documentRef) return Promise.resolve(null);
  const store = createStore({ reducer });
  const api = options.api ?? createApiClient(options);
  let stopped = false;
  const sync = createRuntimeSync({
    api,
    getState: () => store.getState(),
    errorCode: publicErrorCode,
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
    onState: (state) => store.dispatch({ type: ACTIONS.STATE_REPLACE, state }),
    onSettings: (settings) => store.dispatch({ type: ACTIONS.SETTINGS_REPLACE, settings }),
    onStatus: (message, status) => statusbar(store, message, status),
    onOpen: () => store.dispatch(connectionAction('connected')),
    onError(error) {
      store.dispatch(connectionAction('reconnecting', error));
      statusbar(store, 'connection retrying', publicErrorCode(error));
    },
    onMalformed: () => statusbar(store, 'event rejected', 'ERR_INVALID_EVENT'),
    onEvent(type, payload) {
      if (type === 'connection') store.dispatch(connectionAction(payload?.status ?? payload?.state ?? 'connected'));
      if (type === 'state') store.dispatch({ type: ACTIONS.STATE_REPLACE, state: payload?.state ?? payload });
      if (type === 'transcript') store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, transcript: payload?.transcript ?? payload });
      if (type === 'settings') store.dispatch({ type: ACTIONS.SETTINGS_REPLACE, settings: payload?.settings ?? payload });
    },
  });

  const refresh = sync.refresh;

  async function selectPane(paneId) {
    try {
      const result = await api.selectTranscript(paneId);
      const transcript = result?.transcript ?? result;
      if (transcript && typeof transcript === 'object'
        && (transcript.paneId || transcript.pane_id || transcript.text || transcript.lines || transcript.content)) {
        store.dispatch({ type: ACTIONS.TRANSCRIPT_REPLACE, transcript });
      }
      statusbar(store, 'transcript selected', 'OK');
      return result;
    } catch (error) {
      statusbar(store, 'transcript selection failed', publicErrorCode(error));
      throw error;
    }
  }

  const consoleView = createConsoleView({ documentRef, store, onRefresh: refresh });
  const dashboardView = createDashboardView({ documentRef, store, onSelectPane: selectPane });
  const transcriptView = createTranscriptView({ documentRef, store });
  const settingsView = createSettingsView({
    documentRef,
    store,
    async onHodSave(request) {
      try {
        await api.saveHodSettings(request);
        await refresh();
        statusbar(store, 'HOD role updated', 'OK');
      } catch (error) {
        statusbar(store, 'HOD role update failed', publicErrorCode(error));
      }
    },
    async onHerdrSave(request) {
      try {
        await api.saveHerdrSetting(request);
        await refresh();
        statusbar(store, 'Herdr setting updated', 'OK');
      } catch (error) {
        statusbar(store, 'Herdr setting update failed', publicErrorCode(error));
      }
    },
  });

  async function hydrate() {
    store.dispatch(connectionAction('connecting'));
    try { await api.bootstrapSession(); } catch (error) {
      store.dispatch(connectionAction('disconnected', error));
      statusbar(store, 'session unavailable', publicErrorCode(error));
    }
    await refresh();
    if (!stopped) sync.open();
    return store.getState();
  }

  const ready = hydrate();
  return {
    ready,
    store,
    api,
    refresh,
    stop() {
      stopped = true;
      sync.stop();
      settingsView.destroy();
      transcriptView.destroy();
      dashboardView.destroy();
      consoleView.destroy();
    },
  };
}

if (typeof document !== 'undefined') bootstrapApp().ready?.catch?.(() => {});
