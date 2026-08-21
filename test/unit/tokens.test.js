// app/config.js's COLOR and index.html's CSS custom properties are two
// copies of the same four colours — one paints the pins, the other paints
// the sheet pill, the filter chips and the checklist dots.
//
// They drifted once already: the redesign updated the CSS vars and left
// COLOR on the old palette, so a stale machine was #98A0AE on the map and
// #8C93A5 in the sheet. Nothing failed, it just looked slightly wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLOR } from '../../app/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('COLOR matches the CSS custom properties it duplicates', () => {
  for (const [key, hex] of Object.entries(COLOR)) {
    const m = html.match(new RegExp(`--${key}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `index.html has no --${key} custom property`);
    assert.equal(
      hex.toUpperCase(),
      m[1].toUpperCase(),
      `COLOR.${key} is ${hex} but --${key} is ${m[1]} — the map and the sheet would disagree`,
    );
  }
});
