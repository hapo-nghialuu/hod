import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { parseRuntimeOptions } from './server/runtime-options.mjs';
import { resolveApplicationPaths, resolveRuntimeApplicationPaths } from './server/application-paths.mjs';
import { openBrowser } from './server/browser-launcher.mjs';
import { createLiveConsoleRuntime } from './server/live-console-runtime.mjs';
import { createGlobalObserverRuntime } from './server/global-observer-runtime.mjs';
import { createHttpServer } from './server/http-server.mjs';
import { SessionAuth } from './server/session-auth.mjs';

const ENTRY_FILE = fileURLToPath(import.meta.url);
const SAFE_MESSAGES = Object.freeze({
  ERR_USAGE: 'Invalid HOD UI options', ERR_HOD_BIN: 'HOD executable is unavailable',
  ERR_PROJECT_PATH: 'Project directory is unavailable', ERR_PUBLIC_ROOT: 'Public assets are unavailable',
  ERR_TEMPLATES_ROOT: 'Templates are unavailable', ERR_CONFIG_PATH: 'Herdr config path is invalid',
  ERR_UNSUPPORTED_PLATFORM: 'Browser opening is unsupported on this platform',
  ERR_STARTUP: 'HOD UI could not start',
});

class UiStartupError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] ?? SAFE_MESSAGES.ERR_STARTUP) {
    super(message); this.name = 'UiStartupError'; this.code = code;
  }
}

