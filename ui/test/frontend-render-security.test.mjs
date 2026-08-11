import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const uiRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const publicRoot = join(uiRoot, 'public');
const indexPath = join(publicRoot, 'index.html');
const layoutPath = join(publicRoot, 'styles', 'layout.css');

function filesUnder(root, extensions) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path, extensions));
    else if (extensions.some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

test('frontend asset references, markup, and source boundaries stay local and safe', () => {
  const html = readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const reference of refs) {
    if (reference.startsWith('#') || /^[a-z]+:/i.test(reference)) continue;
    const localPath = resolve(publicRoot, reference.split(/[?#]/, 1)[0]);
    assert.equal(statSync(localPath).isFile(), true, `missing local asset: ${reference}`);
  }
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b|\bstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//i);

  for (const file of filesUnder(publicRoot, ['.mjs'])) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function|document\.write/);
    assert.doesNotMatch(source, /https?:\/\//i, relative(uiRoot, file));
  }
});

test('favicon reference points to an existing local SVG', () => {
  const html = readFileSync(indexPath, 'utf8');
  const faviconLink = html.match(/<link\b[^>]*\brel=["']icon["'][^>]*>/i)?.[0];
  assert.ok(faviconLink, 'missing favicon link');
  assert.match(faviconLink, /\btype=["']image\/svg\+xml["']/i);
  const faviconReference = faviconLink.match(/\bhref=["']([^"']+)["']/i)?.[1];
  assert.equal(faviconReference, 'favicon.svg');
  assert.equal(statSync(join(publicRoot, faviconReference)).isFile(), true);
});

test('measured stacking breakpoint covers 1160px and favicon corners stay square', () => {
  const layoutCss = readFileSync(layoutPath, 'utf8');
  const stackingMedia = [...layoutCss.matchAll(
    /@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
  )].find(([, width, body]) => body.includes('.app') && /flex-direction:\s*column/.test(body));
  assert.ok(stackingMedia, 'missing stacked tablet layout');
  assert.ok(Number(stackingMedia[1]) >= 1160, `measured breakpoint misses 1160px: ${stackingMedia[1]}px`);

  const favicon = readFileSync(join(publicRoot, 'favicon.svg'), 'utf8');
  assert.doesNotMatch(favicon, /\brx\s*=/i, 'favicon must not use rounded corners');
});

test('all owned frontend code and styles stay below the 200-line limit', () => {
  const files = [
    ...filesUnder(publicRoot, ['.mjs', '.css']),
    join(uiRoot, 'test', 'view-models.test.mjs'),
    join(uiRoot, 'test', 'frontend-render-security.test.mjs'),
  ];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').length;
    assert.ok(lines < 200, `${relative(uiRoot, file)} has ${lines} lines`);
  }
});

test('every CSS custom property reference has a token definition', () => {
  const css = filesUnder(join(publicRoot, 'styles'), ['.css'])
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  const definitions = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const references = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
  for (const name of references) assert.equal(definitions.has(name), true, `undefined CSS var: --${name}`);
});
