import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asciiOccupancy,
  asciiProgress,
  buildAgentViewModels,
  buildRuntimeTotals,
  buildSpaceViewModels,
  buildTabViewModels,
  filterAgents,
  progressPercent,
  sortAgents,
  statusTag,
} from '../public/modules/view-models.mjs';

const agents = [
  { paneId: 'idle-1', workspaceId: 'alpha', display: 'zulu', status: 'idle' },
  { paneId: 'done-1', workspaceId: 'alpha', display: 'done', status: 'done' },
  { paneId: 'working-1', workspaceId: 'beta', display: 'worker', status: 'working' },
  { paneId: 'blocked-1', workspaceId: 'alpha', display: 'blocked', status: 'blocked' },
  { paneId: 'mystery-1', workspaceId: 'alpha', display: 'mystery', status: 'strange' },
];

test('agents filter by workspace and sort by blocked, working, idle, done, unknown', () => {
  const original = agents.slice();
  const filtered = filterAgents(agents, 'alpha');
  assert.deepEqual(filtered.map((agent) => agent.paneId), ['idle-1', 'done-1', 'blocked-1', 'mystery-1']);
  const sorted = sortAgents(filtered);
  assert.deepEqual(sorted.map((agent) => agent.paneId), ['blocked-1', 'idle-1', 'done-1', 'mystery-1']);
  assert.deepEqual(agents, original);
});

test('view models include text status tags independent of color', () => {
  const models = buildAgentViewModels(agents);
  assert.deepEqual(models.map((agent) => agent.statusTag), ['[ERR]', '[WORK]', '[WAIT]', '[DONE]', '[UNKNOWN]']);
  assert.deepEqual(models.map((agent) => agent.id), ['blocked-1', 'working-1', 'idle-1', 'done-1', 'mystery-1']);
  assert.equal(statusTag({ status: 'running' }), '[WORK]');
  assert.equal(statusTag({ status: 'failed' }), '[ERR]');
  assert.equal(models[0].statusText, 'blocked');
  assert.equal(buildAgentViewModels([{ paneId: 'named', name: 'Zed', display: 'Claude' }])[0].displayName, 'Zed');
  assert.deepEqual(buildAgentViewModels([{ agentKind: 'codex' }, { agentKind: 'claude' }, { agentKind: 'grok' }, { name: 'claude-looking' }]).map(({ agentKind }) => agentKind), ['CODEX', 'CLAUDE CODE', 'GROK', 'UNKNOWN']);
});

test('same-status agents sort by display name and preserve duplicate-name order', () => {
  const sameStatus = [
    { paneId: 'z', display: 'zulu', status: 'working' },
    { paneId: 'a-second', display: 'alpha', status: 'working' },
    { paneId: 'a-first', display: 'alpha', status: 'working' },
  ];
  assert.deepEqual(sortAgents(sameStatus).map((agent) => agent.paneId), ['a-second', 'a-first', 'z']);
});

test('progress and occupancy helpers clamp invalid and out-of-range values', () => {
  assert.equal(progressPercent(-4, 10), 0);
  assert.equal(progressPercent(20, 10), 100);
  assert.equal(progressPercent(4, 0), 0);
  assert.equal(progressPercent(Number.NaN, 10), 0);
  assert.equal(asciiProgress(-4, 10, 4), '[....] 0%');
  assert.equal(asciiProgress(20, 10, 4), '[||||] 100%');
  assert.equal(asciiOccupancy(3, 10, 4), '[|...] 30%');
  assert.equal(asciiProgress(5, 10, 100).length, asciiProgress(5, 10, 80).length);
});

test('spaces keep ALL first, then urgent, active, and recently changed workspaces', () => {
  const spaces = buildSpaceViewModels({ workspaces: [
    { id: 'idle', number: 1, paneCount: 1, tabCount: 1, status: 'idle' },
    { id: 'working-old', number: 2, paneCount: 2, tabCount: 1, status: 'working' },
    { id: 'blocked', number: 3, paneCount: 3, tabCount: 2, status: 'blocked' },
    { id: 'working-new', number: 4, paneCount: 1, tabCount: 1, status: 'working' },
  ], agents: [
    { workspaceId: 'idle', stateChangeSeq: 90 }, { workspaceId: 'working-old', stateChangeSeq: 20 },
    { workspaceId: 'blocked', stateChangeSeq: 10 }, { workspaceId: 'working-new', stateChangeSeq: 80 },
  ] });
  assert.deepEqual(spaces.map((space) => space.id), [null, 'blocked', 'working-new', 'working-old', 'idle']);
  assert.deepEqual([spaces[0].paneCount, spaces[0].tabCount], [7, 5]);
  assert.equal(spaces[0].statusTag, '[ERR]');
  assert.equal(spaces[1].statusText, 'blocked');
});

test('runtime totals cover every space and all four agent statuses', () => {
  assert.deepEqual(buildRuntimeTotals({ workspaces: [{ id: 'one' }, { id: 'two' }], agents: [
    { status: 'working' }, { status: 'blocked' }, { status: 'idle' }, { status: 'done' },
  ] }), { spaces: 2, agents: 4, working: 1, blocked: 1, idle: 1, done: 1 });
});

test('tab view models retain every tab across spaces, including tabs with no agents', () => {
  const runtime = {
    workspaces: [{ id: 'space-1' }, { id: 'space-2' }],
    tabs: [
      { id: 'tab-2', workspaceId: 'space-2', number: 1, label: 'Second', paneCount: 1, status: 'idle' },
      { id: 'tab-empty', workspaceId: 'space-1', number: 2, label: 'No Agents', paneCount: 0, status: 'done' },
      { id: 'tab-1', workspaceId: 'space-1', number: 1, label: 'First', paneCount: 2, status: 'working' },
    ],
    agents: [{ paneId: 'pane-1', workspaceId: 'space-1', tabId: 'tab-1', status: 'working' }],
  };
  const tabs = buildTabViewModels(runtime);
  assert.deepEqual(tabs.map(({ id, label }) => ({ id, label })), [
    { id: 'tab-1', label: 'First' },
    { id: 'tab-empty', label: 'No Agents' },
    { id: 'tab-2', label: 'Second' },
  ]);
  assert.equal(tabs.find(({ id }) => id === 'tab-empty').paneCount, 0);
  assert.deepEqual(buildTabViewModels(runtime, 'space-2').map(({ id }) => id), ['tab-2']);
});
