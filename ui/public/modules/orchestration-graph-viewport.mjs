import { createElement, setAttribute } from './dom-helpers.mjs';

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.2;

function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function variantOf(canvas) { return canvas.getAttribute?.('data-graph-variant') ?? 'desktop'; }
function baseHeightOf(canvas) {
  const value = Number.parseFloat(canvas.getAttribute?.('height'));
  return Number.isFinite(value) && value > 0 ? value : 340;
}
function baseWidthOf(canvas) {
  const value = canvas.getBoundingClientRect?.().width;
  return Number.isFinite(value) && value > 0 ? value : 1000;
}
function viewState(state, variant) {
  if (!state.views[variant]) state.views[variant] = { centerX: 0.5, centerY: 0.5 };
  return state.views[variant];
}
function frameFor(state, canvas) {
  const baseWidth = baseWidthOf(canvas);
  const baseHeight = baseHeightOf(canvas);
  const width = baseWidth / state.zoom;
  const height = baseHeight / state.zoom;
  const view = viewState(state, variantOf(canvas));
  const centeredX = view.centerX * baseWidth - width / 2;
  const centeredY = view.centerY * baseHeight - height / 2;
  const x = width >= baseWidth ? (baseWidth - width) / 2 : clamp(centeredX, 0, baseWidth - width);
  const y = height >= baseHeight ? (baseHeight - height) / 2 : clamp(centeredY, 0, baseHeight - height);
  view.centerX = (x + width / 2) / baseWidth;
  view.centerY = (y + height / 2) / baseHeight;
  return { x, y, width, height, baseWidth, baseHeight };
}
function applyCanvas(state, canvas) {
  const frame = frameFor(state, canvas);
  const layer = canvas.querySelector?.('.graph-viewport-layer');
  if (layer) setAttribute(layer, 'transform', `translate(${-frame.x * state.zoom} ${-frame.y * state.zoom}) scale(${state.zoom})`);
  setAttribute(canvas, 'tabindex', '0');
  return frame;
}
function replaceText(documentRef, node, value) {
  node.replaceChildren?.(documentRef.createTextNode(String(value)));
}
function zoomAt(state, canvas, nextZoom, clientX, clientY) {
  const current = frameFor(state, canvas);
  const rect = canvas.getBoundingClientRect?.();
  const ratioX = rect?.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
  const ratioY = rect?.height ? clamp((clientY - rect.top) / rect.height, 0, 1) : 0.5;
  const focusX = current.x + ratioX * current.width;
  const focusY = current.y + ratioY * current.height;
  state.zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const width = current.baseWidth / state.zoom;
  const height = current.baseHeight / state.zoom;
  const view = viewState(state, variantOf(canvas));
  view.centerX = (focusX - ratioX * width + width / 2) / current.baseWidth;
  view.centerY = (focusY - ratioY * height + height / 2) / current.baseHeight;
}
export function createGraphViewportState() {
  return { zoom: 1, views: Object.create(null), scrollLeft: 0, scrollTop: 0 };
}
export function createGraphViewportControls(documentRef) {
  const hint = createElement('span', { class: 'graph-viewport-hint' }, ['DRAG · CTRL/⌘+SCROLL'], documentRef);
  const zoomOut = createElement('button', { class: 'graph-viewport-button', type: 'button', 'aria-label': 'Zoom out' }, ['[ − ]'], documentRef);
  const reset = createElement('button', { class: 'graph-viewport-button graph-viewport-reset', type: 'button', 'aria-label': 'Reset zoom to 100 percent' }, ['[ 100% ]'], documentRef);
  const zoomIn = createElement('button', { class: 'graph-viewport-button', type: 'button', 'aria-label': 'Zoom in' }, ['[ + ]'], documentRef);
  return { element: createElement('div', { class: 'graph-viewport-controls' }, [hint, zoomOut, reset, zoomIn], documentRef), zoomOut, reset, zoomIn };
}
export function createGraphLegend(documentRef) {
  return createElement('ul', { class: 'graph-legend', 'aria-label': 'Orchestration edge semantics' }, [
    ...[['delegate', 'DELEGATE'], ['consult', 'CONSULT'], ['verify', 'VERIFY']].map(([relation, label]) => createElement('li', {
      class: `graph-legend-item edge-${relation}`,
    }, [label], documentRef)),
  ], documentRef);
}
export function createGraphHelpState(documentRef, message) {
  return createElement('p', { class: 'graph-help', role: 'status' }, [message], documentRef);
}
export function attachGraphViewport(documentRef, stage, canvases, controls, state = createGraphViewportState()) {
  const applyAll = () => {
    for (const canvas of canvases) applyCanvas(state, canvas);
    replaceText(documentRef, controls.reset, `[ ${Math.round(state.zoom * 100)}% ]`);
  };
  const zoomAll = (delta) => { state.zoom = clamp(state.zoom + delta, MIN_ZOOM, MAX_ZOOM); applyAll(); };
  controls.zoomOut.addEventListener?.('click', () => zoomAll(-ZOOM_STEP));
  controls.zoomIn.addEventListener?.('click', () => zoomAll(ZOOM_STEP));
  controls.reset.addEventListener?.('click', () => {
    state.zoom = 1; state.views = Object.create(null); state.scrollLeft = 0; state.scrollTop = 0;
    stage.scrollLeft = 0; stage.scrollTop = 0; applyAll();
  });
  stage.scrollLeft = state.scrollLeft ?? 0; stage.scrollTop = state.scrollTop ?? 0;
  stage.addEventListener?.('scroll', () => { state.scrollLeft = stage.scrollLeft; state.scrollTop = stage.scrollTop; });
  for (const canvas of canvases) {
    let drag = null;
    canvas.addEventListener?.('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(state, canvas, state.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event.clientX, event.clientY);
      applyAll();
    }, { passive: false });
    canvas.addEventListener?.('pointerdown', (event) => {
      if (event.button !== 0 || event.target?.closest?.('.graph-node')) return;
      const view = viewState(state, variantOf(canvas));
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, centerX: view.centerX, centerY: view.centerY,
        scrollLeft: stage.scrollLeft ?? 0, scrollTop: stage.scrollTop ?? 0 };
      canvas.setPointerCapture?.(event.pointerId); setAttribute(canvas, 'data-panning', ''); event.preventDefault();
    });
    canvas.addEventListener?.('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (state.zoom <= 1) {
        stage.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
        stage.scrollTop = drag.scrollTop - (event.clientY - drag.y);
        state.scrollLeft = stage.scrollLeft; state.scrollTop = stage.scrollTop; return;
      }
      const rect = canvas.getBoundingClientRect?.(); if (!rect?.width || !rect?.height) return;
      const view = viewState(state, variantOf(canvas));
      view.centerX = drag.centerX - (event.clientX - drag.x) / rect.width / state.zoom;
      view.centerY = drag.centerY - (event.clientY - drag.y) / rect.height / state.zoom;
      applyCanvas(state, canvas);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      canvas.releasePointerCapture?.(event.pointerId); canvas.removeAttribute?.('data-panning'); drag = null;
    };
    canvas.addEventListener?.('pointerup', endDrag); canvas.addEventListener?.('pointercancel', endDrag);
    canvas.addEventListener?.('keydown', (event) => {
      const zoomDelta = event.key === '+' || event.key === '=' ? ZOOM_STEP : event.key === '-' ? -ZOOM_STEP : 0;
      if (zoomDelta) { event.preventDefault(); zoomAll(zoomDelta); }
      else if (event.key === '0') { event.preventDefault(); controls.reset.click?.(); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (state.zoom <= 1) {
          stage.scrollLeft += horizontal * 40; stage.scrollTop += vertical * 40;
          state.scrollLeft = stage.scrollLeft; state.scrollTop = stage.scrollTop;
        }
        else {
          const view = viewState(state, variantOf(canvas)); const height = baseHeightOf(canvas);
          view.centerX += horizontal * 40 / baseWidthOf(canvas) / state.zoom;
          view.centerY += vertical * 40 / height / state.zoom; applyCanvas(state, canvas);
        }
      }
    });
  }
  applyAll();
  return state;
}
