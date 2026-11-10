#!/usr/bin/env node
'use strict';

// `npm run check`: invariants — the things in this repository that have to
// agree with each other and drifted apart once. The declaration files and
// lib/identity.js, the vendor roster across six places, the ranges the READMEs
// print and the ranges the installer maps, every script parsing. Each is read
// straight off the source, synchronously, and needs nothing set up.
//
// Behaviour belongs in test/ instead (`npm test`, Node's built-in runner, so
// still no dependency): anything that has to replace a module's function, run
// async, or leave a process in a known state afterwards. It lived here for a
// while and the file grew a promise chain to end on; that is the sign.
//
// Both are proved able to fail by tools/prove-checks.js.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = require('../lib/identity').verify(root);
for (const dir of ['bin', 'lib']) {
  for (const file of fs.readdirSync(path.join(root, dir))) {
    if (!file.endsWith('.js')) continue;
    try {
      execFileSync(process.execPath, ['--check', path.join(root, dir, file)], { stdio: 'pipe' });
    } catch (error) {
      problems.push(`${dir}/${file}: ${String(error.stderr).trim().split('\n')[0]}`);
    }
  }
}
// The tab-bar block's poll interval has to stay above its timeout. Inverted, a
// slow tick is still running when the next one starts, and on Windows every tick
// is a fresh `cmd.exe`: the overlap compounds until the machine stops
// responding. That happened. It is two numbers on one generated line — exactly
// the pair that drifts — so read them back out of the text that gets written.
const tabBar = require('../lib/managed-config').block();
const timings = /interval_seconds = (\d+), timeout_seconds = (\d+)/.exec(tabBar);
if (!timings) {
  problems.push('tab-bar block: no longer states an interval and a timeout');
} else if (Number(timings[1]) <= Number(timings[2])) {
  problems.push(
    `tab-bar block: interval_seconds (${timings[1]}) must be greater than timeout_seconds ` +
      `(${timings[2]}); overlapping ticks pile up processes`,
  );
}

// Nothing we write into a terminal's config may set that terminal's primary
// font. Our font holds icons and nothing else, so claiming the primary slot
// sends every ordinary character to a font that cannot draw it and the terminal
// falls back to something the user never picked. Ghostty's `font-family` and
// kitty's `font_family` both do exactly that; only the per-codepoint
// redirections belong in the block. Reported in #4.
const claimsPrimaryFont = /^\s*(font-family|font_family)[\s=]/;
for (const terminal of require('../lib/font').TERMINALS) {
  const line = terminal.lines.find((text) => claimsPrimaryFont.test(text));
  if (line) {
    problems.push(
      `${terminal.name} block: sets the terminal's primary font (${line.trim()}); ` +
        'map our codepoints instead, our font has only icons',
    );
  }
}

// Nor may it quote the family name: terminals read the name literally, so the quotes become part of it,
// nothing matches, and the codepoints fall through to whatever else claims the range (in the PUA, a CJK font).
const family = require('../lib/font').FONT_FAMILY;
// Whitespace inside the quotes is still a quoted name, just a worse one.
const quotesFamily = new RegExp(`["']\\s*${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*["']`);
for (const terminal of require('../lib/font').TERMINALS) {
  const line = terminal.lines.find((text) => quotesFamily.test(text));
  if (line) {
    problems.push(
      `${terminal.name} block: quotes the font family (${line.trim()}); ` +
        'the quotes become part of the name the terminal looks for',
    );
  }
}

// Every colour the sidebar writes has to stay readable on the panel behind it.
//
// Herdr's themes all set `sidebar_bg: Color::Reset`, so the panel is whatever
// the host terminal paints and no value here can know it. The reference panels
// below stand in for it: two real ones this was measured against. They are a
// backstop, not a target — the shipped values clear the floor with room to
// spare, and the point is that a future edit cannot quietly drop below it.
//
// This exists because a value did. `idleStale` was #585a64, which is 2.6:1 on
// a dark panel and capped at 3.06:1 against any background at all, and every
// cell wearing it also asked for the terminal's `dim` — a switch, not a value,
// answered with a third of the way to the background by one terminal and half
// by another. It rendered at 1.8:1 and 1.5:1: present, drawn, unreadable.
// Nothing checked. Reported in #5.
const PANELS = { light: '#eff1f5', dark: '#191724' };
// WCAG's large/bold threshold. Sidebar labels are short and mostly bold; the
// floor is here to catch inks that cannot be read at all, not to force body
// text ratios onto a tier whose job is to recede.
const CONTRAST_FLOOR = 3;

const channel = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Marks, not prose. A vendor's logo is a shape first: coral at 2.8:1 still
// reads as that glyph in that colour, and the Spaces list's "no agent" dot is
// a dot. The floor is about text that cannot be read, so it is scored against
// the inks that carry text and not against these. (Several of the brand values
// are below 3:1 on a light panel, which the palette's own comment claims they
// clear — true of the table as a whole against a darker light panel than the
// reference here, and worth its own look, but not this check's business.)
const palette = require('../lib/palette');
const markColours = new Set([...Object.values(palette.brand), palette.state.none]);

