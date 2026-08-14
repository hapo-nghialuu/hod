import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicConfigWrite, readConfigSnapshot } from '../server/settings/atomic-config-write.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await fs.rm(roots.pop(), { recursive: true, force: true }); });
async function fixture(content = null, mode = 0o640) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'hod-config-test-')); roots.push(dir); const configPath = join(dir, 'config.toml');
  if (content !== null) { await fs.writeFile(configPath, content); await fs.chmod(configPath, mode); }
  return { dir, configPath };
}
function runner(log, behavior = {}) {
  return async (file, args, options) => {
    log.push({ file, args: [...args], options });
    if (behavior[args.join(' ')] instanceof Error) throw behavior[args.join(' ')];
    if (behavior[args.join(' ')] === 'change') await fs.writeFile(log.configPath, 'changed = true\n');
    return { stdout: '', stderr: '', status: 0 };
  };
}
const randomBytes = () => Buffer.from('fixed-random');
const clock = () => 123;

test('success writes exact bytes, makes a 0600 backup, preserves mode, and uses safe argv/env', async () => {
  const f = await fixture('secret = "keep"\n'); const log = []; log.configPath = f.configPath;
  const snapshot = await readConfigSnapshot(f.configPath); const calls = [];
  const result = await atomicConfigWrite({ configPath: f.configPath, snapshot, nextBytes: Buffer.from('secret = "new"\n'), runCommand: runner(calls), randomBytes, clock, herdrBin: '/bin/herdr-fixture' });
  assert.deepEqual(result, { backupCreated: true }); assert.equal(await fs.readFile(f.configPath, 'utf8'), 'secret = "new"\n');
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o640);
  const backup = (await fs.readdir(f.dir)).find((name) => name.includes('.bak.')); assert.ok(backup);
  assert.equal(await fs.readFile(join(f.dir, backup), 'utf8'), 'secret = "keep"\n'); assert.equal((await fs.stat(join(f.dir, backup))).mode & 0o777, 0o600);
  assert.deepEqual(calls.map((call) => call.args), [['config', 'check'], ['server', 'reload-config']]);
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.timeout, 10000); assert.equal(calls[0].options.maxBuffer, 65536);
  assert.match(calls[0].options.env.HERDR_CONFIG_PATH, /\.tmp\./);
  assert.equal(calls[1].options.env.HERDR_CONFIG_PATH, f.configPath); assert.equal(calls[1].options.shell, false);
});

test('validation failure leaves original bytes and cleans temp/backup', async () => {
  const f = await fixture('keep = true\n'); const snapshot = await readConfigSnapshot(f.configPath); const error = new Error('secret command output');
  error.stdout = 'TOKEN=do-not-return'; const calls = []; const runCommand = runner(calls, { 'config check': error });
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, snapshot, nextBytes: Buffer.from('keep = false\n'), runCommand, randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_VALIDATION' });
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'keep = true\n'); assert.deepEqual(await fs.readdir(f.dir), ['config.toml']);
});

test('rejects config symlink without touching its target', async () => {
  const f = await fixture('outside = true\n'); const link = join(f.dir, 'link.toml'); const target = join(f.dir, 'target.toml');
  await fs.rename(f.configPath, target); await fs.symlink(target, link);
  await assert.rejects(() => atomicConfigWrite({ configPath: link, nextBytes: Buffer.from('x = 1\n'), runCommand: runner([]) }), { code: 'ERR_HERDR_CONFIG_UNSAFE' });
  assert.equal(await fs.readFile(target, 'utf8'), 'outside = true\n');
});

test('rejects a writable parent before creating a temp or backup', async () => {
  const f = await fixture('keep = true\n'); await fs.chmod(f.dir, 0o775);
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, nextBytes: Buffer.from('x = 1\n'), runCommand: runner([]) }), { code: 'ERR_HERDR_CONFIG_UNSAFE' });
  assert.deepEqual(await fs.readdir(f.dir), ['config.toml']);
});

test('detects an immediate parent replacement before rename', async () => {
  const f = await fixture('keep = true\n'); const moved = `${f.dir}-moved`; const calls = [];
  const runCommand = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (args.join(' ') === 'config check') { await fs.rename(f.dir, moved); await fs.mkdir(f.dir); }
    return { stdout: '', stderr: '', status: 0 };
  };
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, nextBytes: Buffer.from('x = 1\n'), runCommand, randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_CHANGED' });
  roots.push(moved); assert.equal(calls.length, 1); assert.deepEqual(await fs.readdir(f.dir), []);
});

test('detects an original changed after validation and cleans temp', async () => {
  const f = await fixture('keep = true\n'); const snapshot = await readConfigSnapshot(f.configPath); const calls = []; calls.configPath = f.configPath;
  const runCommand = runner(calls, { 'config check': 'change' });
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, snapshot, nextBytes: Buffer.from('keep = false\n'), runCommand, randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_CHANGED' });
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'changed = true\n'); assert.equal((await fs.readdir(f.dir)).some((name) => name.includes('.tmp.')), false);
});

test('reload failure rolls back an existing config and keeps backup', async () => {
  const f = await fixture('keep = true\n'); const snapshot = await readConfigSnapshot(f.configPath); const failReload = new Error('secret reload failure');
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, snapshot, nextBytes: Buffer.from('keep = false\n'), runCommand: runner([], { 'server reload-config': failReload }), randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_RELOAD' });
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'keep = true\n'); assert.equal((await fs.readdir(f.dir)).some((name) => name.includes('.bak.')), true);
});

test('reload failure removes a newly-created config and leaves no temp', async () => {
  const f = await fixture(null); const snapshot = await readConfigSnapshot(f.configPath); const failReload = new Error('secret reload failure');
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, snapshot, nextBytes: Buffer.from('keep = false\n'), runCommand: runner([], { 'server reload-config': failReload }), randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_RELOAD' });
  await assert.rejects(() => fs.stat(f.configPath), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(f.dir), []);
});

test('rollback refuses a swapped final symlink instead of touching its target', async () => {
  const f = await fixture('keep = true\n'); const outside = join(f.dir, 'outside.toml'); const moved = join(f.dir, 'replaced.toml');
  await fs.writeFile(outside, 'outside = true\n'); let reloads = 0;
  const runCommand = async (file, args, options) => {
    if (args.join(' ') === 'server reload-config' && reloads++ === 0) {
      await fs.rename(f.configPath, moved); await fs.symlink(outside, f.configPath); throw new Error('reload failed');
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  await assert.rejects(() => atomicConfigWrite({ configPath: f.configPath, nextBytes: Buffer.from('keep = false\n'), runCommand, randomBytes, clock }), { code: 'ERR_HERDR_CONFIG_ROLLBACK' });
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside = true\n');
});
