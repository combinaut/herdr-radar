'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scrollTop } = require('../lib/scroll-window');
const {
  settingsSections,
  largestSectionSize,
  nextSection,
  sectionDirection,
  sectionWindow,
} = require('../lib/settings-sections');
const {
  FIELDS,
  SETTINGS_SECTIONS,
  MAX_SECTION_ROWS,
  POPUP_CONTENT_ROWS,
  keyHint,
  buttons,
  width,
  listWindow,
} = require('../bin/settings');

const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

test('the popup names the keys that save, reset and change a value', () => {
  for (const hint of [plain(keyHint(80)), plain(keyHint(40))]) {
    assert.match(hint, /\br reset\b/);
    assert.match(hint, /↵ (change|edit)/);
  }
  assert.match(plain(buttons(80)), /\bs save\b/);
  assert.doesNotMatch(plain(buttons(80)), /↵ apply/);
});

test('settings sections preserve the requested tab order and every field', () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.name),
    ['Panel', 'Agent state', 'Groups', 'Machines', 'Rows', 'Appearance'],
  );
  assert.equal(SETTINGS_SECTIONS.flatMap((section) => section.fields).length, FIELDS.length);
});

test('tab navigation wraps in both directions', () => {
  const sectionCount = 5;
  assert.equal(nextSection(sectionCount - 1, 1, sectionCount), 0);
  assert.equal(nextSection(0, -1, sectionCount), sectionCount - 1);
});

test('the popup height holds this fork’s largest tab without making a tall popup', () => {
  assert.equal(largestSectionSize(SETTINGS_SECTIONS), 9);
  assert.equal(MAX_SECTION_ROWS, 9);
  assert.equal(POPUP_CONTENT_ROWS, 19);
});

test('Tab, Shift+Tab, arrows, and h/l select adjacent sections', () => {
  assert.equal(sectionDirection('\t'), 1);
  assert.equal(sectionDirection('\x1b[C'), 1);
  assert.equal(sectionDirection('l'), 1);
  assert.equal(sectionDirection('\x1b[Z'), -1);
  assert.equal(sectionDirection('\x1b[D'), -1);
  assert.equal(sectionDirection('h'), -1);
});

test('a tab list scrolls only within its active section', () => {
  const fields = [{ key: 'one' }, { key: 'two' }, { key: 'three' }, { key: 'four' }];
  const visible = sectionWindow(fields, 3, 2, 0, scrollTop);
  assert.deepEqual(
    visible.fields.map((field) => field.key),
    ['three', 'four'],
  );
  assert.equal(visible.hiddenAbove, 2);
  assert.equal(visible.hiddenBelow, 0);
});

test('the popup list receives only the selected tab fields', () => {
  const rows = listWindow(SETTINGS_SECTIONS[2].fields, 8, 3, 0).fields;
  assert.deepEqual(
    rows.map((field) => field.key),
    ['split_corner', 'trim_group_prefix', 'worktree_mark'],
  );
});

test('the full section key hint fits an 84-column popup', () => {
  const hint = keyHint(82);
  assert.match(hint, /^↑↓ select {3}←→ section {3}\+ \/ - step/);
  assert.ok(width(hint) <= 82, `hint is ${width(hint)} columns`);
});

test('the short hint is shorter than the full hint', () => {
  const hint = keyHint(40);
  assert.match(hint, /^↑↓ select {2}←→ section {2}\+\/- step/);
  assert.ok(width(hint) < width(keyHint(82)));
});
