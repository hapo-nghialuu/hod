import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHerdrConfigSettings } from '../server/settings/herdr-config-settings.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await fs.rm(roots.pop(), { recursive: true, force: true }); });
async function createFixture(content = null, runCommand) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'hod-settings-test-')); roots.push(dir); const configPath = join(dir, 'config.toml');
  if (content !== null) await fs.writeFile(configPath, content);
  return { configPath, service: createHerdrConfigSettings({ configPath, runCommand, randomBytes: () => Buffer.from('service-random'), clock: () => 7 }) };
}
function okRunner(log = [], delay = 0) { return async (file, args, options) => { log.push({ file, args, options }); if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); return { stdout: '', stderr: '', status: 0 }; }; }
function byKey(list, key) { return list.find((setting) => setting.key === key); }

test('list always returns only ten public settings with typed defaults', async () => {
  const { service } = await createFixture(); const list = await service.list(); assert.equal(list.length, 10);
  for (const item of list) { assert.deepEqual(Object.keys(item).sort(), ['key', 'metadata', 'source', 'value']); assert.equal(item.source, 'default'); assert.equal(typeof item.metadata, 'object'); }
  assert.equal(JSON.stringify(list).includes('config.toml'), false);
});

test('reads typed scalars and never exposes unknown or secret values', async () => {
  const { service } = await createFixture('[theme]\nname = "terminal"\n[ui.toast]\ndelay_seconds = 12\n[ui.sound]\nenabled = false\n[session]\nresume_agents_on_restore = true\n[unknown]\nsecret = "TOKEN-123"\n');
  const list = await service.list(); assert.deepEqual(byKey(list, 'theme.name').value, 'terminal'); assert.equal(byKey(list, 'ui.toast.delay_seconds').value, 12);
  assert.equal(byKey(list, 'ui.sound.enabled').value, false); assert.equal(byKey(list, 'session.resume_agents_on_restore').value, true);
  assert.equal(byKey(list, 'theme.name').source, 'config'); assert.equal(JSON.stringify(list).includes('TOKEN-123'), false); assert.equal(JSON.stringify(list).includes('unknown'), false);
});

test('invalid allowlist scalars use defaults and source invalid without raw values', async () => {
  const { service } = await createFixture('[theme]\nname = "secret-model"\n[ui.toast]\ndelay_seconds = 999\n[ui.sound]\nenabled = "true"\n'); const list = await service.list();
  for (const [key, value] of [['theme.name', 'catppuccin'], ['ui.toast.delay_seconds', 1], ['ui.sound.enabled', true]]) { const setting = byKey(list, key); assert.equal(setting.value, value); assert.equal(setting.source, 'invalid'); }
  assert.equal(JSON.stringify(list).includes('secret-model'), false);
});

test('duplicate and complex target values fail closed', async () => {
  for (const content of ['[theme]\nname = "terminal"\nname = "dracula"\n', '[theme]\nname = ["terminal"]\n']) {
    const { service } = await createFixture(content); await assert.rejects(() => service.list(), { code: 'ERR_HERDR_SETTINGS_PARSE' });
  }
});

test('update requires exact confirmation and typed allowlist values', async () => {
  const log = []; const { service } = await createFixture('[theme]\nname = "terminal"\n', okRunner(log));
  await assert.rejects(() => service.update({ key: 'theme.name', value: 'dracula', confirmation: 'apply herdr setting' }), { code: 'ERR_HERDR_SETTINGS_CONFIRMATION' });
  await assert.rejects(() => service.update({ key: 'unknown', value: true, confirmation: 'APPLY HERDR SETTING' }), { code: 'ERR_HERDR_SETTINGS_KEY' });
  await assert.rejects(() => service.update({ key: 'theme.name', value: 'TOKEN-123', confirmation: 'APPLY HERDR SETTING' }), { code: 'ERR_HERDR_SETTINGS_VALUE' }); assert.equal(log.length, 0);
});

test('update patches safely and concurrent mutations are queued', async () => {
  const log = []; const { configPath, service } = await createFixture('[theme]\nname = "terminal"\n', okRunner(log, 5));
  const first = service.update({ key: 'theme.name', value: 'dracula', confirmation: 'APPLY HERDR SETTING' });
  const second = service.update({ key: 'theme.name', value: 'nord', confirmation: 'APPLY HERDR SETTING' });
  const results = await Promise.all([first, second]); assert.equal(results[0].setting.value, 'dracula'); assert.equal(results[1].setting.value, 'nord');
  assert.equal((await fs.readFile(configPath, 'utf8')).includes('name = "nord"'), true); assert.equal(log.filter((entry) => entry.args.join(' ') === 'config check').length, 2);
  assert.equal(results[0].backupCreated, true); assert.equal(results[1].restartRequired, false); assert.equal(JSON.stringify(results).includes('TOKEN'), false);
});

test('command failure returns sanitized JSON error', async () => {
  const error = new Error('TOKEN-123'); error.stderr = 'TOKEN-123'; const fixtureResult = await createFixture('[theme]\nname = "terminal"\n', okRunner());
  const failing = createHerdrConfigSettings({ configPath: fixtureResult.configPath, runCommand: async () => { throw error; } });
  await assert.rejects(() => failing.update({ key: 'theme.name', value: 'dracula', confirmation: 'APPLY HERDR SETTING' }), (caught) => !JSON.stringify(caught).includes('TOKEN-123'));
});
