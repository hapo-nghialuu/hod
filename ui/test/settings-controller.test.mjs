import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSettingsController,
  SETTINGS_CONFIRMATIONS,
} from '../server/settings/settings-controller.mjs';

const herdrItems = [
  { key: 'theme.name', value: 'terminal', source: 'config', metadata: { secret: 'do-not-copy' } },
  { key: 'ui.sound.enabled', value: false, source: 'config', metadata: { type: 'boolean' } },
];

function services(log = []) {
  return {
    hod: {
      async list() { return [
        { role: 'controller', status: 'matches', unsafe: false, secret: 'hidden' },
        { role: 'impl', status: 'different', unsafe: false },
        { role: 'reviewer', status: 'missing', unsafe: false },
      ]; },
      async install(input) { log.push(['hod', input]); return { role: input.role, status: 'matches', unsafe: false }; },
    },
    herdr: {
      async list() { return herdrItems; },
      async update(input) { log.push(['herdr', input]); return {
        setting: { key: input.key, value: input.value, source: 'config', metadata: { secret: 'hidden' } },
        backupCreated: true, restartRequired: false,
      }; },
    },
  };
}

test('GET exposes the exact frontend settings shape and public metadata only', async () => {
  const controller = createSettingsController(services());
  const result = await controller.get();
  assert.deepEqual(Object.keys(result), ['hod', 'herdr']);
  assert.deepEqual(result.hod.roles, [
    { role: 'controller', status: 'matches', unsafe: false },
    { role: 'impl', status: 'different', unsafe: false },
    { role: 'reviewer', status: 'missing', unsafe: false },
  ]);
  assert.deepEqual(result.herdr.settings[0], {
    key: 'theme.name', value: 'terminal', source: 'config',
    metadata: {
      type: 'string', enum: ['catppuccin', 'terminal', 'tokyo-night', 'dracula', 'nord', 'gruvbox', 'one-dark', 'solarized', 'kanagawa', 'rose-pine', 'vesper'],
      restart: false, default: 'catppuccin', description: 'Active color theme.',
    },
  });
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('POST validates exact confirmations and forwards only typed public inputs', async () => {
  const log = [];
  const controller = createSettingsController(services(log));
  await controller.postHod({ role: 'impl', force: true, confirmation: SETTINGS_CONFIRMATIONS.overwrite, secret: 'drop' });
  await controller.postHerdr({ key: 'ui.sound.enabled', value: true, confirmation: SETTINGS_CONFIRMATIONS.herdr, secret: 'drop' });
  assert.deepEqual(log, [
    ['hod', { role: 'impl', force: true, confirmation: 'OVERWRITE HOD ROLE' }],
    ['herdr', { key: 'ui.sound.enabled', value: true, confirmation: 'APPLY HERDR SETTING' }],
  ]);
  await assert.rejects(controller.postHod({ role: 'impl', force: false, confirmation: 'INSTALL HOD ROLE ' }), { code: 'ERR_HOD_SETTINGS_CONFIRMATION' });
  await assert.rejects(controller.postHerdr({ key: 'ui.sound.enabled', value: 'true', confirmation: SETTINGS_CONFIRMATIONS.herdr }), { code: 'ERR_HERDR_SETTINGS_VALUE' });
  await assert.rejects(controller.postHerdr({ key: 'unknown', value: true, confirmation: SETTINGS_CONFIRMATIONS.herdr }), { code: 'ERR_HERDR_SETTINGS_KEY' });
});

test('concurrent mutations are serialized before reaching the service', async () => {
  const calls = [];
  let active = 0;
  const base = services();
  base.herdr.update = async (input) => {
    active += 1;
    assert.equal(active, 1);
    calls.push(input.value);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { setting: { key: input.key, value: input.value, source: 'config' } };
  };
  const controller = createSettingsController(base);
  await Promise.all([
    controller.postHerdr({ key: 'theme.name', value: 'dracula', confirmation: SETTINGS_CONFIRMATIONS.herdr }),
    controller.postHerdr({ key: 'theme.name', value: 'nord', confirmation: SETTINGS_CONFIRMATIONS.herdr }),
  ]);
  assert.deepEqual(calls, ['dracula', 'nord']);
});