const managed = require('../lib/managed-config');
for (const [variant, panel] of Object.entries(PANELS)) {
  const text = managed.sidebarBlock(variant);
  // `dim` asks the terminal to fade an ink by an amount it chooses and we
  // cannot measure. Whatever fade a cell needs belongs in its colour.
  if (/dim = true/.test(text)) {
    problems.push(`sidebar block (${variant}): asks for the terminal's dim; put the fade in the colour`);
  }
  for (const colour of new Set(text.match(/#[0-9a-f]{6}/g) ?? [])) {
    if (markColours.has(colour)) continue;
    const ratio = contrast(colour, panel);
    if (ratio < CONTRAST_FLOOR) {
      problems.push(
        `sidebar block (${variant}): ${colour} is ${ratio.toFixed(2)}:1 on ${panel}, ` +
          `under the ${CONTRAST_FLOOR}:1 floor`,
      );
    }
  }
}

// Every glyph the font defines has to fall inside a range the installer maps.
//
// The terminal only looks in our font for the codepoints we tell it about, so a
// glyph outside those ranges is drawn from whatever the terminal had — which is
// nothing, silently, while install-font reports success. Adding the 24th vendor
// at E1B7 did exactly that: one past the end of a range written down by hand.
// Read the codepoints back out of the source of truth rather than trusting two
// places to agree.
const codepointsToml = fs.readFileSync(path.join(root, 'tools', 'codepoints.toml'), 'utf8');
const glyphSection = codepointsToml.split(/^\[fit\]/m)[0];
const declared = [...glyphSection.matchAll(/^([a-z_][a-z0-9_]*)\s*=\s*"([0-9A-Fa-f]{4})"/gm)].map(([, name, hex]) => ({
  name,
  point: parseInt(hex, 16),
}));
if (declared.length === 0) {
  problems.push('codepoints.toml: no glyph assignments found — did the file move?');
}
const { RANGES } = require('../lib/font');
const mapped = RANGES.map(([lo, hi]) => [parseInt(lo, 16), parseInt(hi, 16)]);
for (const { name, point } of declared) {
  if (!mapped.some(([lo, hi]) => point >= lo && point <= hi)) {
    problems.push(
      `codepoints.toml: ${name} at U+${point.toString(16).toUpperCase()} is outside every ` +
        'range install-font maps, so the terminal will never look for it',
    );
  }
}

// Adding a vendor means touching six places, and missing one is silent.
//
// A vendor needs a codepoint, a glyph, a mark to build it from, a PUA entry, a
// text fallback, a display name, and a line in the third-party notices. Nothing
// held those together, and three of them drifted: `amp`, `devin` and `qodercli`
// went five releases with their marks drawn and their sources uncredited, which
// is the one kind of drift here that is not merely cosmetic. The display name
// for `omp` said OhMyPosh — a prompt theme engine — while the notices had
// credited oh-my-pi correctly all along (#12).
//
// The notices are the only place a human must write prose, so this cannot check
// that the words are right; it checks that no vendor is missing from any of the
// lists, which is what went wrong each time.
const logos = require('../lib/logos');
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const vendorKeys = {
  'logos.js PUA': Object.keys(logos.PUA),
  'logos.js TEXT': Object.keys(logos.TEXT),
  'logos.js DISPLAY': Object.keys(logos.DISPLAY),
  // `declared` is already every key assigned a codepoint, which leaves out the
  // file's `family` and `version` lines. The state glyphs share the file but
  // are not vendors.
  'codepoints.toml': declared.map(({ name }) => name).filter((name) => !name.startsWith('state_')),
  'assets/marks': fs
    .readdirSync(path.join(root, 'assets', 'marks'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.slice(0, -'.svg'.length)),
  // Padding around the cell is legal Markdown and would otherwise read as a
  // missing vendor — a false alarm on a row that is perfectly correct.
  'THIRD_PARTY_NOTICES.md': [...notices.matchAll(/^\|\s*([a-z][a-z0-9_]*)\s*\|/gm)].map(([, key]) => key),
};
const everyVendor = new Set(Object.values(vendorKeys).flat());
for (const [where, keys] of Object.entries(vendorKeys)) {
  const held = new Set(keys);
  for (const vendor of everyVendor) {
    if (!held.has(vendor)) problems.push(`${where}: no entry for '${vendor}', which every other list has`);
  }
}
// tools/svg/ is allowed the state glyphs on top of the vendors, so it is
// checked one way only: a mark with nothing pointing at it is dead weight, but
// a vendor with no mark cannot be built at all.
const sources = fs
  .readdirSync(path.join(root, 'tools', 'svg'))
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -'.svg'.length));
for (const vendor of everyVendor) {
  if (!sources.includes(vendor)) problems.push(`tools/svg: no ${vendor}.svg to build that vendor's glyph from`);
}
// Counts written out in prose go stale the moment a vendor is added, and three
// of them had: the notices claimed 29 glyphs against 30, and all three READMEs
// still said twenty-three vendors after the 24th landed. Each is spelled for
// its own language, so the pattern is per file rather than one shared regex.
const vendorCount = Object.keys(logos.PUA).length;
const counted = [
  ['THIRD_PARTY_NOTICES.md', notices, /(\d+) icon glyphs/, declared.length, 'glyphs the font is built from'],
  ['README.md', null, /(Twenty-\w+) vendors have a mark/, vendorCount, 'vendors with a mark'],
  [
    'README.zh-CN.md',
    null,
    /([\u4e00-\u9fff]+)\u5bb6\u6709\u81ea\u5df1\u7684\u6807\u8bb0/,
    vendorCount,
    'vendors with a mark',
  ],
  [
    'README.ja.md',
    null,
    /(\d+) \u306e\u30d9\u30f3\u30c0\u30fc\u304c\u72ec\u81ea\u306e\u30de\u30fc\u30af/,
    vendorCount,
    'vendors with a mark',
  ],
];
// Spelled-out numerals, only as far as this project can plausibly grow.
const WORDS = [
  'Twenty-one',
  'Twenty-two',
  'Twenty-three',
  'Twenty-four',
  'Twenty-five',
  'Twenty-six',
  'Twenty-seven',
  'Twenty-eight',
  'Twenty-nine',
  'Thirty',
];
const CJK = [
  '\u4e8c\u5341\u4e00',
  '\u4e8c\u5341\u4e8c',
  '\u4e8c\u5341\u4e09',
  '\u4e8c\u5341\u56db',
  '\u4e8c\u5341\u4e94',
  '\u4e8c\u5341\u516d',
  '\u4e8c\u5341\u4e03',
  '\u4e8c\u5341\u516b',
  '\u4e8c\u5341\u4e5d',
  '\u4e09\u5341',
];
const asNumber = (text) => {
  if (/^\d+$/.test(text)) return Number(text);
  const word = WORDS.indexOf(text);
  if (word !== -1) return 21 + word;
  const cjk = CJK.indexOf(text);
  return cjk === -1 ? NaN : 21 + cjk;
};
for (const [file, preloaded, pattern, want, what] of counted) {
  const text = preloaded ?? fs.readFileSync(path.join(root, file), 'utf8');
  const found = pattern.exec(text);
  if (!found) {
    problems.push(`${file}: no longer states how many ${what} there are, or says it differently`);
  } else if (asNumber(found[1]) !== want) {
    problems.push(`${file}: says ${found[1]} where there are ${want} ${what}`);
  }
}

// Every display a pane can carry has to reach the Spaces column, and has to
// land on a token that exists.
//
// Two lists and a mapping have to agree: STATES is what a pane's display can
// be, SPACE_PRIORITY is which of them a workspace's single mark speaks for, and
// spaceToken() names the cell it publishes under. When idle was split into
// three tiers only the first list was updated, so a workspace of fresh or stale
// agents matched nothing and drew the no-agent dot (#11). The second failure is
// quieter still: writeSpaceState nulls every token it does not match, so a name
// outside SPACE_TOKENS does not mis-draw one cell, it clears every state mark on
// the row at once. (The logos and the label survive it — they are written after,
// from a separate object — so the row goes nameless rather than vanishing.)
const state = require('../lib/state');
const spaceTokens = new Set(state.SPACE_TOKENS);
for (const display of state.STATES) {
  if (!state.SPACE_PRIORITY.includes(display)) {
    problems.push(`SPACE_PRIORITY: no entry for '${display}', so a workspace holding only those agents reads as empty`);
  }
  // Vendor only matters for `working`; an unbranded one must still land.
  for (const vendor of [...palette.brandVendors, 'nosuchvendor']) {
    const token = state.spaceToken(display, vendor);
    if (!spaceTokens.has(token)) {
      problems.push(
        `spaceToken('${display}', '${vendor}') is '${token}', which is not in SPACE_TOKENS — ` +
          'it clears every state mark on the row',
      );
    }
  }
}
for (const display of state.SPACE_PRIORITY) {
  if (!state.STATES.includes(display)) {
    problems.push(`SPACE_PRIORITY: '${display}' is not a display any pane can carry`);
  }
}
// A token with no cell in the sidebar block is a mark that never draws.
//
// Matched with the closing quote the generated cell carries, not as a bare
// substring: `$space_idle` occurs inside `$space_idle_fresh`, so a cell renamed
// to something that merely starts with the published name would have satisfied
// a substring test while the name actually published had no cell left.
for (const variant of ['light', 'dark']) {
  const block = managed.sidebarBlock(variant);
  for (const token of state.SPACE_TOKENS) {
    if (!block.includes(`token = "$${token}"`)) {
      problems.push(`sidebar block (${variant}): no cell for $${token}, so that mark never draws`);
    }
  }
}

// A leader uses the same title token as its peers, marked invisibly in the
// value. That costs no row slot; each state-coloured title cell adds only a
// bold rule, so its own foreground colour still wins.
{
  const title = 'Keep this title readable';
  const line = { band: null, mark: '·', split: '', logo: '', titlePrefix: '' };
  for (const display of state.STATES) {
    const leader = state.stateTokens(display, line, title, true)[`title_${display}`];
    const member = state.stateTokens(display, line, title, false)[`title_${display}`];
    if (leader !== `${state.LEADER_MARK}${title}`) {
      problems.push(`leader title (${display}): missing the invisible bold marker`);
    }
    if (member !== title) {
      problems.push(`member title (${display}): unexpectedly carries the leader bold marker`);
    }
  }
  for (const variant of ['light', 'dark']) {
    const block = managed.sidebarBlock(variant);
    for (let slot = 0; slot < palette.groupColors.length; slot += 1) {
      const mark = '\\u2060'.repeat(slot + 1);
      if (!block.includes(`contains = "${mark}"`)) {
        problems.push(`sidebar block (${variant}): band slot ${slot + 1} is not coloured by its mark`);
      }
    }
    if (block.includes(`contains = "${palette.band.bar}`)) {
      problems.push(`sidebar block (${variant}): band colour depends on the half-block character`);
    }
    for (const display of state.STATES) {
      const titleCell = new RegExp(
        `token = "\\$title_${display}", fg = "([^"]+)", bold = (true|false), dim = (true|false), ` +
          'rules = \\[{ contains = "\\\\u2063", bold = true }\\]',
      );
      if (!titleCell.test(block)) {
        problems.push(`sidebar block (${variant}): $title_${display} has no bold-only leader rule`);
      }
    }
  }
}

// Herdr's sidebar limits apply to generated text, not our intentions. Count
// both kinds directly from the generated block: nested rules stay inside their
// cell, while rows are counted at their outer bracket depth.
function generatedRows(block) {
  const start = block.indexOf('rows = [');
  if (start < 0) return [];
  const bodyStart = block.indexOf('[', start);
  let depth = 0;
  for (let index = bodyStart; index < block.length; index += 1) {
    if (block[index] === '[') depth += 1;
    if (block[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        const body = block.slice(bodyStart, index + 1);
        const rows = [];
        let rowDepth = 0;
        let rowStart = 0;
        for (let offset = 0; offset < body.length; offset += 1) {
          if (body[offset] === '[') {
            if (rowDepth === 1) rowStart = offset;
            rowDepth += 1;
          } else if (body[offset] === ']') {
            rowDepth -= 1;
            if (rowDepth === 1) rows.push(body.slice(rowStart, offset + 1));
          }
        }
        return rows;
      }
    }
  }
  return [];
}
for (const variant of ['light', 'dark']) {
  const block = managed.sidebarBlock(variant);
  for (const row of generatedRows(block)) {
    const tokens = (row.match(/token = "/g) ?? []).length + (row.match(/(?<![:=] )"\$\w+"/g) ?? []).length;
    if (tokens > 16) problems.push(`sidebar block (${variant}): row has ${tokens} tokens, over Herdr's 16-token limit`);
    for (const rules of row.matchAll(/rules = \[([^\]]*)\]/g)) {
      const count = (rules[1].match(/\{ contains = /g) ?? []).length;
      if (count > 16) problems.push(`sidebar block (${variant}): cell has ${count} rules, over Herdr's 16-rule limit`);
    }
  }
}

// The highest role is a setting, not a magic token: the default gives it a
// distinct rank and an empty value turns only that rank off. It must also be
// reachable from the settings popup and described beside leader_role.
{
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const readRoles = (toml) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-config-'));
    fs.writeFileSync(path.join(dir, 'config.toml'), toml);
    const out = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(JSON.stringify(require('./lib/config').coordinatorRole))"],
      { cwd: root, env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir }, encoding: 'utf8' },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    return out.stdout;
  };
  for (const [toml, expected] of [
    ['', '"coordinator"'],
    ['coordinator_role = "director"\n', '"director"'],
    ['coordinator_role = ""\n', '""'],
  ]) {
    const got = readRoles(toml);
    if (got !== expected)
      problems.push(`config: ${JSON.stringify(toml)} reads coordinator_role as ${got}, expected ${expected}`);
  }
  const settings = fs.readFileSync(path.join(root, 'bin', 'settings.js'), 'utf8');
  if (!settings.includes("key: 'coordinator_role'"))
    problems.push('settings: coordinator_role is not editable in the popup');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  if (!readme.includes('| `coordinator_role` | `coordinator` |')) {
    problems.push('README: coordinator_role is missing beside leader_role');
  }
  if (!readme.includes('Workers use `▎`; leaders and coordinators use `█`')) {
    problems.push('README: coordinator stripe glyph is missing or incorrectly named');
  }
}

// A vendor this plugin can name never goes nameless.
//
// The row is `logo · title`. When the title says nothing the vendor's name
// takes its place, and the one case that was missed is the one that happens
// most: a pane with no title at all. `locationOnly()` answers false for an
// empty string — it is asking "is this title only a location", and an absent
// title is not — so the fallback never ran and Antigravity and codex rows drew
// a logo with nothing beside it (#10). The same hole swallowed a title that was
// nothing but the attention bracket, which strips to empty here.
//
// Stated as the property the row actually needs, and run against the real pair
// of functions, since copying the stripping regex into this file would only
// move the drift somewhere else.
const { DISPLAY } = logos;
const CWD = '/home/u/src/notes';
const blank = (value) => typeof value !== 'string' || value.trim() === '';
// Titles that say nothing about which agent this is. The last two arrive
// non-empty and are emptied by the strip, which is why it runs for real.
const SAYS_NOTHING = ['', '   ', '\t\r\n ', CWD, '  ' + CWD + '  ', 'notes', CWD + ': agy', '[!]', '[ · ] '];
// Not reachable from the call site, which only ever passes a string, but the
// function is exported now and a caller that hands it nothing should still get
// a name rather than a crash or a blank.
const NOT_A_STRING = [null, undefined, 0, {}];
for (const [agent, display] of Object.entries(DISPLAY)) {
  if (!display) continue;
  for (const raw of SAYS_NOTHING) {
    // A bare folder name is a leftover shell title only for an agent that
    // writes none of its own; the other half is checked below (#66).
    if (raw === 'notes' && state.WRITES_OWN_TITLE.has(agent)) continue;
    const resolved = state.vendorTitle(agent, state.stripVendorPulse(raw), CWD);
    if (resolved !== display) {
      problems.push(
        `vendorTitle(${JSON.stringify(agent)}, ${JSON.stringify(raw)}) is ${JSON.stringify(resolved)}, ` +
          `not ${JSON.stringify(display)} — that row draws a logo with no name beside it`,
      );
    }
  }
  for (const raw of NOT_A_STRING) {
    if (blank(state.vendorTitle(agent, raw, CWD))) {
      problems.push(`vendorTitle(${JSON.stringify(agent)}, ${String(raw)}) is blank; it should still name the vendor`);
    }
  }
}
// And the other half: a title that does say something keeps its words. Without
// this, "always return the vendor name" would satisfy everything above.
for (const [raw, want] of [
  ['Fixing the parser', 'Fixing the parser'],
  ['  Fixing the parser  ', 'Fixing the parser'],
  ['Fixing  the  parser', 'Fixing  the  parser'],
  ['[!] Fixing the parser', 'Fixing the parser'],
  ['notes: a real title', 'notes: a real title'],
]) {
  const resolved = state.vendorTitle('claude', state.stripVendorPulse(raw), CWD);
  if (resolved !== want) {
    problems.push(
      `vendorTitle('claude', ${JSON.stringify(raw)}) is ${JSON.stringify(resolved)}, not ${JSON.stringify(want)}`,
    );
  }
}
// An agent that writes its own title chose a session name that happens to be
// the folder's, and that name stays (#66). Codex never writes one, so for it
// the same text is the shell's and gives way to the vendor (checked above).
for (const agent of state.WRITES_OWN_TITLE) {
  const resolved = state.vendorTitle(agent, 'notes', CWD);
  if (resolved !== 'notes') {
    problems.push(
      `vendorTitle(${JSON.stringify(agent)}, "notes") is ${JSON.stringify(resolved)}, not "notes" — ` +
        'a session named after its folder loses its name',
    );
  }
}

// An agent with no name of its own has nothing to fall back to, and an empty
// string is the right answer: stateTokens turns it into a null token, which
// clears the cell, where a blank string would leave one drawn and empty.
if (state.vendorTitle('nosuchvendor', '', CWD) !== '') {
  problems.push('vendorTitle: an unnamed vendor with no title should resolve to the empty string');
}

// The ranges the READMEs print have to be the ranges the installer maps.
//
// A user on a terminal we do not write config for reads them and maps by hand,
// so a stale range there is a silently half-drawn sidebar for exactly the people
// who cannot check it against anything. All three said E1A0-E1B3 long after the
// 24th vendor moved the end to E1B7, and the Chinese one had drifted to E1D1 on
// the second range as well. Derived, because prose does not get recompiled.
const documented = RANGES.map(([lo, hi]) => `U+${lo}\u2013U+${hi}`);
for (const name of ['README.md', 'README.zh-CN.md', 'README.ja.md']) {
  const prose = fs.readFileSync(path.join(root, name), 'utf8');
  // A hyphen is the same range typed on a keyboard without an en dash, and
  // lower-case hex is the same range too. The lookahead stops a fifth digit
  // from being read as a correct four-digit range with a stray character.
  const printed = [...prose.matchAll(/U\+[0-9A-F]{4}[\u2013-]U\+[0-9A-F]{4}(?![0-9A-F])/gi)].map(([text]) =>
    text.toUpperCase().replace('-', '\u2013'),
  );
  for (const range of printed) {
    if (!documented.includes(range)) {
      problems.push(
        `${name}: documents ${range}, which install-font does not map (it maps ${documented.join(' and ')})`,
      );
    }
  }
  for (const range of documented) {
    if (!printed.includes(range)) {
      problems.push(`${name}: never tells a user to map ${range}`);
    }
  }
}

// Reordering workspaces has to settle. The module moves them, Herdr emits
// workspace.reordered, the frame wakes and asks again — so if feeding the
// result back in ever produces a different list, that is not a wrong order,
// it is an infinite write loop over IPC. Idempotence is the whole safety
// argument for the feature, so it is checked rather than assumed.
//
// Randomised because the interesting cases are interactions: families whose
// members start apart, a parent with no key of its own, ties, and parent links
// that happen to form a cycle.
const { desiredOrder } = require('../lib/workspace-order');
const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
let unstable = null;
for (let i = 0; i < 200 && !unstable; i += 1) {
  const order = [...ids].sort(() => Math.random() - 0.5);
  const keys = new Map();
  const parents = new Map();
  for (const id of ids) {
    if (Math.random() < 0.7) keys.set(id, String(Math.floor(Math.random() * 4)).padStart(3, '0'));
    if (Math.random() < 0.25) {
      const parent = ids[Math.floor(Math.random() * ids.length)];
      if (parent !== id) parents.set(id, parent);
    }
  }
  try {
    const once = desiredOrder(order, keys, parents);
    const twice = desiredOrder(once, keys, parents);
    if (once.join() !== twice.join()) {
      unstable = `once=${once.join(',')} twice=${twice.join(',')}`;
    } else if ([...once].sort().join() !== [...order].sort().join()) {
      unstable = `membership changed: in=${order.join(',')} out=${once.join(',')}`;
    }
  } catch (error) {
    unstable = `threw: ${error.message}`;
  }
  if (unstable) {
    unstable += `\n  order=${order.join(',')} keys=${JSON.stringify([...keys])} parents=${JSON.stringify([...parents])}`;
  }
}
if (unstable) {
  problems.push(`workspace order: desiredOrder is not idempotent — ${unstable}`);
}

// The worktree tree: a linked worktree hangs under the repo's main checkout,
// and a second workspace on that same main checkout stays a peer.
{
  const { worktreeParents } = require('../lib/state');
  const repo = (linked) => ({ repo_key: '/r/.git', repo_name: 'r', is_linked_worktree: linked });
  const { parents } = worktreeParents([
    { workspace_id: 'main1', worktree: repo(false) },
    { workspace_id: 'main2', worktree: repo(false) },
    { workspace_id: 'branch', worktree: repo(true) },
  ]);
  if (parents.get('branch') !== 'main1') {
    problems.push(`worktreeParents: the linked worktree hangs under ${parents.get('branch')}, expected main1`);
  }
  if (parents.has('main2')) {
    problems.push(`worktreeParents: a second main checkout hangs under ${parents.get('main2')}`);
  }
}

// The tree the Agents panel draws. An `owner` token outranks the repo, two
// workspaces on the same main checkout stay side by side, the tree stays one
// level deep, and a loop of owners never leaves a cycle for the sort to chase.
{
  const { worktreeParents } = require('../lib/state');
  const repo = (linked) => ({ repo_key: '/r/.git', repo_name: 'r', is_linked_worktree: linked });
  const list = [
    { workspace_id: 'arch1', worktree: repo(false), tokens: {} },
    { workspace_id: 'arch2', worktree: repo(false), tokens: {} },
    { workspace_id: 'worker', worktree: repo(true), tokens: { owner: 'arch2' } },
    { workspace_id: 'plain', worktree: repo(true), tokens: {} },
    { workspace_id: 'sub', tokens: { owner: 'worker' } },
    { workspace_id: 'ghost', worktree: repo(true), tokens: { owner: 'closed' } },
    { workspace_id: 'loopA', tokens: { owner: 'loopB' } },
    { workspace_id: 'loopB', tokens: { owner: 'loopA' } },
  ];
  const { parents, repoParents } = worktreeParents(list);
  const expect = {
    arch1: undefined,
    arch2: undefined,
    worker: 'arch2',
    plain: 'arch1',
    sub: 'arch2',
    ghost: 'arch1',
  };
  for (const [child, parent] of Object.entries(expect)) {
    if (parents.get(child) !== parent) {
      problems.push(`worktreeParents: ${child} hangs under ${parents.get(child)}, expected ${parent}`);
    }
  }
  if (parents.get('loopA') === 'loopB' && parents.get('loopB') === 'loopA') {
    problems.push('worktreeParents: an owner loop survived as a cycle');
  }
  // The owner wins, but the checkout is kept for an owner with no agents.
  if (repoParents.get('worker') !== 'arch1') {
    problems.push(
      `worktreeParents: an owned worktree lost its checkout (${repoParents.get('worker')}), expected arch1`,
    );
  }
}

// Checks that write tokens record them here instead of reaching Herdr. One
// stub for the whole script, so concurrent checks never restore the real
// writer under one another; each check uses pane ids of its own.
const herdrWrites = new Map();
require('../lib/herdr').reportMetadataAsync = async (pane, _source, tokens) => {
  if (!herdrWrites.has(pane)) herdrWrites.set(pane, []);
  herdrWrites.get(pane).push(tokens);
  return true;
};
const gapsUnder = (panes) => panes.filter((pane) => herdrWrites.get(pane)?.at(-1)?.gap);

// The flat list's gaps close a whole group, not each workspace in it: none
// between an architect and its workers, one after the group's last row, none
// after the last row of the list.
{
  const { writeGaps } = require('../lib/state');
  const rows = [
    ['a', 'flat-a:p1'],
    ['m', 'flat-m:p1'],
    ['m', 'flat-m:p2'],
    ['b', 'flat-b:p1'],
  ].map(([workspace, pane]) => ({ workspace, pane }));
  writeGaps('check', rows, new Map([['m', 'a']])).then(() => {
    const gaps = gapsUnder(rows.map((row) => row.pane));
    if (gaps.join() !== 'flat-m:p2') {
      problems.push(`writeGaps: gaps under ${gaps.join(', ') || 'nothing'}, expected flat-m:p2`);
    }
  });
}

// With headers, the gap closes a family too: none between an architect and
// its first worker, none between two workers, one after the last.
{
  const { writeGroups } = require('../lib/state');
  const rows = ['a', 'm1', 'm2', 'b'].map((workspace) => ({ workspace, pane: `headed-${workspace}:p1` }));
  const labels = new Map(rows.map((row) => [row.workspace, row.workspace]));
  const parentOf = new Map([
    ['m1', 'a'],
    ['m2', 'a'],
  ]);
  writeGroups('check', rows, labels, new Set(), { parentOf }).then(() => {
    const gaps = gapsUnder(rows.map((row) => row.pane));
    if (gaps.join() !== 'headed-m2:p1,headed-b:p1') {
      problems.push(`writeGroups: gaps under ${gaps.join(', ') || 'nothing'}, expected headed-m2:p1, headed-b:p1`);
    }
  });
}

// Role ranks put a coordinator above a leader, above workers, whatever the
// panes' activity. Both ranks get the invisible bold-title marker.
{
  const { Frame } = require('../lib/frame');
  const frame = new Frame('check');
  frame.lastWorkingAt = new Map([
    ['ws:busy', 60000 * 5],
    ['ws:arch', 60000],
    ['ws:split', 60000 * 2],
    ['ws:coord', 60000 * 0],
  ]);
  const rows = [
    { workspace: 'ws', tab: 't1', pane: 'ws:busy', role: '' },
    { workspace: 'ws', tab: 't2', pane: 'ws:split', role: '' },
    { workspace: 'ws', tab: 't2', pane: 'ws:arch', role: 'architect' },
    { workspace: 'ws', tab: 't3', pane: 'ws:coord', role: 'coordinator' },
  ];
  const keys = frame.sortKeys(rows, new Map(), new Map());
  const order = frame.displayOrder(rows, 'grouped', keys).map((row) => row.pane);
  if (order.slice(0, 2).join() !== 'ws:coord,ws:arch') {
    problems.push(`role ranks: order is ${order.join(', ')}, expected ws:coord, ws:arch first`);
  }
  if (keys.splitChild(rows[2]) || !keys.splitChild(rows[1])) {
    problems.push('architect role: the architect does not head its split');
  }
  if (!keys.coordinators.has(rows[3].pane) || keys.leaders.has(rows[3].pane)) {
    problems.push('coordinator role: coordinator rank is not distinct from the leader rank');
  }
  const { width } = require('../bin/settings');
  for (const [rank, stripe] of Object.entries({
    worker: palette.band.bar,
    leader: palette.band.leaderBar,
    coordinator: palette.band.coordinatorBar,
  })) {
    if (width(stripe) !== 1) problems.push(`${rank} role: ${stripe} is ${width(stripe)} columns, not one`);
  }
  const coordinatorBand = state.bandValue(0, '', { coordinator: keys.coordinators.has(rows[3].pane) });
  const leaderBand = state.bandValue(0, '', { leader: keys.leaders.has(rows[2].pane) });
  const memberBand = state.bandValue(0, '', {});
  if (!coordinatorBand.startsWith('█')) {
    problems.push(`coordinator role: band is ${JSON.stringify(coordinatorBand)}, not a full block`);
  }
  if (!leaderBand.startsWith('█')) {
    problems.push(`architect role: leader band is ${JSON.stringify(leaderBand)}, not a full block`);
  }
  if (!memberBand.startsWith('▎')) {
    problems.push(`architect role: member band is ${JSON.stringify(memberBand)}, not a thin block`);
  }
  const line = { band: null, mark: '·', split: '', logo: '', titlePrefix: '' };
  const title = 'Ranked title';
  const coordinatorTitle = state.stateTokens('idle', line, title, keys.coordinators.has(rows[3].pane)).title_idle;
  const leaderTitle = state.stateTokens('idle', line, title, keys.leaders.has(rows[2].pane)).title_idle;
  const workerTitle = state.stateTokens('idle', line, title, keys.leaders.has(rows[0].pane)).title_idle;
  if (coordinatorTitle !== `${state.LEADER_MARK}${title}` || leaderTitle !== `${state.LEADER_MARK}${title}`) {
    problems.push('role ranks: coordinator or leader title is missing the bold marker');
  }
  if (workerTitle !== title) problems.push('role ranks: worker title unexpectedly carries the bold marker');
}

// Colour slots: every top-level group gets its own while there are slots
// left, members wear their parent's, and a group keeps its slot when another
// group leaves.
{
  const { Frame } = require('../lib/frame');
  const frame = new Frame('check');
  const entries = (...ids) => ids.map((ws) => ({ workspace: ws, pane: `${ws}:p1` }));
  const parentOf = new Map([['m', 'b']]);
  const first = frame.groupColorSlots(entries('a', 'b', 'm', 'c'), parentOf);
  if (new Set([first.get('a'), first.get('b'), first.get('c')]).size !== 3) {
    problems.push(`groupColorSlots: top-level groups share a slot — ${JSON.stringify([...first])}`);
  }
  if (first.get('m') !== first.get('b')) {
    problems.push('groupColorSlots: a member does not wear its parent group colour');
  }
  const second = frame.groupColorSlots(entries('b', 'm', 'c'), parentOf);
  if (second.get('b') !== first.get('b') || second.get('c') !== first.get('c')) {
    problems.push('groupColorSlots: a group changed colour when another group left');
  }
}

// The sort keys are republished when any of them moves, tab_key included: a
// tab's key follows its busiest pane, so it can change while this pane's own
// sort_key and ws_key stay put, and a stale tab_key makes Herdr's order
// disagree with the one the group furniture was drawn for.
{
  const { Frame } = require('../lib/frame');
  const frame = new Frame('check');
  const entry = { pane: 'sortkeys:p1', workspace: 'w', tab: 't', name: 'claude', title: 'x' };
  const keysWith = (tabKey) => ({
    minuteKey: () => '000000000001',
    wsKeys: new Map([['w', 'ws']]),
    tabKeys: new Map([['sortkeys:p1', tabKey]]),
  });
  const run = async (tabKey) => {
    const jobs = [];
    frame.paneJobs(entry, 'idle', { tabs: new Map(), keys: keysWith(tabKey), indent: '', spinStep: 0 }, 0, [], jobs);
    await Promise.all(jobs);
  };
  (async () => {
    await run('0-000000000001-t');
    await run('0-000000000002-t');
    const sent = (herdrWrites.get('sortkeys:p1') ?? []).filter((t) => 'tab_key' in t).map((t) => t.tab_key);
    if (sent.join() !== '0-000000000001-t,0-000000000002-t') {
      problems.push(`paneJobs: tab_key writes were ${sent.join(', ') || 'none'}, expected both keys`);
    }
  })();
}

// writeAtomic keeps a symlinked config a symlink: it writes the link's
// target, so a config kept in a dotfiles repo stays linked.
{
  const os = require('node:os');
  const { writeAtomic } = require('../lib/toml-blocks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-check-'));
  const real = path.join(dir, 'real.toml');
  const link = path.join(dir, 'config.toml');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);
  writeAtomic(link, 'new');
  if (!fs.lstatSync(link).isSymbolicLink()) problems.push('writeAtomic: replaced a symlinked config with a plain file');
  if (fs.readFileSync(real, 'utf8') !== 'new') problems.push('writeAtomic: the symlink target was not updated');
  fs.rmSync(dir, { recursive: true, force: true });
}

