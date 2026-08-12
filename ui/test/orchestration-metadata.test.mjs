import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOrchestrationMetadata,
  ORCHESTRATION_TOKEN_ALLOWLIST,
} from '../server/orchestration-metadata.mjs';

test('accepts the exact five-token HOD mapping and emits the stable contract', () => {
  assert.deepEqual(ORCHESTRATION_TOKEN_ALLOWLIST, [
    'hod_role', 'hod_parent', 'hod_relation', 'hod_task', 'hod_run',
  ]);
  assert.deepEqual(normalizeOrchestrationMetadata({
    hod_role: 'controller',
    hod_parent: 'pane-parent-1',
    hod_relation: 'delegate',
    hod_task: 'review-runtime-state',
    hod_run: 'run-1',
  }), {
    role: 'controller', parentPaneId: 'pane-parent-1', relation: 'delegate',
    task: 'review-runtime-state', runId: 'run-1',
  });
});

test('normalizes only exact role-relation pairs and keeps root controller relationless', () => {
  for (const [role, relation] of [
    ['controller', 'delegate'], ['worker', 'delegate'], ['advisor', 'consult'],
    ['reviewer', 'verify'], ['tester', 'verify'],
  ]) {
    assert.equal(normalizeOrchestrationMetadata({
      hod_role: role, hod_parent: 'parent-1', hod_relation: relation,
    }).relation, relation, `${role}/${relation}`);
  }
  for (const [role, relation] of [
    ['controller', 'consult'], ['worker', 'verify'], ['advisor', 'delegate'],
    ['reviewer', 'consult'], ['tester', 'delegate'],
  ]) {
    assert.equal(normalizeOrchestrationMetadata({
      hod_role: role, hod_parent: 'parent-1', hod_relation: relation,
    }).relation, null, `${role}/${relation}`);
  }
  assert.equal(normalizeOrchestrationMetadata({
    hod_role: 'controller', hod_relation: 'delegate',
  }), null);
  assert.deepEqual(normalizeOrchestrationMetadata({
    hod_role: 'controller',
  }), {
    role: 'controller', parentPaneId: null, relation: null, task: null, runId: null,
  });
});

test('rejects supplied structural tokens that collapse a controller into root', () => {
  for (const tokens of [
    { hod_role: 'controller', hod_relation: 'consult' },
    { hod_role: 'controller', hod_relation: 'delegate' },
    { hod_role: 'controller', hod_relation: 'not-a-relation' },
    { hod_role: 'controller', hod_parent: 'bad parent' },
    { hod_role: 'controller', hod_parent: 'bad parent', hod_relation: 'delegate' },
  ]) {
    const normalized = normalizeOrchestrationMetadata({ ...tokens, hod_task: 'task', hod_run: 'run-1' });
    assert.equal(normalized.role, null, JSON.stringify(tokens));
    assert.equal(normalized.parentPaneId, null, JSON.stringify(tokens));
    assert.equal(normalized.relation, null, JSON.stringify(tokens));
    assert.equal(normalized.task, 'task');
    assert.equal(normalized.runId, 'run-1');
  }
  assert.deepEqual(normalizeOrchestrationMetadata({
    hod_role: 'controller', hod_parent: 'parent-1', hod_relation: 'delegate',
  }), {
    role: 'controller', parentPaneId: 'parent-1', relation: 'delegate', task: null, runId: null,
  });
});

test('accepts only bounded task slugs and short run identifiers', () => {
  assert.deepEqual(normalizeOrchestrationMetadata({
    hod_task: `a${'b'.repeat(47)}`, hod_run: `r${'1'.repeat(63)}`,
  }), {
    role: null, parentPaneId: null, relation: null,
    task: `a${'b'.repeat(47)}`, runId: `r${'1'.repeat(63)}`,
  });
  for (const hod_task of ['Uppercase', 'has spaces', `a${'b'.repeat(48)}`]) {
    assert.equal(normalizeOrchestrationMetadata({ hod_task }), null);
  }
  assert.equal(normalizeOrchestrationMetadata({ hod_run: `r${'1'.repeat(64)}` }), null);
});

test('drops arbitrary token names and never returns their raw values', () => {
  const normalized = normalizeOrchestrationMetadata({
    hod_role: 'tester',
    hod_unlisted: 'raw secret',
    secret: { value: 'raw secret object' },
  });
  assert.deepEqual(normalized, {
    role: 'tester', parentPaneId: null, relation: null, task: null, runId: null,
  });
  assert.equal(JSON.stringify(normalized).includes('raw secret'), false);
  assert.equal(JSON.stringify(normalized).includes('hod_unlisted'), false);
});

test('does not consume a source-shaped sibling; provenance remains instrumentation-owned', () => {
  // The merged snapshot map has no source field. A source-shaped sibling is
  // intentionally ignored instead of becoming an invented runtime contract.
  assert.equal(normalizeOrchestrationMetadata({
    source: 'other',
    metadata: { hod_role: 'reviewer', hod_task: 'do not use' },
  }), null);
});

test('returns null or field-level nulls for malformed values without throwing', () => {
  assert.doesNotThrow(() => normalizeOrchestrationMetadata(null));
  assert.equal(normalizeOrchestrationMetadata(null), null);
  assert.equal(normalizeOrchestrationMetadata(['hod_role', 'worker']), null);
  assert.deepEqual(normalizeOrchestrationMetadata({
    hod_role: 'admin',
    hod_parent: 9,
    hod_relation: 'delegate-now',
    hod_task: 'bad\nvalue',
    hod_run: 'run with spaces',
  }), null);
});
