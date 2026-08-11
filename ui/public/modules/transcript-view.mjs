import { clearChildren, createElement, setAttribute, textContent } from './dom-helpers.mjs';
import { ACTIONS } from './ui-store.mjs';

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function transcriptText(transcript) {
  if (typeof transcript === 'string') return transcript;
  if (!transcript || typeof transcript !== 'object') return '';
  for (const key of ['text', 'content', 'scrollback', 'output', 'body']) {
    if (typeof transcript[key] === 'string') return transcript[key];
  }
  const lines = transcript.lines ?? transcript.chunks;
  if (!Array.isArray(lines)) return '';
  return lines.map((line) => typeof line === 'string'
    ? line : stringValue(line?.text ?? line?.content ?? line?.value)).join('\n');
}

function hasMarker(transcript, names) {
  const markers = Array.isArray(transcript?.markers) ? transcript.markers : [];
  return names.some((name) => transcript?.[name] === true)
    || markers.some((marker) => names.includes(String(marker).toLowerCase().replace(/^\[|\]$/g, '')));
}

function markerText(state, transcript) {
  const markers = [];
  if (hasMarker(transcript, ['truncated', 'isTruncated', 'truncation'])) markers.push('[TRUNCATED]');
  if (hasMarker(transcript, ['gap', 'hasGap', 'gaps'])
    || (Array.isArray(transcript?.gaps) && transcript.gaps.length)) markers.push('[GAP]');
  if (state.connection?.status === 'reconnecting' || transcript?.reconnecting === true) {
    markers.push('[RECONNECTING]');
  }
  return markers;
}

function revisionOf(transcript) {
  const revision = transcript?.revision ?? transcript?.version ?? transcript?.seq;
  return revision === undefined || revision === null || revision === '' ? '—' : String(revision);
}

function buildToolbar(documentRef, state, transcript) {
  const following = state.followTail === true;
  const button = createElement('button', {
    class: 'bracket-button follow-toggle',
    type: 'button',
    'data-action': 'follow-toggle',
    'aria-pressed': following ? 'true' : 'false',
  }, [`FOLLOW ${following ? 'ON' : 'OFF'}`], documentRef);
  const markers = markerText(state, transcript);
  const meta = [
    `REVISION ${revisionOf(transcript)}`,
    ...markers,
  ].join(' · ');
  return createElement('div', { class: 'transcript-toolbar' }, [
    button,
    createElement('span', { class: 'transcript-meta' }, [meta || 'LIVE'], documentRef),
  ], documentRef);
}

function render(documentRef, root, state) {
  const previousScroll = Number(root.scrollTop) || 0;
  const transcript = state.transcript;
  clearChildren(root);
  root.appendChild(buildToolbar(documentRef, state, transcript));
  if (!transcript) {
    root.appendChild(createElement('p', { class: 'empty-state' }, [
      'Select an agent to view its transcript.',
    ], documentRef));
  } else {
    const pre = createElement('pre', { class: 'transcript-text', tabindex: '0' }, [], documentRef);
    textContent(pre, transcriptText(transcript));
    root.appendChild(pre);
  }
  if (state.followTail) root.scrollTop = Number(root.scrollHeight) || 0;
  else root.scrollTop = previousScroll;
}

export function createTranscriptView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const store = options.store;
  const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="transcript"]');
  if (!store || !root) return Object.freeze({ destroy() {} });

  const onClick = (event) => {
    const button = event.target?.closest?.('[data-action="follow-toggle"]');
    if (!button) return;
    store.dispatch({ type: ACTIONS.FOLLOW_TAIL_SET, followTail: !store.getState().followTail });
  };
  root.addEventListener?.('click', onClick);
  const unsubscribe = store.subscribe((state) => render(documentRef, root, state));
  render(documentRef, root, store.getState());
  return Object.freeze({ destroy() {
    unsubscribe();
    root.removeEventListener?.('click', onClick);
  } });
}

export const mountTranscriptView = createTranscriptView;
export { transcriptText };
