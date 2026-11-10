'use strict';

// The fork's grouping: `owner` tokens, git worktrees and the colour stripe,
// as writeGroups draws them.

const test = require('node:test');
const assert = require('node:assert/strict');

const herdr = require('../lib/herdr');
const state = require('../lib/state');

function record(t) {
  const sent = new Map();
  t.mock.method(herdr, 'reportMetadataAsync', async (pane, _source, tokens) => {
    sent.set(pane, { ...sent.get(pane), ...tokens });
    return true;
  });
  return sent;
}

// An orphan's repo name is the entry's first row and its header the second,
// which Herdr already hangs by two columns. Only the first row takes the lead.
test('an orphan header stripe lines up with the rows under it', async (t) => {
  const sent = record(t);
  const entries = [{ pane: 'wt:p1', workspace: 'wt' }];
  await state.writeGroups('test', entries, new Map([['wt', 'feature']]), new Set(), {
    orphanRepo: new Map([['wt', 'app']]),
    colorOf: new Map([['wt', 0]]),
  });
  const tokens = sent.get('wt:p1');
  assert.equal(tokens.band_parent, state.bandValue(0, '', { firstRow: true }), 'the repo row is a first row');
  assert.equal(tokens.band_head, state.bandValue(0, '', { firstRow: false }), 'the header is a continuation row');
});

// An `owner` outranks the repo, but only while the owner is on the list: an
// owner with no agents running leaves no header to hang from, so a linked
// worktree falls back to its repo the same way it would with no owner at all.
test('a worktree whose owner has no agents falls back to its repo', () => {
  const { Frame } = require('../lib/frame');
  const repo = (linked) => ({ repo_key: '/r/.git', repo_name: 'r', is_linked_worktree: linked });
  const workspaces = [
    { workspace_id: 'main', worktree: repo(false), tokens: {} },
    { workspace_id: 'lead', tokens: {} },
    { workspace_id: 'idle', tokens: {} },
    { workspace_id: 'led', worktree: repo(true), tokens: { owner: 'lead' } },
    { workspace_id: 'wt', worktree: repo(true), tokens: { owner: 'idle' } },
    { workspace_id: 'helper', tokens: { owner: 'idle' } },
  ];
  const { parents, worktrees, repoIds, repoParents } = state.worktreeParents(workspaces);
  const pane = (ws) => ({ pane: `${ws}:p1`, workspace: ws, tab: `${ws}:t1` });
  const keysFor = (names) => new Frame('test').sortKeys(names.map(pane), parents, worktrees, repoIds, repoParents);

  const all = keysFor(['main', 'lead', 'led', 'wt', 'helper']);
  assert.equal(all.parentOf.get('led'), 'lead', 'an owner with agents keeps its member');
  assert.equal(all.orphanRepo.has('led'), false, 'and that member is no orphan of its repo');
  assert.equal(all.parentOf.get('wt'), 'main', 'an owner with no agents hands the worktree to its repo');
  assert.equal(all.parentOf.has('helper'), false, 'a member that is no worktree has nothing to fall back to');
  assert.equal(all.orphanRepo.has('helper'), false, 'and gets no repo row');

  const noMain = keysFor(['wt']);
  assert.equal(noMain.orphanRepo.get('wt'), 'r', 'with the repo not listed either, the repo row stands in');
});

// The worktree mark says "a branch cut from this repo". A member grouped by its
// `owner` alone is no branch, so it hangs with a corner and no mark.
test('only a linked worktree carries the worktree mark', async (t) => {
  const config = require('../lib/config');
  const mark = config.worktreeMark;
  assert.ok(mark, 'the default config has a worktree mark');
  const sent = record(t);
  const names = ['lead', 'helper', 'wt', 'stray'];
  const entries = names.map((ws) => ({ pane: `${ws}:p1`, workspace: ws }));
  await state.writeGroups('test', entries, new Map(names.map((ws) => [ws, ws])), new Set(), {
    parentOf: new Map([
      ['helper', 'lead'],
      ['wt', 'lead'],
    ]),
    detached: new Set(['stray']),
    linked: new Set(['wt']),
  });
  const header = (ws) => sent.get(`${ws}:p1`).group;
  assert.ok(header('wt').includes(mark), 'a linked worktree keeps its mark');
  assert.ok(!header('helper').includes(mark), 'an owner member has none');
  assert.ok(!header('stray').includes(mark), 'nor has a detached one that is no worktree');
});

