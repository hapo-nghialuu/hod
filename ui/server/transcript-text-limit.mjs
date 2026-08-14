export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const PANE_READ_SOURCE = 'recent';
const PANE_READ_FORMAT = 'ansi';

export class TranscriptWatcherError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TranscriptWatcherError';
    this.code = code;
  }
}

export function stableTranscriptError(error, fallback = 'ERR_TRANSCRIPT') {
  const raw = typeof error?.code === 'string' ? error.code : fallback;
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

export function validatePaneRead(response, paneId) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TranscriptWatcherError('ERR_PANE_READ_INVALID');
  }
  if (response.type !== undefined && response.type !== 'pane_read') {
    throw new TranscriptWatcherError('ERR_PANE_READ_INVALID');
  }
  const read = response.read ?? response;
  if (!read || typeof read !== 'object' || Array.isArray(read)
    || read.pane_id !== paneId || typeof read.text !== 'string') {
    throw new TranscriptWatcherError('ERR_PANE_READ_INVALID');
  }
  if (!Number.isSafeInteger(read.revision) || read.revision < 0) {
    throw new TranscriptWatcherError('ERR_PANE_READ_REVISION');
  }
  const validSource = read.source === undefined || read.source === PANE_READ_SOURCE;
  const validFormat = read.format === undefined || read.format === PANE_READ_FORMAT;
  if (typeof read.truncated !== 'boolean' || !validSource || !validFormat) {
    throw new TranscriptWatcherError('ERR_PANE_READ_INVALID');
  }
  return read;
}

export function closeTranscriptClient(client) {
  if (!client) return Promise.resolve();
  const method = typeof client.close === 'function' ? client.close
    : (typeof client.disconnect === 'function' ? client.disconnect : null);
  if (!method) return Promise.resolve();
  try {
    return Promise.resolve(method.call(client)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function isTranscriptTimeout(error) {
  return ['ERR_REQUEST_TIMEOUT', 'ERR_TIMEOUT', 'ETIMEDOUT'].includes(error?.code);
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Keep the newest complete UTF-8 characters without retaining the discarded head. */
export function limitTranscriptText(text, maxBytes = MAX_TRANSCRIPT_BYTES) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!validLimit(maxBytes)) throw new TypeError('maxBytes must be a positive safe integer');

  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return { text, bridgeTruncated: false };
  }

  const tail = bytes.subarray(bytes.byteLength - maxBytes);
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
  return {
    text: tail.subarray(start).toString('utf8'),
    bridgeTruncated: true,
  };
}