function safeCode(value, fallback = 'ERR_STARTUP') {
  return typeof value === 'string' && /^ERR_[A-Z0-9_]{1,63}$/.test(value) ? value : fallback;
}
function safeError(error, fallback = 'ERR_STARTUP') {
  if (error instanceof UiStartupError) return error;
  const code = safeCode(error?.code, fallback);
  return new UiStartupError(code, SAFE_MESSAGES[code] ?? SAFE_MESSAGES[fallback] ?? SAFE_MESSAGES.ERR_STARTUP);
}
function writeLine(output, stream, value) {
  const target = output?.[stream];
  if (typeof target?.write === 'function') { target.write(`${value}\n`); return; }
  if (Array.isArray(target)) { target.push(String(value)); return; }
  if (typeof output?.write === 'function' && stream === 'stdout') output.write(`${value}\n`);
}
function directEntry(argv = process.argv, entryFile = ENTRY_FILE) {
  const candidate = argv?.[1];
  if (typeof candidate !== 'string') return false;
  try { return realpathSync(candidate) === realpathSync(entryFile); } catch { return candidate === entryFile; }
}
function randomBootstrapToken(randomBytes) {
  let bytes;
  try { bytes = randomBytes(32); } catch { throw new UiStartupError('ERR_RANDOM'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new UiStartupError('ERR_RANDOM');
  return bytes.toString('base64url');
}
function originFrom(info, httpServer) {
  const port = info?.port ?? httpServer?.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UiStartupError('ERR_LISTEN');
  return `http://127.0.0.1:${port}`;
}
function settleCall(value) { return Promise.resolve().then(() => value?.()).catch(() => {}); }
function removeSignal(processRef, signal, handler) {
  const remove = processRef?.off ?? processRef?.removeListener;
  if (typeof remove === 'function') remove.call(processRef, signal, handler);
}

export function isDirectEntry(argv = process.argv, entryFile = ENTRY_FILE) { return directEntry(argv, entryFile); }

function runtimeOnlyPaths({ entryFile, env, herdrBin, hodBin }) {
  return resolveRuntimeApplicationPaths({ entryFile, env, herdrBin, hodBin });
}

export async function startHodUi(options = {}) {
  const processRef = options.process ?? process;
  const env = options.env ?? processRef.env ?? process.env;
  const argv = options.argv ?? processRef.argv?.slice(2) ?? [];
  let parsed;
  try { parsed = (options.parseOptions ?? parseRuntimeOptions)(argv, env); }
  catch (error) { throw safeError(error, 'ERR_USAGE'); }
  const runtimeOnly = parsed.runtimeOnly === true;
  const entryFile = options.entryFile ?? ENTRY_FILE;
  let paths;
  try {
    paths = runtimeOnly
      ? await (options.resolveRuntimePaths ?? runtimeOnlyPaths)({
        entryFile, env, herdrBin: options.herdrBin, hodBin: parsed.hodBin,
      })
      : await (options.resolvePaths ?? resolveApplicationPaths)({
        ...parsed, env, cwd: options.cwd ?? processRef.cwd?.() ?? process.cwd(),
        entryFile,
        directSourceInvocation: options.directSourceInvocation ?? directEntry(processRef.argv, entryFile),
        herdrBin: options.herdrBin,
      });
  } catch (error) { throw safeError(error); }
  if (!runtimeOnly && (typeof paths.hodBin !== 'string' || paths.hodBin === '')) {
    throw new UiStartupError('ERR_HOD_BIN');
  }
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const bootstrapToken = randomBootstrapToken(randomBytes);
  const runtimeFactory = runtimeOnly
    ? (options.createRuntimeOnly ?? createGlobalObserverRuntime)
    : (options.createRuntime ?? createLiveConsoleRuntime);
  const httpFactory = options.createHttpServer ?? createHttpServer;
  let runtime;
  let httpServer;
  let signals = [];
  try {
    runtime = options.runtime ?? (runtimeOnly
      ? runtimeFactory({
        runtimeOnly: true, env, herdrBin: paths.herdrBin, publicRoot: paths.publicRoot,
        ...(paths.templatesRoot ? { templatesRoot: paths.templatesRoot } : {}),
        ...(paths.configPath ? { configPath: paths.configPath } : {}),
        ...(paths.hodBin ? { hodBin: paths.hodBin } : {}),
      })
      : runtimeFactory({
        projectRoot: paths.projectRoot, templatesRoot: paths.templatesRoot, configPath: paths.configPath,
        hodBin: paths.hodBin, herdrBin: paths.herdrBin,
        hodRoleSettingsOptions: { projectRoot: paths.projectRoot, templatesRoot: paths.templatesRoot, hodBin: paths.hodBin },
        herdrConfigSettingsOptions: { configPath: paths.configPath, herdrBin: paths.herdrBin, env },
      }));
    const auth = options.sessionAuth ?? (options.createSessionAuth
      ? options.createSessionAuth({ bootstrapToken, randomBytes })
      : new SessionAuth({ bootstrapToken, randomBytes }));
    httpServer = httpFactory({ port: parsed.port, host: '127.0.0.1', publicRoot: paths.publicRoot,
      sessionAuth: auth, bootstrapToken, apiController: runtime.apiController ?? runtime.api,
      sseHub: runtime.sseHub ?? runtime.hub });
    const listen = httpServer?.listen ?? httpServer?.start;
    if (typeof listen !== 'function') throw new UiStartupError('ERR_LISTEN');
    const info = await listen.call(httpServer, parsed.port);
    const origin = originFrom(info, httpServer);
    const launchUrl = `${origin}/#token=${encodeURIComponent(bootstrapToken)}`;
    let closePromise;
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const [signal, handler] of signals) removeSignal(processRef, signal, handler);
        signals = [];
        await settleCall(runtime?.stop?.bind(runtime));
        await settleCall(httpServer?.close?.bind(httpServer));
        await settleCall((runtime?.sseHub ?? runtime?.hub ?? httpServer?.sseHub)?.close?.bind(runtime?.sseHub ?? runtime?.hub ?? httpServer?.sseHub));
      })();
      return closePromise;
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { void close().catch(() => {}); };
      processRef.on?.(signal, handler); signals.push([signal, handler]);
    }
    try { await runtime?.start?.(); } catch { /* Herdr is intentionally nonfatal at startup. */ }
    if (!parsed.open) writeLine(options.output ?? processRef, 'stdout', launchUrl);
    else {
      try {
        const launch = options.browserLauncher ?? options.openBrowser ?? ((url) => openBrowser(url, {
          platform: processRef.platform, execFile: options.execFile,
        }));
        await (typeof launch === 'function' ? launch(launchUrl) : launch.open(launchUrl));
        writeLine(options.output ?? processRef, 'stdout', origin);
      } catch { writeLine(options.output ?? processRef, 'stdout', launchUrl); }
    }
    return Object.freeze({ close, runtime, httpServer, paths, origin, launchUrl });
  } catch (error) {
    await settleCall(httpServer?.close?.bind(httpServer));
    await settleCall(runtime?.stop?.bind(runtime));
    throw safeError(error);
  }
}

export async function main(options = {}) {
  const processRef = options.process ?? process;
  try { return await startHodUi({ ...options, process: processRef }); }
  catch (error) {
    const safe = safeError(error, error?.code === 'ERR_USAGE' ? 'ERR_USAGE' : 'ERR_STARTUP');
    writeLine(options.output ?? processRef, 'stderr', safe.message);
    processRef.exitCode = safe.code === 'ERR_USAGE' ? 2 : 1;
    return null;
  }
}

if (directEntry()) void main();
