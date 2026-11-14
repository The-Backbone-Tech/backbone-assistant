// backbone chat at a terminal, full screen: a header line with the thread and its settings, the
// transcript scrolling beneath it, and the line being typed held at the bottom. Plain ANSI on the
// terminal's alternate screen, so leaving gives the person their terminal back as it was. Piped
// input never gets this: it keeps clean, plain output.
//
// A side pane (files, a document at a version, a turn's diff) sits beside the transcript on a wide
// terminal and takes the whole body on a narrow one, as Claude Code's and Codex's diff views do.
// While it is open the body is painted cell by cell, because a scrolling region spans the full
// width (left and right margins are not in every terminal, macOS Terminal among them).
import { stripVTControlCharacters } from 'node:util';

const ESC = '\x1b[';
const DISPLAY_LINES = 1_000;
const DISPLAY_TEXT = 64 * 1_024;
export interface Size { rows: number; columns: number }

/** A line of the pane; its style is how a diff line reads. */
export interface PaneLine { text: string; style?: 'add' | 'remove' | 'meta' | 'dim' | 'error' }
/** What the pane shows: a title row, then lines that wrap at its width and scroll. */
export interface PaneView { title: string; lines: PaneLine[] }
/** From this width the pane sits beside the transcript; below it, it takes the whole body. */
export const SPLIT_MIN_COLUMNS = 100;
/** The pane's width beside the transcript: about half, and never under 40 columns. */
export const paneColumns = (columns: number) => Math.max(40, Math.floor((columns - 1) / 2));
const PANE_STYLE: Record<NonNullable<PaneLine['style']>, string> = { add: '32', remove: '31', meta: '36', dim: '2', error: '2;31' };
const PANE_HINT = 'Esc closes · PgUp/PgDn';

/** Terminal cells a grapheme takes: two for East Asian wide and emoji, none for a lone mark. */
function cells(grapheme: string): number {
  const cp = grapheme.codePointAt(0)!;
  if (/^\p{M}/u.test(grapheme)) return 0;
  if (/\p{Emoji_Presentation}/u.test(grapheme)) return 2;
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
const graphemes = new Intl.Segmenter();

/** Rows of at most `width` cells, each padded to exactly `width`; tabs stop every eight cells. */
export function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let used = 0;
  const put = (g: string, w: number) => {
    if (used + w > width) { rows.push(row + ' '.repeat(width - used)); row = ''; used = 0; }
    row += g;
    used += w;
  };
  for (const { segment } of graphemes.segment(text)) {
    if (segment === '\t') { const n = Math.min(8 - (used % 8), width - used) || Math.min(8, width); put(' '.repeat(n), n); }
    else put(segment, Math.min(cells(segment), width));
  }
  rows.push(row + ' '.repeat(Math.max(0, width - used)));
  return rows;
}
const widthOf = (text: string) => [...graphemes.segment(text)].reduce((n, { segment }) => n + cells(segment), 0);

export interface Screen {
  /** A line of the transcript, or a problem (shown dim red). */
  out(text: string): void;
  err(text: string): void;
  /** The header: which thread, and the settings the next message goes with. */
  status(text: string): void;
  /** Put the cursor on the input line, cleared, before the prompt is drawn there. */
  toInput(): void;
  /** Lay it out again (the terminal was resized). */
  layout(): void;
  /** Open the side pane on this view, or close it with null. */
  pane(view: PaneView | null): void;
  paneOpen(): boolean;
  /** Move the pane's text by this many rows (PgUp/PgDn). */
  scrollPane(rows: number): void;
  /** Give the terminal back as it was. */
  close(): void;
}

