import { clearChildren, createElement, textContent } from './dom-helpers.mjs';
import { isValidTranscript } from './ui-store.mjs';

const ANSI_NORMAL = ['000000', 'cd3131', '0dbc79', 'e5e510', '2472c8', 'bc3fbc', '11a8cd', 'e5e5e5'];
const ANSI_BRIGHT = ['666666', 'f14c4c', '23d18b', 'f5f543', '3b8eea', 'd670d6', '29b8db', 'ffffff'];
const TEXT_FIELDS = ['text', 'content', 'scrollback', 'output', 'body'];
const STYLE_KEYS = ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse', 'fg', 'bg'];
const ST_TERMINATED_CONTROLS = new Set(['P', '_', '^', 'X']);
const MAX_ANSI_SEGMENTS = 20_000;
const MAX_DYNAMIC_COLORS = 512;
const colorRules = new WeakMap();

function stringValue(value) { return typeof value === 'string' ? value : ''; }
function transcriptText(transcript) {
  if (typeof transcript === 'string') return transcript;
  if (!transcript || typeof transcript !== 'object') return '';
  for (const key of TEXT_FIELDS) {
    if (typeof transcript[key] === 'string') return transcript[key];
  }
  const lines = transcript.lines ?? transcript.chunks;
  return Array.isArray(lines) ? lines.map((line) => typeof line === 'string'
    ? line : stringValue(line?.text ?? line?.content ?? line?.value)).join('\n') : '';
}
function hasMarker(transcript, names) {
  const markers = Array.isArray(transcript?.markers) ? transcript.markers : [];
  return names.some((name) => transcript?.[name] === true)
    || markers.some((marker) => names.includes(String(marker).toLowerCase().replace(/^\[|\]$/g, '')));
}
function markerText(state, transcript) {
  const markers = [];
  if (hasMarker(transcript, ['truncated', 'isTruncated', 'truncation'])) markers.push('[TRUNCATED]');
  if (hasMarker(transcript, ['gap', 'hasGap', 'gaps']) || (Array.isArray(transcript?.gaps) && transcript.gaps.length)) markers.push('[GAP]');
  if (state.connection?.status === 'reconnecting' || transcript?.reconnecting === true) markers.push('[RECONNECTING]');
  return markers;
}
function revisionOf(transcript) {
  const revision = transcript?.revision ?? transcript?.version ?? transcript?.seq;
  return revision === undefined || revision === null || revision === '' ? '—' : String(revision);
}
function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value) ? value : 'ERR_UNAVAILABLE';
}
function blankStyle() { return { bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false, fg: null, bg: null }; }
function byteHex(value) { return Number.isInteger(value) && value >= 0 && value <= 255 ? value.toString(16).padStart(2, '0') : null; }
function rgbHex(red, green, blue) {
  const bytes = [red, green, blue].map(byteHex);
  return bytes.every(Boolean) ? bytes.join('') : null;
}
function xtermHex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  if (value < 8) return ANSI_NORMAL[value];
  if (value < 16) return ANSI_BRIGHT[value - 8];
  if (value >= 232) { const shade = 8 + ((value - 232) * 10); return rgbHex(shade, shade, shade); }
  const index = value - 16; const levels = [0, 95, 135, 175, 215, 255];
  return rgbHex(levels[Math.floor(index / 36)], levels[Math.floor(index / 6) % 6], levels[index % 6]);
}
function extendedColor(codes, index) {
  if (codes[index + 1] === 5) return { color: xtermHex(codes[index + 2]), consumed: 2 };
  if (codes[index + 1] === 2) return { color: rgbHex(...codes.slice(index + 2, index + 5)), consumed: 4 };
  return { color: null, consumed: 0 };
}
function sameStyle(left, right) {
  return STYLE_KEYS.every((key) => left?.[key] === right?.[key]);
}
function csiEndIndex(text, index) {
  let end = index + 2;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code >= 64 && code <= 126) return end;
    end += 1;
  }
  return -1;
}
function controlStringEndIndex(text, index, allowBell = false) {
  let end = index + 2;
  while (end < text.length) {
    if (allowBell && text[end] === '\u0007') return end;
    if (text[end] === '\u001b' && text[end + 1] === '\\') return end;
    end += 1;
  }
  return text.length;
}
function applySgr(style, raw) {
  const codes = (raw === '' ? ['0'] : raw.split(';')).map((part) => Number(part));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) Object.assign(style, blankStyle());
    else if (code === 1) style.bold = true; else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true; else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true; else if (code === 9) style.strike = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false; else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false; else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = ANSI_NORMAL[code - 30];
    else if (code >= 40 && code <= 47) style.bg = ANSI_NORMAL[code - 40];
    else if (code >= 90 && code <= 97) style.fg = ANSI_BRIGHT[code - 90];
    else if (code >= 100 && code <= 107) style.bg = ANSI_BRIGHT[code - 100];
    else if (code === 39) style.fg = null; else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      const extended = extendedColor(codes, index); index += extended.consumed;
      if (extended.color) style[code === 38 ? 'fg' : 'bg'] = extended.color;
    }
  }
}
export function ansiSegments(value) {
  const text = String(value ?? ''); const output = []; const style = blankStyle(); let buffer = ''; let capped = false;
  const flush = () => {
    if (!buffer) return;
    const nextStyle = capped ? blankStyle() : { ...style }; const last = output.at(-1);
    if (last && sameStyle(last.style, nextStyle)) last.text += buffer;
    else if (output.length < MAX_ANSI_SEGMENTS - 1) output.push({ text: buffer, style: nextStyle });
    else { capped = true; output.push({ text: buffer, style: blankStyle() }); }
    buffer = '';
  };
  for (let index = 0; index < text.length;) {
    const char = text[index]; const code = text.charCodeAt(index);
    if (char === '\u001b') {
      if (text[index + 1] === '[') {
        const end = csiEndIndex(text, index);
        if (end < 0) break;
        if (text[end] === 'm') { flush(); if (!capped) applySgr(style, text.slice(index + 2, end)); }
        index = end + 1; continue;
      }
      if (text[index + 1] === ']') {
        const end = controlStringEndIndex(text, index, true);
        index = end < text.length ? end + (text[end] === '\u001b' ? 2 : 1) : text.length; continue;
      }
      if (ST_TERMINATED_CONTROLS.has(text[index + 1])) {
        const end = controlStringEndIndex(text, index);
        index = end < text.length ? end + 2 : text.length; continue;
      }
      index += 2; continue;
    }
    if (char === '\r') { if (text[index + 1] !== '\n') buffer += '\n'; index += 1; continue; }
    if ((code >= 32 && (code < 127 || code > 159)) || char === '\n' || char === '\t') buffer += char;
    index += 1;
  }
  flush(); return output;
}
function colorClass(documentRef, channel, hex) {
  if (!/^[0-9a-f]{6}$/.test(hex ?? '')) return '';
  const name = `ansi-${channel}-${hex}`; let seen = colorRules.get(documentRef);
  if (!seen) { seen = new Set(); colorRules.set(documentRef, seen); }
  if (!seen.has(name) && seen.size < MAX_DYNAMIC_COLORS) {
    const sheet = [...(documentRef?.styleSheets ?? [])].find((item) => /\/runtime-view\.css(?:$|\?)/.test(item.href ?? ''));
    try { sheet?.insertRule?.(`.${name}{${channel === 'fg' ? 'color' : 'background-color'}:#${hex}}`, sheet.cssRules.length); } catch { /* safe color class degrades to theme text */ }
    seen.add(name);
  }
  return seen.has(name) ? name : '';
}
function segmentClasses(documentRef, style) {
  const classes = ['bold', 'dim', 'italic', 'underline', 'strike'].filter((key) => style[key]).map((key) => `ansi-${key}`);
  let foreground = style.fg; let background = style.bg;
  if (style.inverse) { classes.push('ansi-inverse'); [foreground, background] = [background, foreground]; }
  if (foreground) classes.push(colorClass(documentRef, 'fg', foreground));
  if (background) classes.push(colorClass(documentRef, 'bg', background));
  return classes.filter(Boolean).join(' ');
}
function appendAnsi(documentRef, root, value) {
  textContent(root, '');
  for (const segment of ansiSegments(value)) {
    const classes = segmentClasses(documentRef, segment.style);
    root.appendChild(classes ? createElement('span', { class: classes }, [segment.text], documentRef)
      : documentRef.createTextNode(segment.text));
  }
}