// row_label: each mode names the row as documented, and a tab-only row keeps
// its title when the tab is unnamed or carries only Herdr's number.
{
  const { rowText } = require('../lib/state');
  const cases = [
    ['title', 'architect', { tabLabel: '', title: 'Architect::QA' }],
    ['tab', 'architect', { tabLabel: '', title: 'architect' }],
    ['both', 'architect', { tabLabel: 'architect', title: 'Architect::QA' }],
    ['tab', '', { tabLabel: '', title: 'Architect::QA' }],
    ['tab', '1', { tabLabel: '', title: 'Architect::QA' }],
    // A name that is only whitespace, or a number wrapped in it, is no name.
    ['tab', '   ', { tabLabel: '', title: 'Architect::QA' }],
    ['tab', ' 12 ', { tabLabel: '', title: 'Architect::QA' }],
    ['tab', ' qa ', { tabLabel: '', title: 'qa' }],
  ];
  for (const [mode, tab, expected] of cases) {
    const got = rowText(mode, tab, 'Architect::QA');
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`rowText(${mode}, "${tab}"): ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  }
}

// row_label is read from the settings file, and a file from before it existed
// keeps its meaning: show_tab = true reads as both, anything else as title.
{
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const readRowLabel = (toml) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-config-'));
    fs.writeFileSync(path.join(dir, 'config.toml'), toml);
    const out = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/config').rowLabel)"], {
      cwd: root,
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir },
      encoding: 'utf8',
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return out.stdout;
  };
  const cases = [
    ['row_label = "tab"\nshow_tab = true\n', 'tab'],
    ['show_tab = true\n', 'both'],
    ['show_tab = false\n', 'title'],
    ['row_label = "sideways"\n', 'title'],
    ['', 'title'],
  ];
  for (const [toml, expected] of cases) {
    const got = readRowLabel(toml);
    if (got !== expected)
      problems.push(`config: ${JSON.stringify(toml)} reads row_label as ${got}, expected ${expected}`);
  }
}

// Liveness is asked of the endpoint, never of a pid file.
//
// `kill(pid, 0)` on the pid file only says that SOME process has the number,
// and after a restart that can be a browser (#19). The names are gone so a
// caller cannot keep using them: an async replacement under the old name
// would have returned a Promise, which is always truthy, and a launcher
// asking `if (running()) return` would never start a daemon again.
for (const dir of ['lib', 'bin']) {
  for (const file of fs.readdirSync(path.join(root, dir))) {
    if (!file.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(root, dir, file), 'utf8');
    for (const name of ['animatorRunning', 'pidAlive']) {
      if (text.includes(name)) {
        problems.push(`${dir}/${file}: still refers to ${name} — ask state.daemonStatus() instead`);
      }
    }
  }
}

// The build hook must not start a process. It runs inside Herdr's temporary
// checkout, which Herdr renames into place afterwards; a daemon started from
// there inherits that directory as its cwd, and on Windows a directory that
// is some process's cwd cannot be renamed — every install failed with os
// error 32 (#23). The daemon starts from the startup hooks instead.
{
  const text = fs.readFileSync(path.join(root, 'bin', 'setup.js'), 'utf8');
  for (const name of ['detachedNode', 'child_process', 'spawn(']) {
    if (text.includes(name)) problems.push(`bin/setup.js: starts a process (${name}) from the build hook (#23)`);
  }
}

// After the pending promise checks above have settled.
setImmediate(() => {
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('ok');
});
