const ROLE_VALUES = new Set(['controller', 'worker', 'advisor', 'reviewer', 'tester']);
const RELATION_VALUES = new Set(['delegate', 'consult', 'verify']);
const ROLE_RELATIONS = Object.freeze({ controller: 'delegate', worker: 'delegate', advisor: 'consult', reviewer: 'verify', tester: 'verify' });

const MAX_PARENT_PANE_ID_LENGTH = 256;
const MAX_TASK_LENGTH = 48;
const MAX_RUN_ID_LENGTH = 64;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:%+-]{0,255}$/u;
const SAFE_TASK = /^[a-z0-9][a-z0-9._-]{0,47}$/u;

// Herdr session.snapshot merges agent.tokens and omits provenance. The
// instrumentation contract guarantees this map is HOD-owned; this boundary
// therefore does not invent or inspect a source field. It only accepts the
// exact keys below and emits a new, bounded public object.
const TOKEN_FIELDS = Object.freeze([
  ['hod_role', 'role'],
  ['hod_parent', 'parentPaneId'],
  ['hod_relation', 'relation'],
  ['hod_task', 'task'],
  ['hod_run', 'runId'],
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maxLength, pattern) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || !pattern.test(normalized)) return null;
  return normalized;
}

function enumValue(value, allowed) {
  return typeof value === 'string' && allowed.has(value.trim()) ? value.trim() : null;
}

function tokenValue(tokens, name) {
  return Object.hasOwn(tokens, name) ? tokens[name] : undefined;
}

function normalizeRelation(role, parentPaneId, relation) {
  if (role === 'controller' && parentPaneId === null) return null;
  return ROLE_RELATIONS[role] === relation ? relation : null;
}

/**
 * Normalize only the instrumentation-provided display metadata map.
 * Unknown token names and malformed values never cross the UI boundary.
 */
export function normalizeOrchestrationMetadata(tokens) {
  if (!record(tokens)) return null;

  const role = enumValue(tokenValue(tokens, 'hod_role'), ROLE_VALUES);
  const hasParentToken = Object.hasOwn(tokens, 'hod_parent');
  const hasRelationToken = Object.hasOwn(tokens, 'hod_relation');
  const parentPaneId = boundedString(tokenValue(tokens, 'hod_parent'), MAX_PARENT_PANE_ID_LENGTH, SAFE_ID);
  const relation = enumValue(tokenValue(tokens, 'hod_relation'), RELATION_VALUES);
  const normalizedRelation = normalizeRelation(role, parentPaneId, relation);
  const malformedRootController = role === 'controller'
    && parentPaneId === null && normalizedRelation === null
    && (hasParentToken || hasRelationToken);
  const orchestration = {
    role: malformedRootController ? null : role,
    parentPaneId,
    relation: normalizedRelation,
    task: boundedString(tokenValue(tokens, 'hod_task'), MAX_TASK_LENGTH, SAFE_TASK),
    runId: boundedString(tokenValue(tokens, 'hod_run'), MAX_RUN_ID_LENGTH, SAFE_ID),
  };

  return Object.values(orchestration).some((value) => value !== null) ? orchestration : null;
}

export const ORCHESTRATION_TOKEN_ALLOWLIST = Object.freeze(TOKEN_FIELDS.map(([name]) => name));
