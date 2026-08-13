import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveApplicationPaths } from '../server/application-paths.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hod-paths-'));
  await mkdir(join(root, 'ui', 'public'), { recursive: true });
  await mkdir(join(root, 'templates'), { recursive: true });
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'ui', 'public', 'index.html'), 'ok');
  return root;
}

test('source and installed layouts resolve public/templates/project without reading config', async () => {
  const root = await fixture();
  try {
    const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg') };
    const source = resolveApplicationPaths({ entryFile: join(root, 'ui', 'server.mjs'), cwd: join(root, 'project'), env, directSourceInvocation: true });
    const installed = resolveApplicationPaths({ entryFile: join(root, 'ui', 'server.mjs'), project: join(root, 'project'), env, hodBin: '/custom/hod' });
    assert.equal(source.publicRoot, await realpath(join(root, 'ui', 'public')));
    assert.equal(source.templatesRoot, await realpath(join(root, 'templates')));
    assert.equal(source.projectRoot, await realpath(join(root, 'project')));
    assert.equal(source.configPath, join(root, 'xdg', 'herdr', 'config.toml'));
    assert.equal(source.hodBin, join(root, 'bin', 'hod'));
    assert.equal(installed.hodBin, '/custom/hod');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HERDR_CONFIG_PATH wins over XDG and HOME and asset/template roots reject symlinks', async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'hod-paths-outside-'));
  try {
    const env = { HERDR_CONFIG_PATH: join(root, 'explicit.toml'), XDG_CONFIG_HOME: join(root, 'xdg'), HOME: join(root, 'home') };
    const paths = resolveApplicationPaths({ entryFile: join(root, 'ui', 'server.mjs'), project: join(root, 'project'), env });
    assert.equal(paths.configPath, env.HERDR_CONFIG_PATH);
    await rm(join(root, 'ui', 'public'), { recursive: true, force: true });
    await symlink(outside, join(root, 'ui', 'public'));
    assert.throws(() => resolveApplicationPaths({ entryFile: join(root, 'ui', 'server.mjs'), project: join(root, 'project'), env }), { code: 'ERR_PUBLIC_ROOT' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
