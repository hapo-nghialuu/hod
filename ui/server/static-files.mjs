import { constants as fsConstants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { securityHeaders } from './security-policy.mjs';

export const MAX_STATIC_BYTES = 2 * 1024 * 1024;
export const STATIC_MAX_BYTES = MAX_STATIC_BYTES;
export const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2',
});

const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const READ_ONLY_NO_FOLLOW = typeof NO_FOLLOW === 'number' ? fsConstants.O_RDONLY | NO_FOLLOW : null;

function failure(code, status, message = code) { return Object.assign(new Error(message), { code, status }); }
function sameIdentity(left, right) {
  return left?.dev !== undefined && left?.ino !== undefined && left.dev === right?.dev && left.ino === right?.ino;
}

export function decodeStaticPath(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith('/')) throw failure('ERR_STATIC_PATH', 400);
  const rawPath = requestUrl.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw failure('ERR_STATIC_DECODE', 400); }
  if (decoded.includes('\0') || decoded.includes('\\')) throw failure('ERR_STATIC_PATH', 400);
  if (decoded === '/') return { relativePath: 'index.html', mimeType: MIME_TYPES['.html'] };
  if (!decoded.startsWith('/') || decoded.endsWith('/')) throw failure('ERR_STATIC_PATH', 404);
  const segments = decoded.slice(1).split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw failure('ERR_STATIC_PATH', 404);
  const relativePath = segments.join('/');
  const mimeType = MIME_TYPES[extname(relativePath).toLowerCase()];
  if (!mimeType) throw failure('ERR_STATIC_MIME', 404);
  return { relativePath, mimeType };
}

async function readAsset(path, listed, maxBytes, fsApi) {
  let handle;
  try {
    handle = await fsApi.open(path, READ_ONLY_NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(listed, opened)) throw failure('ERR_STATIC_CHANGED', 404);
    if (opened.size > maxBytes) throw failure('ERR_STATIC_LARGE', 413);
    const body = Buffer.alloc(opened.size); let offset = 0;
    while (offset < body.length) {
      const result = await handle.read(body, offset, body.length - offset, offset);
      if (!result?.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== body.length || !sameIdentity(opened, after) || after.size !== opened.size) {
      throw failure('ERR_STATIC_CHANGED', 404);
    }
    return body;
  } catch (error) {
    if (error?.code === 'ELOOP') throw failure('ERR_STATIC_SYMLINK', 404);
    if (error?.code?.startsWith?.('ERR_STATIC_')) throw error;
    throw failure('ERR_STATIC_FILE', 404);
  } finally { await handle?.close?.().catch?.(() => {}); }
}

async function checkedDirectory(path, fsApi, code = 'ERR_STATIC_ROOT') {
  if (READ_ONLY_NO_FOLLOW === null) throw failure('ERR_STATIC_NOFOLLOW', 500);
  let listed;
  try { listed = await fsApi.lstat(path); } catch { throw failure(code, 404); }
  if (listed.isSymbolicLink() || !listed.isDirectory()) throw failure(code, 404);
  let handle;
  try {
    handle = await fsApi.open(path, READ_ONLY_NO_FOLLOW | fsConstants.O_DIRECTORY);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(listed, opened)) throw failure(code, 404);
    return { dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (error?.code?.startsWith?.('ERR_STATIC_')) throw error;
    if (error?.code === 'ELOOP') throw failure('ERR_STATIC_SYMLINK', 404);
    throw failure(code, 404);
  } finally { await handle?.close?.().catch?.(() => {}); }
}

async function loadDirectory(directory, relative, assets, maxBytes, fsApi) {
  let entries;
  try { entries = await fsApi.readdir(directory, { withFileTypes: true }); } catch { throw failure('ERR_STATIC_ROOT', 404); }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const listed = await fsApi.lstat(path);
    if (listed.isSymbolicLink()) {
      if (MIME_TYPES[extname(relativePath).toLowerCase()]) {
        assets[relativePath] = Object.freeze({ error: failure('ERR_STATIC_SYMLINK', 404) });
      }
      continue;
    }
    if (listed.isDirectory()) { await loadDirectory(path, relativePath, assets, maxBytes, fsApi); continue; }
    if (!listed.isFile()) continue;
    const mimeType = MIME_TYPES[extname(relativePath).toLowerCase()];
    if (!mimeType) continue;
    try {
      assets[relativePath] = Object.freeze({ mimeType, body: await readAsset(path, listed, maxBytes, fsApi) });
    } catch (error) {
      if (error?.code === 'ERR_STATIC_LARGE' || error?.code === 'ERR_STATIC_SYMLINK'
        || error?.code === 'ERR_STATIC_CHANGED') assets[relativePath] = Object.freeze({ error });
      else throw error;
    }
  }
}

export class StaticFileServer {
  constructor(options = {}) {
    if (typeof options === 'string') options = { rootDirectory: options };
    const rootDirectory = options.rootDirectory ?? options.publicRoot ?? options.root;
    if (typeof rootDirectory !== 'string' || rootDirectory === '') throw new TypeError('rootDirectory is required');
    this.rootDirectory = resolve(rootDirectory);
    this.maxBytes = options.maxBytes ?? MAX_STATIC_BYTES;
    this.fs = options.fs ?? defaultFs;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new TypeError('maxBytes is invalid');
    this._assets = null; this._loadPromise = null; this._rootIdentity = null;
  }

  async load() {
    if (this._assets) return this;
    if (!this._loadPromise) this._loadPromise = this._loadAssets();
    try { await this._loadPromise; } catch (error) { this._loadPromise = null; throw error; }
    return this;
  }

  async _loadAssets() {
    const identity = await checkedDirectory(this.rootDirectory, this.fs);
    const assets = Object.create(null);
    await loadDirectory(this.rootDirectory, '', assets, this.maxBytes, this.fs);
    const current = await checkedDirectory(this.rootDirectory, this.fs);
    if (!sameIdentity(identity, current)) throw failure('ERR_STATIC_ROOT_CHANGED', 404);
    this._rootIdentity = identity;
    this._assets = Object.freeze(assets);
  }

  async read(requestUrl, method = 'GET') {
    if (method !== 'GET' && method !== 'HEAD') throw failure('ERR_STATIC_METHOD', 405);
    const { relativePath, mimeType } = decodeStaticPath(requestUrl);
    await this.load();
    const asset = this._assets[relativePath];
    if (!asset) throw failure('ERR_STATIC_FILE', 404);
    if (asset.error) throw asset.error;
    return {
      status: 200,
      headers: { ...securityHeaders(), 'Content-Type': mimeType, 'Content-Length': String(asset.body.byteLength) },
      body: method === 'HEAD' ? null : Buffer.from(asset.body),
    };
  }

  async serve(request, response) {
    const method = typeof request === 'string' ? 'GET' : (request?.method ?? 'GET');
    const requestUrl = typeof request === 'string' ? request : request?.url;
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { ...securityHeaders(), Allow: 'GET, HEAD' }); response.end(); return false;
    }
    try {
      const result = await this.read(requestUrl, method);
      response.writeHead(result.status, result.headers); response.end(result.body ?? undefined); return true;
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 404;
      response.writeHead(status, { ...securityHeaders(), 'Content-Length': '0' }); response.end(); return false;
    }
  }
}

export const resolveStaticPath = decodeStaticPath;
export const createStaticFileServer = (options) => new StaticFileServer(options);
export async function serveStatic(request, response, options = {}) {
  const server = options instanceof StaticFileServer ? options : new StaticFileServer(options);
  return server.serve(request, response);
}
