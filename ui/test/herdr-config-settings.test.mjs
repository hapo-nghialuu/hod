import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  herdrSettingDefs,
  isAllowlistedSetting,
  validateSettingValue,
  serializeSettingValue,
  publicSettingMetadata,
} from '../server/settings/herdr-setting-definitions.mjs';

test('allowlist covers the ten required keys', () => {
  const expected = [
    'theme.name',
    'theme.auto_switch',
    'theme.light_name',
    'theme.dark_name',
    'ui.agent_panel_sort',
    'ui.toast.delivery',
    'ui.toast.delay_seconds',
    'ui.sound.enabled',
    'session.resume_agents_on_restore',
    'advanced.scrollback_limit_bytes',
  ];
  for (const key of expected) {
    assert.equal(isAllowlistedSetting(key), true, key);
  }
});

test('unknown keys are never allowlisted', () => {
  assert.equal(isAllowlistedSetting('theme.secret'), false);
  assert.equal(isAllowlistedSetting('api_key'), false);
  assert.equal(isAllowlistedSetting('theme'), false);
  assert.equal(isAllowlistedSetting(''), false);
});

test('every definition has typed metadata', () => {
  for (const [key, def] of Object.entries(herdrSettingDefs())) {
    assert.ok(['string', 'boolean', 'integer'].includes(def.type), key);
    assert.equal(typeof def.restart, 'boolean', key);
    assert.equal(typeof def.description, 'string', key);
    assert.ok(def.description.length > 0, key);
  }
});

test('theme settings accept only Herdr built-in names', () => {
  const builtIns = [
    'catppuccin',
    'terminal',
    'tokyo-night',
    'dracula',
    'nord',
    'gruvbox',
    'one-dark',
    'solarized',
    'kanagawa',
    'rose-pine',
    'vesper',
  ];
  assert.deepEqual(herdrSettingDefs()['theme.name'].enum, builtIns);
  assert.deepEqual(herdrSettingDefs()['theme.dark_name'].enum, builtIns);
  assert.deepEqual(
    herdrSettingDefs()['theme.light_name'].enum,
    [...builtIns, 'catppuccin-latte'],
  );
  for (const name of builtIns) {
    assert.equal(validateSettingValue('theme.name', name), name);
    assert.equal(validateSettingValue('theme.dark_name', name), name);
    assert.equal(validateSettingValue('theme.light_name', name), name);
  }
  assert.equal(validateSettingValue('theme.light_name', 'catppuccin-latte'), 'catppuccin-latte');
  assert.equal(validateSettingValue('theme.name', 'catppuccin-latte'), null);
  assert.equal(validateSettingValue('theme.name', 'dark'), null);
  assert.equal(validateSettingValue('theme.name', 'github_dark'), null);
  assert.equal(validateSettingValue('theme.name', 'neon'), null);
  assert.equal(validateSettingValue('theme.name', 3), null);
});

test('Herdr defaults and current scalar enums are exact', () => {
  const defs = herdrSettingDefs();
  assert.equal(defs['theme.name'].default, 'catppuccin');
  assert.equal(defs['theme.light_name'].default, 'catppuccin-latte');
  assert.equal(defs['theme.dark_name'].default, 'catppuccin');
  assert.equal(defs['ui.agent_panel_sort'].default, 'spaces');
  assert.deepEqual(defs['ui.agent_panel_sort'].enum, ['spaces', 'priority', 'workspaces']);
  assert.equal(validateSettingValue('ui.agent_panel_sort', 'spaces'), 'spaces');
  assert.equal(validateSettingValue('ui.agent_panel_sort', 'priority'), 'priority');
  assert.equal(validateSettingValue('ui.agent_panel_sort', 'workspaces'), 'workspaces');
  assert.equal(validateSettingValue('ui.agent_panel_sort', 'by_state'), null);
  assert.equal(defs['ui.toast.delivery'].default, 'off');
  assert.deepEqual(defs['ui.toast.delivery'].enum, ['off', 'herdr', 'terminal', 'system']);
  assert.equal(validateSettingValue('ui.toast.delivery', 'off'), 'off');
  assert.equal(validateSettingValue('ui.toast.delivery', 'herdr'), 'herdr');
  assert.equal(validateSettingValue('ui.toast.delivery', 'terminal'), 'terminal');
  assert.equal(validateSettingValue('ui.toast.delivery', 'system'), 'system');
  assert.equal(validateSettingValue('ui.toast.delivery', 'auto'), null);
  assert.equal(defs['ui.toast.delay_seconds'].default, 1);
  assert.equal(defs['advanced.scrollback_limit_bytes'].default, 10000000);
});

test('bounds reject out-of-range integers', () => {
  assert.equal(validateSettingValue('ui.toast.delay_seconds', 5), 5);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', 0), 0);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', 300), 300);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', -1), null);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', 301), null);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', 1.5), null);
  assert.equal(validateSettingValue('ui.toast.delay_seconds', '5'), null);

  assert.equal(validateSettingValue('advanced.scrollback_limit_bytes', 262144), 262144);
  assert.equal(validateSettingValue('advanced.scrollback_limit_bytes', 1073741824), 1073741824);
  assert.equal(validateSettingValue('advanced.scrollback_limit_bytes', 262143), null);
  assert.equal(validateSettingValue('advanced.scrollback_limit_bytes', 1073741825), null);
});

test('booleans are strict', () => {
  assert.equal(validateSettingValue('ui.sound.enabled', true), true);
  assert.equal(validateSettingValue('ui.sound.enabled', false), false);
  assert.equal(validateSettingValue('ui.sound.enabled', 'true'), null);
  assert.equal(validateSettingValue('ui.sound.enabled', 1), null);
});

test('serialize emits TOML literals', () => {
  const defs = herdrSettingDefs();
  assert.equal(serializeSettingValue(defs['theme.name'], 'dark'), '"dark"');
  assert.equal(serializeSettingValue(defs['ui.sound.enabled'], true), 'true');
  assert.equal(serializeSettingValue(defs['ui.sound.enabled'], false), 'false');
  assert.equal(
    serializeSettingValue(defs['advanced.scrollback_limit_bytes'], 16777216),
    '16777216',
  );
  // Strings with quote/backslash are escaped for TOML basic strings.
  assert.equal(serializeSettingValue(defs['theme.name'], 'a"b\\c'), '"a\\"b\\\\c"');
});

test('restart classification is explicit', () => {
  const defs = herdrSettingDefs();
  assert.equal(defs['session.resume_agents_on_restore'].restart, true);
  assert.equal(defs['advanced.scrollback_limit_bytes'].restart, true);
  assert.equal(defs['theme.name'].restart, false);
  assert.equal(defs['ui.toast.delay_seconds'].restart, false);
});

test('public metadata is plain serializable JSON', () => {
  const meta = publicSettingMetadata();
  const keys = Object.keys(meta);
  assert.equal(keys.length, 10);
  for (const [key, def] of Object.entries(meta)) {
    assert.equal(typeof def, 'object', key);
    assert.equal(typeof def.type, 'string', key);
    assert.equal(typeof def.restart, 'boolean', key);
    if (def.enum !== undefined) {
      assert.ok(Array.isArray(def.enum), key);
    }
  }
  // Round-trips through JSON without losing anything.
  const cloned = JSON.parse(JSON.stringify(meta));
  assert.deepEqual(cloned, meta);
});
