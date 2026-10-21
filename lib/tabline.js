'use strict';

// The tab-bar status line, composed for two callers: the resident daemon,
// which precomputes it into a cache file that Herdr's status command merely
// `type`s / `cat`s out, and bin/tab-bar.js, the standalone debug entry that
// still renders live from Herdr's injected environment.
//
// The daemon has no HERDR_ACTIVE_* environment — those are stamped per
// status-command run — so it finds the focused pane in the pane list's own
// `focused` flag and asks for the rest over the socket. Events never carry
// facts here either: focus is read fresh every refresh.

const fs = require('node:fs');

const ipc = require('./ipc');
const herdr = require('./herdr');
const { stateRoot, tabbarCache, ensureDir } = require('./paths');
const identity = require('./identity');
const hook = require('./hook');
const { shortenPath, basename } = require('./format');
const { branch } = require('./git');

// Columns the tab row spends before the status area gets a turn. Calibrated
// against what actually rendered on an 85-column row (see bin/tab-bar.js for
// the calibration story). Deliberately biased high: a line one column too
// long makes the whole status area vanish, a short one drops detail.
const RESERVE_FIXED = Number(identity.env('TABBAR_RESERVE') ?? 24);
const RESERVE_PER_TAB = Number(identity.env('TABBAR_RESERVE_PER_TAB') ?? 5);
const FALLBACK_WIDTH = 80;
const MAX_LINE = Number(identity.env('TABBAR_MAX') ?? 48);

const CACHE = () => (ensureDir(stateRoot), tabbarCache());

// The row carries two values, and they lose width very differently. A path is
// mostly redundant — its information sits at the right end, in the project
// name — so leading segments go first. A branch is short already and changes
// under you, which is the whole reason for showing it, so every fallback
// keeps it until the path has nothing left to give.
function candidates(cwd) {
  const paths = [shortenPath(cwd, 200), shortenPath(cwd, 40), shortenPath(cwd, 24), basename(cwd)].filter(
    (line) => typeof line === 'string' && line.length > 0,
  );

  const head = branch(cwd);
  if (!head) return paths;
  return [...paths.map((line) => `${line} · ${head}`), ...paths, head];
}

const SEPARATOR = ' · ';
const EXTRA_MAX = 32;
const MIN_PATH = 12;

const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

// Terminal columns of one code point: 0 for combining marks, 2 for East Asian wide and emoji, else 1.
function cells(char) {
  if (/^\p{M}$/u.test(char)) return 0;
  const code = char.codePointAt(0);
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

const width = (text) => Array.from(text).reduce((sum, char) => sum + cells(char), 0);

// The longest prefix of `text` within `columns`, never splitting a code point.
function clip(text, columns) {
  let used = 0;
  let out = '';
  for (const char of text) {
    used += cells(char);
    if (used > columns) break;
    out += char;
  }
  return out;
}

// The `tabbar` token of every pane that publishes one, in pane-list order,
// without control characters and cut at EXTRA_MAX columns; empty and
// non-string values are left out.
function tabbarExtras(panes) {
  const texts = [];
  for (const pane of panes) {
    const value = pane?.tokens?.tabbar;
    if (typeof value !== 'string') continue;
    const text = clip(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), EXTRA_MAX);
    if (text) texts.push(text);
  }
  return texts;
}

// The leading extras that fit `room` columns joined by the separator.
function fitExtras(extras, room) {
  const fitted = [];
  let used = 0;
  for (const text of extras) {
    const next = used + (fitted.length ? SEPARATOR.length : 0) + width(text);
    if (next > room) break;
    fitted.push(text);
    used = next;
  }
  return fitted;
}

// Columns the status area has for the whole line.
function statusRoom({ row, tabs }) {
  return (row ?? FALLBACK_WIDTH) - RESERVE_FIXED - RESERVE_PER_TAB * (tabs ?? 1);
}

function compose({ cwd, row, tabs, extras = [] }) {
  const room = statusRoom({ row, tabs });
  const wanted = fitExtras(extras, room - MIN_PATH - SEPARATOR.length);
  const reserved = wanted.length ? width(wanted.join(SEPARATOR)) + SEPARATOR.length : 0;
  const budget = Math.max(MIN_PATH, Math.min(room - reserved, MAX_LINE));
  const options = candidates(cwd);
  const path = options.find((option) => width(option) <= budget) ?? options[options.length - 1] ?? '';
  const extra = fitExtras(wanted, room - width(path) - SEPARATOR.length).join(SEPARATOR);
  if (wanted.length && !extra) return compose({ cwd, row, tabs });
  return [path, extra].filter(Boolean).join(SEPARATOR);
}

/* ------------------------------------------------------------ daemon side */

async function foregroundCwd(paneId) {
  const reply = await ipc.call('pane.process_info', { pane_id: paneId });
  return reply?.result?.process_info?.foreground_processes?.[0]?.cwd ?? null;
}

async function rowWidth(paneId) {
  const reply = await ipc.call('pane.layout', { pane_id: paneId });
  const width = reply?.result?.layout?.area?.width;
  return typeof width === 'number' ? width : null;
}

// The line as of right now, from live state only. Empty when nothing is
// focused or the reads fail — an empty cache file makes Herdr hide the
// segment, which beats showing a stale one confidently.
async function snapshotLine() {
  const panes = await herdr.panesAsync();
  const extras = tabbarExtras(panes);
  const focused = panes.find((pane) => pane.focused);
  if (!focused || typeof focused.pane_id !== 'string') return fitExtras(extras, statusRoom({})).join(SEPARATOR);

  const [cwd, row, tabs] = await Promise.all([
    foregroundCwd(focused.pane_id),
    rowWidth(focused.pane_id),
    herdr.tabsAsync(),
  ]);
  const tabCount = tabs.filter((tab) => tab.workspace_id === focused.workspace_id).length || 1;
  return compose({
    // The pane rides along, as it does for every other hook: something that
    // rewrites what one pane shows has to know which pane it is answering for,
    // and the tab bar was the only caller withholding it.
    cwd: hook.apply('cwd', cwd ?? focused.cwd ?? null, focused.pane_id),
    row,
    tabs: tabCount,
    extras,
  });
}

let published = null;

// Atomic replace, and only when the content changed: `type` can run at any
// moment, and a half-written file's torn line would be shown as the status —
// the command keeps only the last line of whatever it reads.
function publish(line) {
  const text = `${line}\n`;
  if (published === text) return;
  const target = CACHE();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
    published = text;
  } catch {
    // The next refresh tries again.
  }
}

module.exports = { compose, candidates, tabbarExtras, snapshotLine, publish, CACHE };
