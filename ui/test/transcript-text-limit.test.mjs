import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TRANSCRIPT_BYTES,
  limitTranscriptText,
} from '../server/transcript-text-limit.mjs';

const byteLength = (value) => Buffer.byteLength(value, 'utf8');

test('keeps an exact 16 MiB UTF-8 tail and marks the discarded head', () => {
  const expected = '😀'.repeat(MAX_TRANSCRIPT_BYTES / 4);
  const result = limitTranscriptText(`x${expected}`);

  assert.equal(result.bridgeTruncated, true);
  assert.equal(byteLength(result.text), MAX_TRANSCRIPT_BYTES);
  assert.equal(result.text, expected);
  assert.equal(result.text.includes('\uFFFD'), false);
});

test('drops a partial leading UTF-8 sequence without corrupting the retained tail', () => {
  const expected = 'a'.repeat(MAX_TRANSCRIPT_BYTES - 1);
  const result = limitTranscriptText(`😀${expected}`);

  assert.equal(result.bridgeTruncated, true);
  assert.equal(byteLength(result.text), MAX_TRANSCRIPT_BYTES - 1);
  assert.equal(result.text, expected);
  assert.equal(result.text.includes('\uFFFD'), false);
});
