import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patchTomlScalar } from '../server/settings/toml-scalar-patcher.mjs';

test('patches an existing simple string value in place', () => {
  const input = '# top comment\n[theme]\nname = "dark"  # inline note\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.name',
    literal: '"light"',
  });
  assert.equal(out, '# top comment\n[theme]\nname = "light"  # inline note\n');
});

test('preserves CRLF, spacing, comments, and trailing blank lines', () => {
  const input = '# keep\r\n[theme] # keep header\r\n\tname\t = \t"dark"\t# keep value\r\n\r\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.name',
    literal: '"light"',
  });
  assert.equal(out, '# keep\r\n[theme] # keep header\r\n\tname\t = \t"light"\t# keep value\r\n\r\n');
});

test('preserves untouched bytes and comments elsewhere', () => {
  const input = [
    'title = "x"  # keep me',
    '',
    '[theme]',
    'name = "dark"',
    'light_name = "solarized_light"  # untouched',
    '',
    '[unknown_table]',
    'secret = "never touch"',
    '# trailing comment',
  ].join('\n');
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.name',
    literal: '"auto"',
  });
  assert.ok(out.includes('title = "x"  # keep me'));
  assert.ok(out.includes('name = "auto"'));
  assert.ok(out.includes('light_name = "solarized_light"  # untouched'));
  assert.ok(out.includes('secret = "never touch"'));
  assert.ok(out.endsWith('# trailing comment'));
});

test('patches a boolean value', () => {
  const input = '[session]\nresume_agents_on_restore = true\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'session.resume_agents_on_restore',
    literal: 'false',
  });
  assert.ok(out.includes('resume_agents_on_restore = false'));
});

test('patches an integer value', () => {
  const input = '[advanced]\nscrollback_limit_bytes = 8388608\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'advanced.scrollback_limit_bytes',
    literal: '16777216',
  });
  assert.ok(out.includes('scrollback_limit_bytes = 16777216'));
});

test('appends a missing key to an existing table', () => {
  const input = '[theme]\nname = "dark"\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.dark_name',
    literal: '"github_dark"',
  });
  assert.ok(out.includes('[theme]'));
  assert.ok(out.includes('name = "dark"'));
  assert.ok(out.includes('dark_name = "github_dark"'));
  assert.ok(out.indexOf('name =') < out.indexOf('dark_name ='));
});

test('creates a missing table at the end', () => {
  const input = '[theme]\nname = "dark"\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'ui.toast.delivery',
    literal: '"off"',
  });
  assert.ok(out.includes('[ui.toast]'));
  assert.ok(out.includes('delivery = "off"'));
  assert.ok(out.endsWith('delivery = "off"\n'));
});

test('rejects a duplicate target key in the same table', () => {
  const input = '[theme]\nname = "dark"\nname = "light"\n';
  assert.throws(() =>
    patchTomlScalar({ toml: input, key: 'theme.name', literal: '"x"' }),
    /duplicate/,
  );
});

test('rejects a multiline target value', () => {
  const input = '[advanced]\nscrollback_limit_bytes = """\n1048576\n"""\n';
  assert.throws(() =>
    patchTomlScalar({
      toml: input,
      key: 'advanced.scrollback_limit_bytes',
      literal: '2097152',
    }),
    /complex or multiline/,
  );
});

test('rejects an array target value', () => {
  const input = '[theme]\nname = ["dark", "light"]\n';
  assert.throws(() =>
    patchTomlScalar({ toml: input, key: 'theme.name', literal: '"dark"' }),
    /complex or multiline/,
  );
});

test('rejects an inline table target value', () => {
  const input = '[theme]\nname = { a = 1 }\n';
  assert.throws(() =>
    patchTomlScalar({ toml: input, key: 'theme.name', literal: '"dark"' }),
    /complex or multiline/,
  );
});

test('does not touch the same key under a different table', () => {
  const input = '[theme]\nname = "dark"\n[ui]\nname = "other"\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.name',
    literal: '"light"',
  });
  assert.ok(out.includes('[theme]\nname = "light"'));
  assert.ok(out.includes('[ui]\nname = "other"'));
});

test('patches a root dotted assignment without creating a duplicate table', () => {
  const input = 'theme.name = "dark"\n[ui]\nagent_panel_sort = "spaces"\n';
  const out = patchTomlScalar({
    toml: input,
    key: 'theme.name',
    literal: '"catppuccin"',
  });
  assert.equal(out, 'theme.name = "catppuccin"\n[ui]\nagent_panel_sort = "spaces"\n');
});

test('rejects a complex replacement literal before changing the document', () => {
  assert.throws(
    () => patchTomlScalar({ toml: '[theme]\nname = "dark"\n', key: 'theme.name', literal: '"x" # inject' }),
    /single simple TOML scalar/,
  );
});

test('rejects an invalid dotted key', () => {
  assert.throws(() =>
    patchTomlScalar({ toml: '', key: 'theme..name', literal: '"x"' }),
    /invalid setting key/,
  );
});
