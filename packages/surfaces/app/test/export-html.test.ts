// Export renders a document with the reader's own Streamdown into one self-contained page: inline
// styles, no remote asset, no script, and links shown as their words but never followed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportName, exportHtml, exportSlides, pageSizeFor, slidesOf } from '../electron/export-html.ts';

const md = [
  '# Pilot brief',
  '',
  'Launch on **19 November**; see [the plan](https://example.com/plan) or <ana@example.com>.',
  '',
  '![chart](https://example.com/chart.png)',
  '',
  '<script>alert(1)</script>',
  '',
  '<img src="x" onerror="alert(1)">',
  '',
  '<a href="javascript:alert(1)">click</a>',
  '',
  '| Item | EUR |',
  '| --- | --- |',
  '| Venue | 5,100 |',
  '',
  '```js',
  'const a = 1;',
  '```',
].join('\n');

test('markdown in, one self-contained page out', () => {
  const html = exportHtml('brief.md', md);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<h1[^>]*>Pilot brief<\/h1>/);
  assert.match(html, /<title>brief<\/title>/);
  assert.match(html, /<style>[\s\S]+<\/style>/, 'styles are inline');
  assert.match(html, /<table[\s\S]*Venue[\s\S]*5,100/);
  assert.match(html, /const a = 1;/);
  assert.match(html, /ana@example\.com/, 'an address stays visible, as in the reader');
  assert.match(html, /the plan/, 'a link keeps its words');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

test('no external URL, no script, no handler', () => {
  const html = exportHtml('brief.md', md);
  assert.doesNotMatch(html, /https?:\/\//, 'no remote URL anywhere');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no event handler attribute');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<a\s/i, 'nothing to follow');
  assert.doesNotMatch(html, /src=/i, 'no image source');
});

test('the title is escaped and the default name carries the version', () => {
  assert.match(exportHtml('a<b>.md', '# x'), /<title>a&lt;b&gt;<\/title>/);
  assert.equal(exportName('brief.md', 3, 'pdf'), 'brief-v3.pdf');
  assert.equal(exportName('brief.md', 3, 'md'), 'brief-v3.md');
  assert.equal(exportName('Q4 plan.markdown', 12, 'html'), 'Q4 plan-v12.html');
  assert.equal(exportName('../../etc/x.md', 1, 'pdf'), 'x-v1.pdf', 'only the base name');
});

test('Letter where people print on Letter, A4 elsewhere', () => {
  assert.equal(pageSizeFor('US'), 'Letter');
  assert.equal(pageSizeFor('ca'), 'Letter');
  assert.equal(pageSizeFor('MX'), 'Letter');
  assert.equal(pageSizeFor('ES'), 'A4');
  assert.equal(pageSizeFor('GB'), 'A4');
  assert.equal(pageSizeFor(''), 'A4');
});

test('a deck splits at a thematic break, never at a heading underline or inside code, else at its top headings', () => {
  assert.deepEqual(slidesOf('# One\n\nIntro\n\n---\n\n## Two\n\n- a\n\n***\n\nThree'), ['# One\n\nIntro', '## Two\n\n- a', 'Three']);
  assert.deepEqual(slidesOf('Title text\n---\n\nmore'), ['Title text\n---\n\nmore'], 'just under text, --- is a heading');
  assert.deepEqual(slidesOf('# A\n\n```\n\n---\n\n# not a slide\n```\n\n---\n\n# B'), ['# A\n\n```\n\n---\n\n# not a slide\n```', '# B']);
  assert.deepEqual(slidesOf('Lead in.\n\n# First\nx\n\n## Second\ny\n\n### kept inside\nz'), ['Lead in.', '# First\nx', '## Second\ny\n\n### kept inside\nz']);
  assert.deepEqual(slidesOf('# Only one\n\ntext'), ['# Only one\n\ntext']);
  assert.deepEqual(slidesOf(''), ['']);
});

test('a deck is one self-contained page per slide: numbered, no script, nothing fetched, links as words', () => {
  const deck = exportSlides('brief.md', `# Pilot\n\nSee [plan](https://example.com/p).\n\n---\n\n<script>alert(1)</script>\n\n![c](https://example.com/c.png)\n\n---\n\n## End`);
  assert.equal((deck.match(/<section class="slide">/g) ?? []).length, 3);
  assert.match(deck, /1 \/ 3[\s\S]*2 \/ 3[\s\S]*3 \/ 3/);
  assert.match(deck, /default-src 'none'/);
  assert.match(deck, /@page \{ size: 13\.333in 7\.5in; margin: 0; \}/);
  assert.doesNotMatch(deck, /<script|https:\/\/|onerror|src="http/i);
  assert.match(deck, /<span class="link">plan<\/span>/);
  assert.equal(exportName('brief.md', 3, 'slides'), 'brief-v3-slides.pdf');
});
