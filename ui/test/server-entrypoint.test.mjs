import { test } from 'node:test';
import assert from 'node:assert/strict';

import { main, startHodUi } from '../server.mjs';

function paths(overrides = {}) {
  return { projectRoot: '/project', templatesRoot: '/templates', publicRoot: '/public', configPath: '/config.toml', hodBin: '/exact/hod', herdrBin: 'herdr', ...overrides };
}
function processFake(argv = []) {
  const listeners = new Map();
  return { argv: ['node', '/entry/server.mjs', ...argv], env: {}, platform: 'linux', exitCode: 0,
    cwd: () => '/project', on(signal, handler) { listeners.set(signal, handler); }, off(signal, handler) { if (listeners.get(signal) === handler) listeners.delete(signal); }, listeners };
}
function output() { return { stdout: [], stderr: [] }; }
function composition(overrides = {}) {
  const calls = { runtime: null, http: null, listen: null, starts: 0, stops: 0, closes: 0 };
  const runtime = { apiController: { handle() {} }, sseHub: { close() { calls.hubClosed = true; } }, async start() { calls.starts += 1; }, async stop() { calls.stops += 1; } };
  const http = { port: 0, sseHub: runtime.sseHub, async listen(port) { calls.listen = port; this.port = 4317; return { port: 4317 }; }, async close() { calls.closes += 1; } };
  return { calls, runtime, http, options: {
    argv: ['--project', '/project', '--port', '0', '--no-open'], process: processFake(), output: output(),
    parseOptions: (argv) => ({ project: argv[1], port: 0, open: false, hodBin: '/exact/hod' }),
    resolvePaths: (options) => { calls.pathsInput = options; return paths(); },
    randomBytes: (size) => { calls.randomSize = size; return Buffer.alloc(size, 7); },
    createRuntime: (options) => { calls.runtime = options; return runtime; },
    createHttpServer: (options) => { calls.http = options; return http; }, ...overrides,
  } };
}

test('wires port 0, exact options, shared API/SSE, and token only in fragment', async () => {
  const fixture = composition();
  const app = await startHodUi(fixture.options);
  assert.equal(fixture.calls.listen, 0);
  assert.equal(fixture.calls.randomSize, 32);
  assert.equal(fixture.calls.runtime.hodRoleSettingsOptions.hodBin, '/exact/hod');
  assert.equal(fixture.calls.runtime.herdrConfigSettingsOptions.configPath, '/config.toml');
  assert.equal(fixture.calls.http.apiController, fixture.runtime.apiController);
  assert.equal(fixture.calls.http.sseHub, fixture.runtime.sseHub);
  assert.equal(fixture.options.output.stdout.length, 1);
  assert.match(fixture.options.output.stdout[0], /^http:\/\/127\.0\.0\.1:4317\/\#token=/);
  assert.equal(new URL(fixture.options.output.stdout[0]).search, '');
  assert.equal(fixture.options.output.stdout[0].split('#token=')[1].length > 20, true);
  await app.close(); await app.close();
  assert.equal(fixture.calls.stops, 1); assert.equal(fixture.calls.closes, 1); assert.equal(fixture.calls.hubClosed, true);
});

test('default open redacts token, while failure prints one recovery URL and Herdr start is nonfatal', async () => {
  const fixture = composition({ argv: ['--project', '/project'], output: output(), browserLauncher: async (url) => { fixture.opened = url; } });
  fixture.options.parseOptions = () => ({ project: '/project', port: 4317, open: true, hodBin: '/exact/hod' });
  fixture.runtime.start = async () => { throw new Error('raw Herdr socket'); };
  const app = await startHodUi(fixture.options);
  assert.match(fixture.options.output.stdout[0], /^http:\/\/127\.0\.0\.1:4317$/);
  assert.equal(fixture.options.output.stdout[0].includes('token'), false);
  await app.close();

  const recovery = composition({ output: output(), browserLauncher: async () => { throw new Error('raw opener'); } });
  recovery.options.parseOptions = () => ({ project: '/project', port: 4317, open: true, hodBin: '/exact/hod' });
  const recoveryApp = await startHodUi(recovery.options);
  assert.match(recovery.options.output.stdout[0], /#token=/);
  assert.equal(recovery.options.output.stdout.length, 1);
  await recoveryApp.close();
});

test('main assigns stable CLI exit codes and signal handlers clean up without forced exit', async () => {
  const processRef = processFake(['--bad']); const outputRef = output();
  await main({ process: processRef, output: outputRef, argv: ['--bad'], parseOptions: () => { throw Object.assign(new Error('raw'), { code: 'ERR_USAGE' }); } });
  assert.equal(processRef.exitCode, 2); assert.equal(outputRef.stderr.length, 1); assert.equal(outputRef.stderr[0], 'Invalid HOD UI options');
  const fixture = composition(); fixture.options.process = processFake();
  const app = await startHodUi(fixture.options);
  fixture.options.process.listeners.get('SIGINT')();
  await app.close();
  assert.equal(fixture.options.process.listeners.size, 0); assert.equal(fixture.calls.stops, 1); assert.equal(fixture.calls.closes, 1);
});
