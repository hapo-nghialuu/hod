import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachGraphViewport,
  createGraphViewportControls,
  createGraphViewportState,
} from '../public/modules/orchestration-graph-viewport.mjs';

class FakeNode {
  constructor(name, documentRef) {
    this.name = name; this.ownerDocument = documentRef; this.nodeType = 1;
    this.attrs = {}; this.children = []; this.listeners = new Map();
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.children.find((child) => child.attrs?.class === selector.slice(1)) ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type, properties = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, clientX: 500, clientY: 300,
      preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  click() { this.emit('click'); }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600 }; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { this.released = id; }
}

const documentRef = {
  createElement(name) { return new FakeNode(name, documentRef); },
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
};

function canvas(variant = 'desktop', height = 600) {
  const node = new FakeNode('svg', documentRef);
  node.setAttribute('data-graph-variant', variant); node.setAttribute('height', height);
  const layer = new FakeNode('g', documentRef); layer.setAttribute('class', 'graph-viewport-layer'); node.appendChild(layer);
  return node;
}
function stage() { const node = new FakeNode('div', documentRef); node.scrollLeft = 0; node.scrollTop = 0; return node; }
function transform(node) { return node.children[0].getAttribute('transform'); }
function visibleText(node) { return node.nodeType === 3 ? node.textContent : node.children.map(visibleText).join(''); }

test('buttons and modified wheel zoom around a bounded viewport', () => {
  const state = createGraphViewportState(); const target = canvas();
  const controls = createGraphViewportControls(documentRef);
  attachGraphViewport(documentRef, stage(), [target], controls, state);
  assert.equal(transform(target), 'translate(0 0) scale(1)'); assert.equal(target.getAttribute('viewBox'), null);
  assert.equal(visibleText(controls.reset), '[ 100% ]');

  controls.zoomIn.click();
  assert.equal(state.zoom, 1.2); assert.match(transform(target), /scale\(1\.2\)$/);
  assert.equal(visibleText(controls.reset), '[ 120% ]');
  const plainWheel = target.emit('wheel', { deltaY: -1, ctrlKey: false, metaKey: false });
  assert.equal(plainWheel.defaultPrevented, undefined); assert.equal(state.zoom, 1.2);
  const zoomWheel = target.emit('wheel', { deltaY: -1, ctrlKey: true, metaKey: false, clientX: 250, clientY: 150 });
  assert.equal(zoomWheel.defaultPrevented, true); assert.equal(state.zoom, 1.4);
  for (let index = 0; index < 20; index += 1) controls.zoomIn.click();
  assert.equal(state.zoom, 2.4);
  for (let index = 0; index < 20; index += 1) controls.zoomOut.click();
  assert.equal(state.zoom, 0.6);
});

test('background drag pans, reset restores fit, and state survives canvas replacement', () => {
  const state = createGraphViewportState(); const first = canvas();
  const controls = createGraphViewportControls(documentRef); const graphStage = stage();
  attachGraphViewport(documentRef, graphStage, [first], controls, state);
  const nodePointer = first.emit('pointerdown', { target: { closest: () => ({}) } });
  assert.equal(nodePointer.defaultPrevented, undefined); assert.equal(first.getAttribute('data-panning'), null);
  first.emit('pointerdown', { clientX: 500, clientY: 300 });
  first.emit('pointermove', { clientX: 500, clientY: 200 }); first.emit('pointerup');
  assert.equal(graphStage.scrollTop, 100);
  graphStage.scrollTop = 140; graphStage.emit('scroll'); assert.equal(state.scrollTop, 140);
  controls.zoomIn.click(); controls.zoomIn.click();
  const before = transform(first);
  first.emit('pointerdown', { clientX: 500, clientY: 300 });
  assert.equal(first.getAttribute('data-panning'), '');
  first.emit('pointermove', { clientX: 350, clientY: 200 });
  const after = transform(first);
  assert.notEqual(after, before);
  first.emit('pointerup');
  assert.equal(first.getAttribute('data-panning'), null); assert.equal(first.released, 1);

  const replacement = canvas(); const replacementControls = createGraphViewportControls(documentRef);
  const replacementStage = stage();
  attachGraphViewport(documentRef, replacementStage, [replacement], replacementControls, state);
  assert.equal(transform(replacement), after);
  assert.equal(replacementStage.scrollTop, 140);
  replacementControls.reset.click();
  assert.equal(transform(replacement), 'translate(0 0) scale(1)');
  assert.equal(replacementStage.scrollTop, 0);
  assert.equal(state.zoom, 1); assert.equal(visibleText(replacementControls.reset), '[ 100% ]');
});
