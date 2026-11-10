'use strict';

// How the settings popup writes a value back (bin/settings.js literal).
//
// A save rewrites every field the popup knows, not just the one changed. The
// reader (lib/config.js parseToml) strips the quotes and processes no
// escapes, so a free-text value holding `"` or `\` written between double
// quotes came back as a broken line: a hand-edited `machine_label =
// 'build "A"'` turned into `machine_label = "build "A""` when only
// `group_gap` was toggled. Every value written must read back as itself, and
// one with no such form must leave the line alone.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseToml } = require('../lib/config');
const { literal } = require('../bin/settings');

const ROUND_TRIP = [
  ['plain text', 'Machine-One'],
  ['an empty string', ''],
  ['a hex colour, which holds a #', '#ff8800'],
  ['double quotes', 'build "A"'],
  ['a backslash', 'build\\Q'],
  ['a single quote alone', "it's mine"],
  ['a number', 3],
  ['a boolean', false],
];

for (const [label, value] of ROUND_TRIP) {
  test(`${label} reads back as itself`, () => {
    const text = literal(value);
    assert.notEqual(text, null);
    assert.equal(parseToml(`key = ${text}\n`).key, value);
  });
}

test('a value with no form that reads back is left unwritten', () => {
  assert.equal(literal(`it's "x"`), null);
  assert.equal(literal("it's a\\b"), null);
  assert.equal(literal('two\nlines'), null);
});
