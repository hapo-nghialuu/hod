import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeOptions, DEFAULT_PORT, MIN_PORT, MAX_PORT } from '../server/runtime-options.mjs';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hod-rt-options-'));
  return dir;
}

function withProjectDir(fn) {
  const dir = tempDir();
  mkdirSync(join(dir, 'proj'));
  writeFileSync(join(dir, 'proj', 'file.txt'), 'x');
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('empty argv yields defaults', () => {
  const opts = parseRuntimeOptions([]);
  assert.equal(opts.port, DEFAULT_PORT);
  assert.equal(opts.open, true);
  assert.equal(opts.project, undefined);
  assert.equal(opts.hodBin, undefined);
});

test('--port accepts 0 and the top of the range', () => {
  assert.equal(parseRuntimeOptions(['--port', '0']).port, 0);
  assert.equal(parseRuntimeOptions(['--port', String(MAX_PORT)]).port, MAX_PORT);
});

test('--port rejects negatives, overflow, text, and floats', () => {
  for (const bad of ['-1', String(MAX_PORT + 1), 'abc', '1.5', '']) {
    assert.throws(
      () => parseRuntimeOptions(['--port', bad]),
      (err) => err.code === 'ERR_USAGE' && /--port/.test(err.message),
    );
  }
});

test('--port rejects a duplicate', () => {
  assert.throws(
    () => parseRuntimeOptions(['--port', '8000', '--port', '8001']),
    (err) => err.code === 'ERR_USAGE' && /duplicate option: --port/.test(err.message),
  );
});

test('--port without a value rejects', () => {
  assert.throws(
    () => parseRuntimeOptions(['--port']),
    (err) => err.code === 'ERR_USAGE' && /requires a value/.test(err.message),
  );
});

test('--no-open toggles open false and is idempotent on duplicate rejection', () => {
  assert.equal(parseRuntimeOptions(['--no-open']).open, false);
  assert.throws(
    () => parseRuntimeOptions(['--no-open', '--no-open']),
    (err) => err.code === 'ERR_USAGE',
  );
});

test('--project requires an existing directory', () => {
  withProjectDir((dir) => {
    const good = join(dir, 'proj');
    const opts = parseRuntimeOptions(['--project', good]);
    assert.equal(opts.project, good);
  });

  withProjectDir((dir) => {
    const missing = join(dir, 'nope');
    assert.throws(
      () => parseRuntimeOptions(['--project', missing]),
      (err) => err.code === 'ERR_USAGE' && /not an existing directory/.test(err.message),
    );
  });

  withProjectDir((dir) => {
    const file = join(dir, 'proj', 'file.txt');
    assert.throws(
      () => parseRuntimeOptions(['--project', file]),
      (err) => err.code === 'ERR_USAGE',
    );
  });
});

test('--project duplicate rejects', () => {
  withProjectDir((dir) => {
    assert.throws(
      () => parseRuntimeOptions(['--project', join(dir, 'proj'), '--project', join(dir, 'proj')]),
      (err) => err.code === 'ERR_USAGE',
    );
  });
});

test('--hod-bin accepts a value and falls back to env HOD_BIN', () => {
  assert.equal(parseRuntimeOptions(['--hod-bin', '/x/bin']).hodBin, '/x/bin');
  assert.equal(parseRuntimeOptions([], { HOD_BIN: '/env/bin' }).hodBin, '/env/bin');
  // Explicit flag wins over env.
  assert.equal(parseRuntimeOptions(['--hod-bin', '/x'], { HOD_BIN: '/env' }).hodBin, '/x');
});

test('runtime-only parsing accepts only the internal selector plus read-only launch options', () => {
  assert.deepEqual(parseRuntimeOptions([
    '--runtime-only', '--port', '4317', '--no-open', '--hod-bin', '/x/hod',
  ]), {
    project: undefined, port: 4317, open: false, hodBin: '/x/hod', runtimeOnly: true,
  });
  assert.throws(
    () => parseRuntimeOptions(['--runtime-only', '--runtime-only']),
    (err) => err.code === 'ERR_USAGE' && /duplicate option/.test(err.message),
  );
});

test('runtime-only rejects --project before validating or reading its value', () => {
  for (const argv of [
    ['--runtime-only', '--project', '/path/that/does/not/exist'],
    ['--project', '/path/that/does/not/exist', '--runtime-only'],
  ]) {
    assert.throws(
      () => parseRuntimeOptions(argv),
      (err) => err.code === 'ERR_USAGE' && /not supported in runtime-only/.test(err.message),
    );
  }
});

test('unknown flag rejects with the flag named', () => {
  assert.throws(
    () => parseRuntimeOptions(['--bogus']),
    (err) => err.code === 'ERR_USAGE' && /unknown option: --bogus/.test(err.message),
  );
});

test('a positional argument is rejected', () => {
  assert.throws(
    () => parseRuntimeOptions(['start']),
    (err) => err.code === 'ERR_USAGE' && /unknown option: start/.test(err.message),
  );
});

test('range constants match the contract', () => {
  assert.equal(MIN_PORT, 0);
  assert.equal(MAX_PORT, 65535);
});