test('sortKeys lists the linked worktrees on the panel', () => {
  const { Frame } = require('../lib/frame');
  const pane = (ws) => ({ pane: `${ws}:p1`, workspace: ws, tab: `${ws}:t1` });
  const worktrees = new Map([
    ['wt', 'r'],
    ['gone', 'r'],
  ]);
  const keys = new Frame('test').sortKeys(['main', 'wt', 'helper'].map(pane), new Map(), worktrees);
  assert.deepEqual([...keys.linked], ['wt']);
});

// Orphans of one repo are one family under one repo row. The colour follows the
// family, and only the run's head draws the repo row: a stripe on the joined
// sibling's empty repo row would keep that row open, and its header is then its
// first row, so that stripe takes the lead.
test('orphans of one repo share a colour and one repo row', async (t) => {
  const config = require('../lib/config');
  const activity = require('../lib/activity');
  const view = require('../lib/view');
  const { Frame } = require('../lib/frame');
  const previous = { groupColors: config.groupColors, groupHeaders: config.groupHeaders };
  config.groupColors = true;
  config.groupHeaders = true;
  t.after(() => Object.assign(config, previous));

  const order = ['feature', 'hotfix', 'other'];
  const list = order.map((ws, index) => ({
    pane: `${ws}:p1`,
    terminal: `t${index}`,
    workspace: ws,
    tab: `${ws}:t1`,
    name: 'claude',
    title: 'x',
    status: 'idle',
  }));
  t.mock.method(state, 'snapshot', async () => list);
  t.mock.method(state, 'labels', async () => ({
    tabs: new Map(),
    workspaces: new Map(order.map((ws) => [ws, ws])),
    parents: new Map(),
    worktrees: new Map([
      ['feature', 'app'],
      ['hotfix', 'app'],
    ]),
    repoIds: new Map([
      ['feature', 'repo:one'],
      ['hotfix', 'repo:one'],
    ]),
  }));
  t.mock.method(view, 'mode', () => null);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(herdr, 'panesAsync', async () => []);
  t.mock.method(herdr, 'workspacesAsync', async () => []);
  t.mock.method(activity, 'load', () => new Map());
  t.mock.method(activity, 'save', () => {});
  t.mock.method(activity, 'recover', () => null);
  const sent = record(t);

  await new Frame('test').render(10_000_000);
  const tokens = (ws) => sent.get(`${ws}:p1`);
  const slotOf = (ws) => state.GROUP_COLOR_TOKENS.findIndex((token) => tokens(ws)?.[token]);
  assert.notEqual(slotOf('feature'), -1, 'the first orphan header is coloured');
  assert.equal(slotOf('hotfix'), slotOf('feature'), 'its sibling wears the same colour');
  assert.notEqual(slotOf('other'), slotOf('feature'), 'an unrelated project keeps its own');
  assert.equal(tokens('feature').group_parent, 'app', 'the head draws the repo row');
  assert.equal(tokens('feature').band_parent, state.bandValue(slotOf('feature'), '', { firstRow: true }));
  assert.equal(tokens('hotfix').group_parent, null, 'the sibling joins it');
  assert.equal(tokens('hotfix').band_parent, null, 'and draws no stripe on a repo row of its own');
  assert.equal(
    tokens('hotfix').band_head,
    state.bandValue(slotOf('hotfix'), '', { firstRow: true }),
    'its header is its first row',
  );
});

test('with headers off, no gap opens between orphans of one repo', async (t) => {
  const sent = record(t);
  const entries = ['feature', 'hotfix', 'other', 'last'].map((ws) => ({ pane: `${ws}:p1`, workspace: ws }));
  await state.writeGaps(
    'test',
    entries,
    new Map(),
    new Map([
      ['feature', 'repo:one'],
      ['hotfix', 'repo:one'],
    ]),
  );
  assert.equal(sent.get('feature:p1').gap, null, 'no gap inside the family');
  assert.equal(sent.get('hotfix:p1').gap, '​', 'a gap closes it');
});
