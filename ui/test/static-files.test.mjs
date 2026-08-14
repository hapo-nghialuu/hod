import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename as fsRename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StaticFileServer, decodeStaticPath } from '../server/static-files.mjs';

class FakeResponse {
  constructor() { this.statusCode = 0; this.headers = {}; this.body = Buffer.alloc(0); this.headersSent = false; this.ended = false; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  end(body) { if (body !== undefined) this.body = Buffer.from(body); this.ended = true; }
}

async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), 'hod-static-'));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function serve(server, request) {
  const response = new FakeResponse();
  const served = await server.serve(request, response);
  return { served, response };
}

test('static path decoding rejects malformed, hostile, and dotfile paths', () => {
  assert.deepEqual(decodeStaticPath('/'), { relativePath: 'index.html', mimeType: 'text/html; charset=utf-8' });
  assert.deepEqual(decodeStaticPath('/app.mjs?cache=1').relativePath, 'app.mjs');
  for (const path of [
    '/%ZZ', '/%00', '/foo%5Cbar.js', '/../secret.js', '/%2e%2e/secret.js',
    '/nested/../index.html', '/.env', '/nested/.secret.js', '/nested/', '/unknown.bin',
  ]) assert.throws(() => decodeStaticPath(path), { code: /^ERR_STATIC_/ });
});

test('GET and HEAD serve only regular allowlisted files with security headers', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'index.html'), '<main>ok</main>');
    await writeFile(join(root, 'nested', 'app.mjs'), 'export default 1;');
    const server = new StaticFileServer({ rootDirectory: root });
    const get = await serve(server, { method: 'GET', url: '/' });
    assert.equal(get.served, true);
    assert.equal(get.response.statusCode, 200);
    assert.equal(get.response.body.toString(), '<main>ok</main>');
    assert.equal(get.response.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(get.response.headers['Cache-Control'], 'no-store');
    const head = await serve(server, { method: 'HEAD', url: '/nested/app.mjs' });
    assert.equal(head.served, true);
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.response.body.byteLength, 0);
    assert.equal(head.response.headers['Content-Length'], String(Buffer.byteLength('export default 1;')));
    const post = await serve(server, { method: 'POST', url: '/' });
    assert.equal(post.served, false);
    assert.equal(post.response.statusCode, 405);
    assert.equal(post.response.headers.Allow, 'GET, HEAD');
  });
});

test('root and content symlinks, directories, unknown MIME, and oversized files fail closed', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'hod-static-outside-'));
    const rootLink = `${root}-link`;
    try {
      await writeFile(join(root, 'index.html'), 'ok');
      await writeFile(join(outside, 'leak.js'), 'secret');
      await symlink(outside, rootLink);
      const rootSymlink = await serve(new StaticFileServer({ rootDirectory: rootLink }), { method: 'GET', url: '/' });
      assert.equal(rootSymlink.response.statusCode, 404);
      await symlink(join(outside, 'leak.js'), join(root, 'leak.js'));
      await mkdir(join(root, 'folder'));
      await writeFile(join(root, 'huge.js'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
      await writeFile(join(root, 'unknown.bin'), 'not served');
      for (const [url, status] of [['/leak.js', 404], ['/folder', 404], ['/unknown.bin', 404], ['/huge.js', 413]]) {
        const result = await serve(new StaticFileServer({ rootDirectory: root }), { method: 'GET', url });
        assert.equal(result.response.statusCode, status, url);
      }
    } finally {
      await rm(rootLink, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('preloaded assets stay detached from later parent swaps and source edits', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'hod-static-preload-outside-'));
    const moved = `${root}-moved`;
    try {
      await writeFile(join(root, 'index.html'), 'before');
      const server = new StaticFileServer({ rootDirectory: root });
      await server.load();
      await writeFile(join(root, 'index.html'), 'after');
      await writeFile(join(root, 'new.js'), 'not in startup set');
      await writeFile(join(outside, 'index.html'), 'outside');
      await fsRename(root, moved); await symlink(outside, root);
      const result = await serve(server, { method: 'GET', url: '/' });
      assert.equal(result.response.statusCode, 200); assert.equal(result.response.body.toString(), 'before');
      assert.equal((await serve(server, { method: 'GET', url: '/new.js' })).response.statusCode, 404);
    } finally {
      await rm(root, { force: true }); await rm(moved, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
    }
  });
});
