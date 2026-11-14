// Streamdown caches a processor by its plugins' names and JSON options, and callbacks are not in
// JSON: two answers in the same context must still each hear about their own absolute links.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { answerPlugins } from '../src/lib/answer-plugins.ts';

test('two answers with identical context each report their own absolute links', () => {
  const seen: string[][] = [[], []];
  const html = [0, 1].map((i) => renderToString(createElement(Streamdown, {
    mode: 'static',
    rehypePlugins: answerPlugins({ key: 'same-context', answer: `answer-${i}`, resolve: () => ({ kind: 'blocked' }), found: (href) => seen[i].push(href) }),
  }, `See [one](/project/one-${i}.md) and [two](file:///project/two-${i}.md).`)));
  assert.deepEqual(seen, [['/project/one-0.md', '/project/two-0.md'], ['/project/one-1.md', '/project/two-1.md']]);
  for (const h of html) assert.doesNotMatch(h, /href="\/project/, 'no local address survives as a link');
});
