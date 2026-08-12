import { setAttribute } from './dom-helpers.mjs';

const SVG_NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');

function glyphElement(documentRef, name, attributes = {}) {
  const element = documentRef.createElementNS?.(SVG_NS, name) ?? documentRef.createElement(name);
  for (const [attribute, value] of Object.entries(attributes)) setAttribute(element, attribute, value);
  return element;
}

export function createAgentAvatarGlyph(documentRef) {
  const avatar = glyphElement(documentRef, 'svg', {
    class: 'graph-agent-avatar', viewBox: '0 0 48 48', focusable: 'false', 'aria-hidden': 'true',
  });
  const shapes = [
    ['path', { class: 'graph-agent-antenna', d: 'M24 9V3M19 3h10' }],
    ['path', { class: 'graph-agent-shell', d: 'M9 10h30v24H9zM5 18h4v9H5m38-9h-4v9h4' }],
    ['rect', { class: 'graph-agent-screen', x: '13', y: '14', width: '22', height: '16' }],
    ['rect', { class: 'graph-agent-eye', x: '17', y: '19', width: '4', height: '4' }],
    ['rect', { class: 'graph-agent-eye', x: '27', y: '19', width: '4', height: '4' }],
    ['path', { class: 'graph-agent-mouth', d: 'M19 27h10' }],
    ['path', { class: 'graph-agent-base', d: 'M15 34v4H9v7h30v-7h-6v-4' }],
    ['circle', { class: 'graph-agent-signal-ring', cx: '40', cy: '8', r: '5' }],
    ['circle', { class: 'graph-agent-signal', cx: '40', cy: '8', r: '2.5' }],
  ];
  for (const [name, attributes] of shapes) avatar.appendChild(glyphElement(documentRef, name, attributes));
  return avatar;
}
