// WCAG AA contrast for every text pair the app uses, in Light and Dark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const body = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT: [string, string][] = [
  ['fg', 'bg'], ['fg', 'surface'], ['fg', 'sunken'], ['fg', 'hover'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'sunken'],
  ['accent-fg', 'accent'], ['accent', 'bg'], ['accent', 'surface'], ['draft', 'draft-bg'], ['pending', 'pending-bg'],
  ['committed', 'committed-bg'], ['danger', 'bg'], ['danger', 'surface'], ['fg', 'diff-add-bg'], ['fg', 'diff-del-bg'],
  ['fg', 'sidebar'], ['muted', 'sidebar'], ['fg', 'accent-soft'], ['accent', 'sidebar'], ['muted', 'hover'], ['fg', 'sunken'],
  ...['code-keyword', 'code-string', 'code-number', 'code-heading', 'code-link', 'code-comment'].flatMap((c) => [[c, 'bg'], [c, 'surface']] as [string, string][]),
];
const NON_TEXT: [string, string][] = [
  ['strong-border', 'bg'], ['strong-border', 'surface'], ['ring', 'bg'], ['ring', 'sidebar'],
  ...['file-blue', 'file-green', 'file-amber', 'file-violet', 'file-red'].flatMap((c) => [[c, 'surface'], [c, 'sidebar']] as [string, string][]),
];

for (const [theme, selector] of [['Light', ':root'], ['Dark', '.dark']] as const) {
  test(`R-UX-FAMILIAR-01: ${theme} tokens meet WCAG AA contrast`, () => {
    const t = block(selector);
    for (const [fg, bg] of TEXT) assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${theme} ${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
    for (const [fg, bg] of NON_TEXT) assert.ok(contrast(t[fg], t[bg]) >= 3, `${theme} ${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
  });
}

test('Light is warm and Dark is neutral', () => {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [lr, , lb] = hex(block(':root').bg);
  assert.ok(lr > lb, 'Light background leans warm (more red than blue)');
  const [dr, dg, db] = hex(block('.dark').bg);
  assert.ok(Math.max(dr, dg, db) - Math.min(dr, dg, db) <= 2, 'Dark background is neutral grey');
});

function hue(h: string): { hue: number; sat: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const deg = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: (deg * 60 + 360) % 360, sat: d / (1 - Math.abs(max + min - 1)) };
}

test('The accent is deep green in Light and neutral grey in Dark; no orange accent is left', () => {
  assert.equal(block(':root').accent, '#2d5f3f');
  assert.equal(block('.dark').accent, '#d1d1d1');
  assert.equal(block('.dark').bg, '#1c1c1c');
  for (const sel of [':root', '.dark']) {
    for (const token of ['accent', 'ring', 'accent-soft']) {
      const { hue: h, sat } = hue(block(sel)[token]);
      assert.ok(sat < 0.1 || h < 10 || h > 50, `${sel} ${token} is not orange (hue ${h.toFixed(0)})`);
    }
  }
  assert.ok(!/#b4491f|#e8825a/i.test(css), 'the old orange accent is gone');
});

// Source: backbone-oss packages/web/src/styles/tokens.css at e1e71f11 (cream conversation from 79bd8c6e),
// the palette docs/ux.md there records as the owner's choice for the sidebar and chat.
// Alberto adjusted the light conversation colour on 4 November 2026.
test('The sidebar and chat use the chosen colours in Light and Dark', () => {
  const pick = (sel: string) => { const b = block(sel); return { sidebar: b.sidebar, conversation: b.conversation }; };
  assert.deepEqual(pick(':root'), { sidebar: '#f4f3ee', conversation: '#fbf7f1' });
  assert.deepEqual(pick('.dark'), { sidebar: '#1c1c1c', conversation: '#161616' });
  for (const sel of [':root', '.dark']) for (const [t, on] of [['fg', 'conversation'], ['muted', 'conversation'], ['accent', 'conversation']]) {
    assert.ok(contrast(block(sel)[t], block(sel)[on]) >= 4.5, `${sel} ${t} on ${on}`);
  }
});
