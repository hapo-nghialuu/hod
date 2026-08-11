import { TextDecoder } from 'node:util';

export const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class NdjsonFrameError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'NdjsonFrameError';
    this.code = code;
  }
}

function frameError(code, message, cause) {
  return new NdjsonFrameError(code, message, cause ? { cause } : undefined);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifyEnvelope(value) {
  if (!isRecord(value)) throw frameError('ERR_PROTOCOL', 'Herdr envelope must be an object');
  if (!Object.hasOwn(value, 'id')) {
    if (typeof value.event !== 'string' || value.event.length === 0 || !Object.hasOwn(value, 'data')) {
      throw frameError('ERR_PROTOCOL', 'Invalid Herdr event envelope');
    }
    return 'event';
  }
  if (typeof value.id !== 'string') throw frameError('ERR_PROTOCOL', 'Herdr response id must be a string');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult === hasError) throw frameError('ERR_PROTOCOL', 'Invalid Herdr response envelope');
  if (hasError && !isRecord(value.error)) throw frameError('ERR_PROTOCOL', 'Herdr error must be an object');
  return hasResult ? 'success' : 'error';
}

export class NdjsonFrameDecoder {
  constructor(maxLineBytes = MAX_LINE_BYTES) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError('maxLineBytes must be a positive integer');
    }
    this.maxLineBytes = maxLineBytes;
    this._buffer = Buffer.alloc(0);
    this._decoder = new TextDecoder('utf-8', { fatal: true });
  }

  reset() {
    this._buffer = Buffer.alloc(0);
  }

  get hasPartialFrame() {
    return this._buffer.length > 0;
  }

  push(chunk) {
    const frames = [];
    let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (rest.length > 0) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) {
        this._appendPartial(rest);
        break;
      }
      const head = rest.subarray(0, newline);
      if (this._buffer.length + head.length > this.maxLineBytes) {
        throw frameError('ERR_LINE_TOO_LARGE', 'Herdr frame exceeds the line limit');
      }
      const line = this._buffer.length > 0 ? Buffer.concat([this._buffer, head]) : head;
      this._buffer = Buffer.alloc(0);
      rest = rest.subarray(newline + 1);
      frames.push(this._decodeLine(line));
    }
    return frames;
  }

  _appendPartial(bytes) {
    if (this._buffer.length + bytes.length > this.maxLineBytes) {
      throw frameError('ERR_LINE_TOO_LARGE', 'Herdr frame exceeds the line limit');
    }
    this._buffer = Buffer.concat([this._buffer, bytes]);
  }

  _decodeLine(line) {
    let value;
    try {
      value = JSON.parse(this._decoder.decode(line));
    } catch (error) {
      throw frameError('ERR_PROTOCOL', 'Invalid Herdr JSON frame', error);
    }
    return { kind: classifyEnvelope(value), value };
  }
}
