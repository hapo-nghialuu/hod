import { execFile as nodeExecFile } from 'node:child_process';

export const BROWSER_TIMEOUT_MS = 5_000;
export const BROWSER_OUTPUT_BYTES = 32 * 1024;
const COMMANDS = Object.freeze({ darwin: 'open', linux: 'xdg-open' });

export class BrowserLaunchError extends Error {
  constructor(code, message = 'Unable to open the browser') {
    super(message); this.name = 'BrowserLaunchError'; this.code = code;
  }
}

function commandFor(platform) {
  const command = COMMANDS[platform];
  if (!command) throw new BrowserLaunchError('ERR_UNSUPPORTED_PLATFORM', 'Browser opening is unsupported on this platform');
  return command;
}

function invoke(execFile, command, url, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => finish(reject, new BrowserLaunchError('ERR_BROWSER_TIMEOUT')), options.timeout);
    const callback = (error) => finish(error ? reject : resolve, error);
    try {
      const result = execFile(command, [url], options, callback);
      if (result?.then) result.then((value) => finish(resolve, value), (error) => finish(reject, error));
    } catch (error) { finish(reject, error); }
  });
}

/** Launch a URL using only the platform's argument-vector opener. */
export async function openBrowser(url, options = {}) {
  if (typeof url !== 'string' || url === '') throw new BrowserLaunchError('ERR_BROWSER_URL');
  const command = commandFor(options.platform ?? process.platform);
  const execFile = options.execFile ?? nodeExecFile;
  if (typeof execFile !== 'function') throw new BrowserLaunchError('ERR_BROWSER_CONFIG');
  const execOptions = {
    shell: false, timeout: options.timeoutMs ?? BROWSER_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? BROWSER_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true,
  };
  try { await invoke(execFile, command, url, execOptions); }
  catch (error) {
    if (error instanceof BrowserLaunchError) throw error;
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new BrowserLaunchError('ERR_BROWSER_OUTPUT_LIMIT', 'Browser opener output exceeded the limit');
    }
    throw new BrowserLaunchError('ERR_BROWSER_OPEN');
  }
  return { command, args: [url] };
}

export const launchBrowser = openBrowser;
