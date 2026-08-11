import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOD_ROLE_SETTINGS_ERROR_CODES,
  createHodRoleSettings,
} from '../server/settings/hod-role-settings.mjs';
import { readCappedRegularFile } from '../server/settings/hod-role-inspector.mjs';

const ROLES = ['controller', 'impl', 'reviewer'];
const SECRET = 'FIXTURE_SECRET_MUST_NOT_ESCAPE';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hod-role-settings-'));
  const project = join(root, 'project');
  const templates = join(root, 'templates');
  mkdirSync(project);
  mkdirSync(templates);
  for (const role of ROLES) {
    writeFileSync(join(templates, `settings-${role}.json`), JSON.stringify({ role, secret: SECRET }) + '\n');
  }
  return { root, project, templates };
}

function makeAdapter(fx, runCommand = async () => ({ stdout: '', stderr: '' })) {
  return createHodRoleSettings({
    projectRoot: fx.project,
    templatesRoot: fx.templates,
    hodBin: '/fixture/bin/hod',
    runCommand,
  });
}

function destination(fx, role) {
  return join(fx.project, '.claude', `settings.${role}.json`);
}

async function withFixture(fn) {
  const fx = fixture();
  try {
    await fn(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

test('list reports missing, matches, and different without fixture content', async () => {
  await withFixture(async (fx) => {
    const adapter = makeAdapter(fx);
    assert.deepEqual(await adapter.list(), ROLES.map((role) => ({ role, status: 'missing', unsafe: false })));
    mkdirSync(join(fx.project, '.claude'));
    writeFileSync(destination(fx, 'controller'), readFileSync(join(fx.templates, 'settings-controller.json')));
    writeFileSync(destination(fx, 'impl'), 'different\n');
    const listed = await adapter.list();
    assert.equal(listed[0].status, 'matches');
    assert.equal(listed[1].status, 'different');
    assert.equal(listed[2].status, 'missing');
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
  });
});

test('list marks symlink and non-regular destinations unsafe without following them', async () => {
  await withFixture(async (fx) => {
    mkdirSync(join(fx.project, '.claude'));
    symlinkSync(join(fx.templates, 'settings-controller.json'), destination(fx, 'controller'));
    mkdirSync(destination(fx, 'impl'));
    let calls = 0;
    const adapter = makeAdapter(fx, async () => { calls += 1; });
    const listed = await adapter.list();
    assert.deepEqual(listed[0], { role: 'controller', status: 'different', unsafe: true });
    assert.deepEqual(listed[1], { role: 'impl', status: 'different', unsafe: true });
    await assert.rejects(
      adapter.install({ role: 'controller', force: true, confirmation: 'OVERWRITE HOD ROLE' }),
      { code: HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE },
    );
    assert.equal(calls, 0);
  });
});

test('matches without force is a no-op and does not require confirmation or spawn', async () => {
  await withFixture(async (fx) => {
    mkdirSync(join(fx.project, '.claude'));
    writeFileSync(destination(fx, 'controller'), readFileSync(join(fx.templates, 'settings-controller.json')));
    let calls = 0;
    const adapter = makeAdapter(fx, async () => { calls += 1; });
    assert.deepEqual(await adapter.install({ role: 'controller' }), { role: 'controller', status: 'matches', unsafe: false });
    assert.equal(calls, 0);
  });
});

test('validates role, force, and exact confirmation before spawning', async () => {
  await withFixture(async (fx) => {
    let calls = 0;
    const adapter = makeAdapter(fx, async () => { calls += 1; });
    await assert.rejects(adapter.install({ role: 'nope' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.UNKNOWN_ROLE });
    await assert.rejects(adapter.install({ role: 'impl', confirmation: 'INSTALL HOD ROLE ' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.CONFIRMATION });
    await assert.rejects(adapter.install({ role: 'impl', confirmation: 'INSTALL HOD ROLE' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.POSTCONDITION });
    assert.equal(calls, 1);
    mkdirSync(join(fx.project, '.claude'));
    writeFileSync(destination(fx, 'impl'), 'old');
    await assert.rejects(adapter.install({ role: 'impl', confirmation: 'OVERWRITE HOD ROLE' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.FORCE_REQUIRED });
    assert.equal(calls, 1);
  });
});

test('uses canonical project argv, no shell, capped execution, and postcondition', async () => {
  await withFixture(async (fx) => {
    const calls = [];
    const adapter = makeAdapter(fx, async (file, args, options) => {
      calls.push({ file, args, options });
      mkdirSync(join(fx.project, '.claude'), { recursive: true });
      writeFileSync(destination(fx, 'reviewer'), readFileSync(join(fx.templates, 'settings-reviewer.json')));
      return { stdout: '', stderr: '' };
    });
    const result = await adapter.install({ role: 'reviewer', confirmation: 'INSTALL HOD ROLE' });
    assert.deepEqual(result, { role: 'reviewer', status: 'matches', unsafe: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/fixture/bin/hod');
    assert.deepEqual(calls[0].args, ['settings', 'install', '--project', realpathSync(fx.project), '--role', 'reviewer']);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.timeout, 10_000);
    assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  });
});

test('force overwrite, command failures, output cap, and postcondition are sanitized', async () => {
  await withFixture(async (fx) => {
    mkdirSync(join(fx.project, '.claude'));
    writeFileSync(destination(fx, 'controller'), 'old');
    let seenArgs;
    const failing = makeAdapter(fx, async (_file, args) => {
      seenArgs = args;
      const error = new Error(`stderr ${SECRET}`);
      error.code = 23;
      error.stderr = SECRET;
      throw error;
    });
    await assert.rejects(
      failing.install({ role: 'controller', force: true, confirmation: 'OVERWRITE HOD ROLE' }),
      (error) => error.code === HOD_ROLE_SETTINGS_ERROR_CODES.ENGINE
        && error.message === 'HOD settings command failed'
        && !error.message.includes(SECRET),
    );
    assert.deepEqual(seenArgs, ['settings', 'install', '--project', realpathSync(fx.project), '--role', 'controller', '--force']);
    const oversized = makeAdapter(fx, async () => ({ stdout: SECRET.repeat(4000), stderr: '' }));
    await assert.rejects(oversized.install({ role: 'controller', force: true, confirmation: 'OVERWRITE HOD ROLE' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.OUTPUT_LIMIT });
    const noWrite = makeAdapter(fx, async () => ({ stdout: '', stderr: '' }));
    await assert.rejects(noWrite.install({ role: 'controller', force: true, confirmation: 'OVERWRITE HOD ROLE' }), { code: HOD_ROLE_SETTINGS_ERROR_CODES.POSTCONDITION });
    assert.equal(JSON.stringify(await noWrite.list()).includes(SECRET), false);
  });
});

test('capped reader fails closed when opened inode differs from lstat inode', async () => {
  const fsBoundary = {
    lstat: async () => ({ dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false }),
    open: async () => ({
      stat: async () => ({ dev: 3, ino: 4, isFile: () => true, size: 2 }),
      close: async () => {},
    }),
  };
  await assert.rejects(
    readCappedRegularFile('injected-fixture', HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE, fsBoundary),
    { code: HOD_ROLE_SETTINGS_ERROR_CODES.UNSAFE },
  );
});