function buildToolbar(documentRef, state, transcript) {
  const markers = markerText(state, transcript); const pane = typeof transcript?.paneId === 'string' ? `PANE ${transcript.paneId.slice(0, 48)} · ` : '';
  const detail = !transcript ? 'REVISION —' : transcript.status === 'loading' ? 'LOADING'
    : transcript.status === 'error' ? `ERROR ${safeErrorCode(transcript.errorCode)}`
      : transcript.status === 'success' && isValidTranscript(transcript, transcript.paneId)
        ? [`REVISION ${revisionOf(transcript)}`, ...markers].join(' · ') : 'UNAVAILABLE';
  return createElement('div', { class: 'transcript-toolbar' }, [
    createElement('span', { class: 'transcript-meta' }, [`${pane}${detail}`], documentRef),
  ], documentRef);
}
function render(documentRef, root, state) {
  const transcript = state.transcript; let scrollOwner = null; clearChildren(root);
  root.appendChild(buildToolbar(documentRef, state, transcript));
  if (!transcript) root.appendChild(createElement('p', { class: 'empty-state' }, ['Select an agent to view its transcript.'], documentRef));
  else if (transcript.status === 'loading') root.appendChild(createElement('p', { class: 'empty-state', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, ['Loading transcript…'], documentRef));
  else if (transcript.status === 'error') root.appendChild(createElement('p', { class: 'empty-state status-err', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' }, [`Transcript unavailable: ${safeErrorCode(transcript.errorCode)}`], documentRef));
  else if (transcript.status === 'success' && isValidTranscript(transcript, transcript.paneId)) {
    scrollOwner = createElement('pre', { class: 'transcript-text', tabindex: '0', role: 'region', 'aria-label': `Live terminal scrollback for pane ${transcript.paneId}` }, [], documentRef);
    appendAnsi(documentRef, scrollOwner, transcriptText(transcript)); root.appendChild(scrollOwner);
  } else root.appendChild(createElement('p', { class: 'empty-state status-err' }, ['Transcript unavailable: ERR_INVALID_TRANSCRIPT'], documentRef));
  if (scrollOwner) scrollOwner.scrollTop = Number(scrollOwner.scrollHeight) || 0;
}

export function createTranscriptView(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document; const store = options.store;
  const root = options.root ?? documentRef?.querySelector?.('[data-pane-body="transcript"]');
  if (!store || !root) return Object.freeze({ destroy() {} });
  const unsubscribe = store.subscribe((state) => render(documentRef, root, state));
  render(documentRef, root, store.getState()); return Object.freeze({ destroy() { unsubscribe(); } });
}
export const mountTranscriptView = createTranscriptView;
export { transcriptText };
