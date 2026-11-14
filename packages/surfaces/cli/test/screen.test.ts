// The full-screen chat layout: the alternate screen, a header, a scrolling transcript region, the
// input on the last row, and the terminal given back as it was.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { fullScreen, paneColumns, SPLIT_MIN_COLUMNS } from '../src/screen.ts';
import { Terminal } from './terminal.ts';

test('full screen: alternate screen, header, transcript region, input row, and the terminal back on close', () => {
  let written = '';
  const s = fullScreen((x) => void (written += x), () => ({ rows: 20, columns: 40 }));
  assert.ok(written.startsWith('\x1b[?1049h'), 'the alternate screen');
  assert.match(written, /\x1b\[2;18r/, 'the transcript scrolls in rows 2 to 18');
  written = '';
  s.status('backbone chat · thread abc · effort 4');
  assert.match(written, /\x1b\[1;1H.*backbone chat · thread abc · effort 4/, 'the header on row 1');
  written = '';
  s.out('first line\nsecond line');
  assert.equal((written.match(/\x1b\[18;1H\n/g) ?? []).length, 2, 'each line enters at the region\'s bottom, scrolling it');
  assert.ok(written.includes('\x1b7') && written.includes('\x1b8'), 'and the cursor goes back to the input');
  written = '';
  s.out('an \x1b[31mescape\x1b[0m in the text');
  assert.doesNotMatch(written.replace(/\x1b(7|8|\[[0-9;]*[A-Za-z?])/g, ''), /\x1b/, 'text cannot drive the terminal');
  written = '';
  s.toInput();
  assert.equal(written, '\x1b[20;1H\x1b[2K', 'the input on the last row');
  written = '';
  s.close();
  assert.equal(written, '\x1b[r\x1b[?1049l', 'the terminal back as it was');
  written = '';
  s.out('after');
  s.close();
  assert.equal(written, '', 'nothing after close');
});

test('resize repaints earlier answers and errors, reflowed for the new width', () => {
  let written = '';
  let size = { rows: 12, columns: 40 };
  const s = fullScreen((x) => void (written += x), () => size);
  s.out('an earlier answer');
  s.err('a problem');
  s.out('abcdefghijklmnopqrstuvwxyz');
  written = '';
  size = { rows: 14, columns: 14 };
  s.layout();
  assert.ok(written.includes('an earlier ans'), 'the earlier answer is repainted');
  assert.ok(written.includes('wer'), 'its remainder is wrapped at the new width');
  assert.match(written, /\x1b\[2;31ma problem\x1b\[0m/, 'the error keeps its style');
  assert.ok(written.includes('abcdefghijklmn'));
  assert.ok(written.includes('opqrstuvwxyz'));
  assert.ok(written.indexOf('an earlier ans') < written.indexOf('a problem'));
  assert.ok(written.indexOf('a problem') < written.indexOf('abcdefghijklmn'));
  assert.ok(written.endsWith('\x1b[14;1H'), 'readline redraw starts on the input row after the transcript');
  written = '';
  size = { rows: 12, columns: 40 };
  s.layout();
  assert.ok(written.includes('an earlier answer'), 'growing restores the logical line');
  assert.ok(written.includes('abcdefghijklmnopqrstuvwxyz'), 'reflow does not store the old wraps');
  s.close();
});

test('long output and output arriving in a one-cell terminal remain available after growth', () => {
  let written = '';
  let size = { rows: 8, columns: 20 };
  const s = fullScreen((x) => void (written += x), () => size);
  s.out(Array.from({ length: 30 }, (_, i) => `answer ${i}`).join('\n'));
  written = '';
  s.layout();
  assert.ok(written.includes('answer 29'), 'the latest output is still visible');
  written = '';
  size = { rows: 1, columns: 1 };
  s.layout();
  s.out('arrived while tiny');
  for (const [, row, column] of written.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    assert.equal(Number(row), 1, 'no cursor outside the single row');
    assert.equal(Number(column), 1, 'no cursor outside the single column');
  }
  assert.doesNotMatch(written, /\x1b\[\d+;\d+r/, 'a one-row scrolling region is invalid');
  written = '';
  size = { rows: 40, columns: 20 };
  s.layout();
  assert.ok(written.includes('answer 0'), 'a larger terminal can restore earlier output');
  assert.ok(written.includes('answer 29'));
  assert.ok(written.includes('arrived while tiny'), 'output arriving while hidden is retained too');
  s.close();
});

test('ten thousand output lines and a very long line keep resize replay bounded', () => {
  let written = '';
  let size = { rows: 24, columns: 80 };
  const s = fullScreen((x) => void (written += x), () => size);
  s.out(Array.from({ length: 10_000 }, (_, i) => `answer ${i}`).join('\n'));
  written = '';
  s.layout();
  assert.ok(written.includes('answer 9999'), 'the latest answer is repainted');
  assert.ok(!written.includes('answer 0'), 'old off-screen output is not replayed');
  assert.ok(written.length < 4_096, 'resize work follows the visible tail, not the whole session');
  written = '';
  size = { rows: 10_004, columns: 80 };
  s.layout();
  assert.ok(!written.includes('answer 0'), 'retained display history is bounded too');
  assert.ok(written.length < 100_000, 'growing cannot replay all ten thousand lines');
  s.out(`${'x'.repeat(1_000_000)}END OF LONG ANSWER`);
  written = '';
  size = { rows: 24, columns: 80 };
  s.layout();
  assert.ok(written.includes('END OF LONG ANSWER'));
  assert.ok(written.length < 70_000, 'a single long line cannot bypass the retained-text bound');
  s.close();
});

test('untrusted output cannot replay terminal controls, while tabs and newlines are retained', () => {
  let written = '';
  const s = fullScreen((x) => void (written += x), () => ({ rows: 12, columns: 40 }));
  s.out('first\tcolumn\nsecond\x07\b\x00\x1b\x7f\x85 line');
  written = '';
  s.layout();
  const visible = stripVTControlCharacters(written);
  assert.ok(visible.includes('first\tcolumn'));
  assert.ok(visible.includes('second line'));
  assert.doesNotMatch(visible, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'no BEL, backspace, bare ESC, DEL or C1 controls');
  s.close();
});

test('a wide terminal shows the pane beside the transcript, within its own columns, and closing it restores the transcript', () => {
  const term = new Terminal(16, 120);
  const s = fullScreen(term.write, () => ({ rows: term.rows, columns: term.columns }));
  s.status('backbone chat · thread abc');
  s.out('an answer that stays on the left');
  s.pane({ title: 'Diff · brief.md v2', lines: [{ text: '--- a/brief.md', style: 'meta' }, { text: '-Request: one', style: 'remove' }, { text: '+Request: two', style: 'add' }, { text: 'x'.repeat(200) }] });
  assert.equal(s.paneOpen(), true);
  const split = SPLIT_MIN_COLUMNS <= 120 ? paneColumns(120) : 0;
  assert.ok(split > 0, 'at 120 columns the pane sits beside the transcript');
  const left = 120 - split - 1;
  assert.match(term.text(1), /backbone chat · thread abc/, term.dump());
  assert.match(term.text(2, left + 2), /Diff · brief\.md v2/, term.dump());
  assert.ok(term.grid.slice(1, 14).every((row) => row[left] === '│'), `a rule between them:\n${term.dump()}`);
  const body = Array.from({ length: 13 }, (_, i) => term.text(i + 2, left + 2)).join('\n');
  assert.match(body, /-Request: one\n\+Request: two/);
  assert.match(body, /x{10}/, 'a long line wraps inside the pane');
  const transcript = Array.from({ length: 13 }, (_, i) => term.text(i + 2, 1, left)).join('\n');
  assert.match(transcript, /an answer that stays on the left/);
  assert.doesNotMatch(transcript, /Request/, 'the pane does not spill into the transcript');
  s.out('y'.repeat(left + 30));
  assert.ok(term.grid.slice(1, 14).every((row) => row[left] === '│'), `transcript output wraps before the rule:\n${term.dump()}`);
  s.pane(null);
  assert.equal(s.paneOpen(), false);
  assert.ok(term.grid.slice(1, 14).every((row) => row[left] !== '│'), 'the rule is gone');
  const after = Array.from({ length: 13 }, (_, i) => term.text(i + 2)).join('\n');
  assert.match(after, /an answer that stays on the left/);
  assert.doesNotMatch(after, /Request/);
  s.close();
});

test('below the minimum width the pane takes the whole screen, output meanwhile is kept, and Esc gives the transcript back', () => {
  const term = new Terminal(12, SPLIT_MIN_COLUMNS - 1);
  const s = fullScreen(term.write, () => ({ rows: term.rows, columns: term.columns }));
  s.out('before the pane');
  s.pane({ title: 'Files · Demo', lines: [{ text: 'working  brief.md' }, { text: 'original notes.txt' }] });
  assert.match(term.text(2), /Files · Demo/, term.dump());
  assert.match(term.text(3), /^working  brief\.md/);
  assert.ok(!term.dump().includes('│'), 'no split on a narrow terminal');
  assert.ok(!term.dump().includes('before the pane'), 'the pane covers the transcript');
  s.out('arrived while the pane was open');
  assert.ok(!term.dump().includes('arrived while'), 'output is not drawn over the pane');
  assert.match(term.text(1), /backbone chat/, 'the header stays');
  term.resize(12, 130);
  s.layout();
  assert.ok(term.dump().includes('│'), 'growing the terminal splits it');
  assert.ok(term.dump().includes('arrived while the pane was open'));
  term.resize(12, 60);
  s.layout();
  s.pane(null);
  const all = term.dump();
  assert.ok(all.includes('before the pane') && all.includes('arrived while the pane was open'), all);
  assert.ok(!all.includes('brief.md'));
  s.close();
});

test('the pane scrolls within its rows, and its text cannot drive the terminal', () => {
  const term = new Terminal(10, 60);
  const s = fullScreen(term.write, () => ({ rows: term.rows, columns: term.columns }));
  s.pane({ title: 'notes.txt v1', lines: Array.from({ length: 40 }, (_, i) => ({ text: `line ${i}\x1b[2J\x07` })) });
  assert.match(term.text(3), /^line 0$/, term.dump());
  s.scrollPane(10);
  assert.match(term.text(3), /^line 10$/, term.dump());
  s.scrollPane(1_000);
  assert.match(term.dump(), /line 39/, 'scrolling stops at the end');
  s.scrollPane(-1_000);
  assert.match(term.text(3), /^line 0$/);
  s.close();
});