export function fullScreen(write: (s: string) => void, size: () => Size): Screen {
  let header = '';
  let open = true;
  let view: PaneView | null = null;
  let paneTop = 0;
  // This is a bounded display tail for the open terminal, not stored chat. Retain logical lines
  // so the terminal can wrap them at its new width, including wide/combining characters. The
  // saved chat is unchanged; a long session or a giant line cannot make resize unbounded.
  const transcript: { text: string; style: string }[] = [];
  let retained = 0;
  const dimensions = () => ({ rows: Math.max(1, size().rows), columns: Math.max(1, size().columns) });
  // With fewer than five rows, omit the chrome. A scrolling region needs at least two rows;
  // at one or two rows keep the input available and retain output for when the person grows it.
  const bottom = () => dimensions().rows >= 5 ? dimensions().rows - 2 : dimensions().rows - 1;
  const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const drawHeader = () => {
    if (dimensions().rows < 5) return;
    const label = clean(header || 'backbone chat').replace(/[\n\t]/g, ' ').slice(0, dimensions().columns - 1);
    write(`\x1b7${ESC}1;1H${ESC}2K${ESC}7m ${label}${' '.repeat(Math.max(0, dimensions().columns - label.length - 1))}${ESC}0m\x1b8${ESC}${dimensions().rows}d`);
  };
  const drawRule = () => {
    if (dimensions().rows >= 5) write(`\x1b7${ESC}${dimensions().rows - 1};1H${ESC}2K${ESC}2m${'─'.repeat(dimensions().columns)}${ESC}0m\x1b8${ESC}${dimensions().rows}d`);
  };
  /** The rows between the header and the rule, 1-based and inclusive; none below three rows. */
  const body = () => dimensions().rows >= 3 ? { top: dimensions().rows >= 5 ? 2 : 1, bottom: bottom() } : null;
  const split = () => !!view && dimensions().columns >= SPLIT_MIN_COLUMNS;
  /** The pane's own rows after its title, from the scroll position, wrapped at its width. */
  const paneRows = (width: number, height: number) => {
    const out: { text: string; style?: PaneLine['style'] }[] = [];
    let skipped = 0;
    for (const l of view!.lines) {
      for (const text of wrap(clean(l.text).replace(/\n/g, ' '), width)) {
        if (skipped++ < paneTop) continue;
        out.push({ text, style: l.style });
        if (out.length >= height) return out;
      }
    }
    return out;
  };
  const paneLength = (width: number) => view!.lines.reduce((n, l) => n + wrap(clean(l.text).replace(/\n/g, ' '), width).length, 0);
  /** Paint the body with the pane open: beside the transcript's tail, or over the whole body. */
  const paint = () => {
    const rows = body();
    if (!view || !rows) return;
    const { columns } = dimensions();
    const height = rows.bottom - rows.top + 1;
    const right = split() ? paneColumns(columns) : columns;
    const left = split() ? columns - right - 1 : 0;
    const transcriptRows: { text: string; style: string }[] = [];
    if (left > 0) {
      for (let i = transcript.length - 1; i >= 0 && transcriptRows.length < height; i--) {
        const wrapped = wrap(transcript[i].text, left).map((text) => ({ text, style: transcript[i].style }));
        transcriptRows.unshift(...wrapped.slice(-(height - transcriptRows.length)));
      }
    }
    const name = ` ${clean(view.title).replace(/[\n\t]/g, ' ')}`;
    const room = right - widthOf(name) - PANE_HINT.length - 1;
    const hint = wrap(room >= 2 ? `${name}${' '.repeat(room)}${PANE_HINT} ` : name, right)[0];
    const content = height > 1 ? paneRows(right, height - 1) : [];
    let out = '\x1b7';
    for (let r = 0; r < height; r++) {
      out += `${ESC}${rows.top + r};1H${ESC}0m`;
      if (left > 0) {
        const t = transcriptRows[r - (height - transcriptRows.length)];
        out += t ? `${t.style}${t.text}${ESC}0m` : ' '.repeat(left);
        out += `${ESC}2m│${ESC}0m`;
      }
      if (r === 0) { out += `${ESC}7m${hint}${ESC}0m`; continue; }
      const p = content[r - 1];
      out += p ? `${p.style ? `${ESC}${PANE_STYLE[p.style]}m` : ''}${p.text}${ESC}0m` : ' '.repeat(right);
    }
    write(`${out}\x1b8${ESC}${dimensions().rows}d`);
  };
  const render = ({ text, style }: { text: string; style: string }) => {
    // With the pane open the body is painted whole: beside it the transcript's tail, over it nothing.
    if (view) { if (split()) paint(); return; }
    // Restoring a cursor can clamp it to the scrolling region; explicitly return to the input
    // row while retaining its column, so asynchronous output cannot overwrite the transcript.
    if (dimensions().rows >= 3) write(`\x1b7${ESC}${bottom()};1H\n${ESC}2K${style}${text}${style ? `${ESC}0m` : ''}\x1b8${ESC}${dimensions().rows}d`);
  };
  const line = (text: string, style = '') => {
    if (!open) return;
    // At the region's bottom a new line scrolls the transcript up; the cursor goes back to the input.
    for (const part of clean(text).split('\n')) {
      const entry = { text: part, style };
      // Copy the tail: a JavaScript substring can otherwise retain the entire large source string.
      const tail = part.slice(-DISPLAY_TEXT).replace(/^[\uDC00-\uDFFF]/, '');
      const kept = { text: Buffer.from(tail, 'utf16le').toString('utf16le'), style };
      transcript.push(kept);
      retained += kept.text.length;
      while (transcript.length > DISPLAY_LINES || retained > DISPLAY_TEXT) retained -= transcript.shift()!.text.length;
      render(entry);
    }
  };
  const screen: Screen = {
    out: (text) => line(text),
    err: (text) => line(text, `${ESC}2;31m`),
    status: (text) => { header = text; if (open) drawHeader(); },
    toInput: () => { if (open) write(`${ESC}${dimensions().rows};1H${ESC}2K`); },
    layout: () => {
      if (!open) return;
      write(`${ESC}r${ESC}2J`);
      if (dimensions().rows >= 3) write(`${ESC}${dimensions().rows >= 5 ? 2 : 1};${bottom()}r`);
      drawHeader();
      drawRule();
      write(`${ESC}${dimensions().rows};1H`);
      if (view) paint();
      else if (dimensions().rows >= 3) {
        const height = dimensions().rows >= 5 ? dimensions().rows - 3 : dimensions().rows - 1;
        for (const entry of transcript.slice(-height)) render(entry);
      }
      write(`${ESC}${dimensions().rows};1H`);
    },
    pane: (next) => {
      view = next;
      paneTop = 0;
      screen.layout();
    },
    paneOpen: () => !!view,
    scrollPane: (by) => {
      const rows = body();
      if (!view || !rows || !open) return;
      const width = split() ? paneColumns(dimensions().columns) : dimensions().columns;
      const height = Math.max(1, rows.bottom - rows.top);
      paneTop = Math.max(0, Math.min(paneTop + by, paneLength(width) - height));
      paint();
    },
    close: () => {
      if (!open) return;
      open = false;
      view = null;
      transcript.length = 0;
      retained = 0;
      write(`${ESC}r${ESC}?1049l`);
    },
  };
  write(`${ESC}?1049h`);
  screen.layout();
  return screen;
}
