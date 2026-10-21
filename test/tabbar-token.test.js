'use strict';

// A pane's `tabbar` token is appended to the tab-bar line, so another plugin
// can show a segment without owning the tab_bar_right entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-tabbar-token-'));
process.env.HERDR_RADAR_STATE = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ipc = require('../lib/ipc');
const herdr = require('../lib/herdr');
const tabline = require('../lib/tabline');

const pane = (id, tokens, extra = {}) => ({ pane_id: id, tokens, ...extra });

test('tabbarExtras keeps non-empty tabbar tokens in pane-list order', () => {
  const panes = [
    pane('a', { tabbar: 'To-do 3' }),
    pane('b', { todo: '3' }),
    pane('c', { tabbar: '' }),
    pane('d', { tabbar: '   ' }),
    pane('e', undefined),
    pane('f', { tabbar: 7 }),
    pane('g', { tabbar: 'Build 2' }),
  ];
  assert.deepEqual(tabline.tabbarExtras(panes), ['To-do 3', 'Build 2']);
});

test('tabbarExtras strips control characters and caps the length', () => {
  const [text] = tabline.tabbarExtras([pane('a', { tabbar: `x\n\u001b[31my${'z'.repeat(60)}` })]);
  assert.equal(text.includes('\n'), false);
  assert.equal(text.includes('\u001b'), false);
  assert.ok(text.length <= 32);
});

test('compose appends the extras after the path and leaves the line alone without them', () => {
  const base = tabline.compose({ cwd: '/work/project', row: 200, tabs: 1 });
  assert.equal(tabline.compose({ cwd: '/work/project', row: 200, tabs: 1, extras: [] }), base);
  assert.equal(tabline.compose({ cwd: '/work/project', row: 200, tabs: 1, extras: ['To-do 3'] }), `${base} · To-do 3`);
});

test('compose leaves out extras that cannot fit next to the path', () => {
  const extras = ['a'.repeat(32), 'b'.repeat(32)];
  const line = tabline.compose({ cwd: '/work/project', row: 80, tabs: 1, extras });
  assert.equal(line, `/work/project · ${extras[0]}`);
  assert.ok(Array.from(line).length <= 80 - 24 - 5);
  assert.equal(
    tabline.compose({ cwd: '/work/project', row: 30, tabs: 1, extras }),
    tabline.compose({ cwd: '/work/project', row: 30, tabs: 1 }),
  );
});

test('tabbarExtras cuts at code points, not UTF-16 units', () => {
  const [text] = tabline.tabbarExtras([pane('a', { tabbar: `${'x'.repeat(31)}😀tail` })]);
  assert.equal(text, `${'x'.repeat(31)}😀`);
  assert.equal(text.includes('\ufffd'), false);
});

test('compose shortens the path so the extras still fit the row', () => {
  const cwd = `/srv/${'a'.repeat(30)}/${'b'.repeat(8)}`;
  const plain = tabline.compose({ cwd, row: 80, tabs: 1 });
  const withExtra = tabline.compose({ cwd, row: 80, tabs: 1, extras: ['To-do 12'] });
  assert.equal(plain, cwd);
  assert.ok(withExtra.endsWith(' · To-do 12'));
  assert.ok(withExtra.length - ' · To-do 12'.length < plain.length);
});

test('snapshotLine publishes the extras of the panes, and only the extras when nothing is focused', async (t) => {
  t.mock.method(herdr, 'panesAsync', async () => [pane('a', { tabbar: 'To-do 2' })]);
  t.mock.method(herdr, 'tabsAsync', async () => []);
  t.mock.method(ipc, 'call', async () => null);
  assert.equal(await tabline.snapshotLine(), 'To-do 2');

  herdr.panesAsync.mock.mockImplementation(async () => [pane('a', {}, { focused: true })]);
  assert.equal(await tabline.snapshotLine(), '');
});

test('snapshotLine puts the extras after the focused pane path', async (t) => {
  t.mock.method(herdr, 'panesAsync', async () => [
    pane('a', {}, { focused: true, workspace_id: 'w', cwd: '/work/project' }),
    pane('b', { tabbar: 'To-do 2' }),
  ]);
  t.mock.method(herdr, 'tabsAsync', async () => [{ workspace_id: 'w' }]);
  t.mock.method(ipc, 'call', async () => null);
  const line = await tabline.snapshotLine();
  assert.ok(line.endsWith(' · To-do 2'), line);
  assert.ok(line.length > ' · To-do 2'.length);
});
