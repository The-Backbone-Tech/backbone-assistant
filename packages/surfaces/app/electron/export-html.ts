// A document as one self-contained page, rendered by the main process with the reader's own
// Streamdown (src/components/files/Reader.tsx): inline styles, no script, no remote asset. Links
// keep their words and lose their target; images keep their description. The page's own policy
// forbids every fetch, so the hidden window that prints it to PDF reaches nothing either.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { showAddresses } from '../src/lib/addresses.ts';

/** `slides` is a PDF deck: one 16:9 page per slide (`slidesOf`). */
export type ExportFormat = 'md' | 'html' | 'pdf' | 'slides';

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITY[c]);
const stem = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, '') || 'document';

/** The name the save dialog offers: the document's base name, its version and the format. */
export const exportName = (name: string, version: number, format: ExportFormat) => `${stem(name)}-v${version}${format === 'slides' ? '-slides.pdf' : `.${format}`}`;

// Where Letter is the usual paper (CLDR's paper-size data); everywhere else prints on A4.
const LETTER = new Set(['US', 'CA', 'MX', 'PR', 'PH', 'CL', 'CO', 'CR', 'GT', 'PA', 'SV', 'VE', 'DO', 'NI', 'BZ']);
export const pageSizeFor = (country: string): 'A4' | 'Letter' => (LETTER.has(country.toUpperCase()) ? 'Letter' : 'A4');

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1f1d1a; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; } h4, h5, h6 { font-size: 1em; }
main > div > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.25em; }
blockquote { border-left: 3px solid #d8d3ca; padding-left: 1em; color: #5c574f; }
hr { border: 0; border-top: 1px solid #d8d3ca; margin: 2em 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; }
:not(pre) > code { background: #f2efe9; border-radius: 4px; padding: 0.1em 0.3em; }
pre { background: #f7f5f0; border: 1px solid #e6e1d8; border-radius: 6px; padding: 0.8em 1em; white-space: pre-wrap; word-break: break-word; }
[data-streamdown="code-block-header"] { font-size: 0.75em; color: #7a746a; margin-bottom: 0.25em; }
table { border-collapse: collapse; width: 100%; font-size: 0.93em; break-inside: auto; }
th, td { border: 1px solid #e0dbd2; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f5f2ec; font-weight: 600; }
tr { break-inside: avoid; }
[style*="max-height"], [data-streamdown] { max-height: none !important; overflow: visible !important; }
.link { text-decoration: underline; }
.image { color: #7a746a; font-style: italic; }
input[type="checkbox"] { margin-right: 0.4em; }
@page { margin: 18mm 16mm; }
@media print { main { padding: 0; max-width: none; } }
`;

/** Markdown as the reader shows it, as static markup: links keep their words, images their description. */
function rendered(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: 'static',
        parseIncompleteMarkdown: false,
        controls: { table: false, code: false, mermaid: false },
        components: {
          a: ({ children }) => createElement('span', { className: 'link' }, children),
          img: ({ alt }) => createElement('span', { className: 'image' }, `[${alt || 'image'}]`),
        },
      },
      showAddresses(markdown),
    ),
  );
}

/** Markdown in, one page out: what the reader shows, with nothing that reaches outside the file. */
export function exportHtml(name: string, markdown: string): string {
  const body = rendered(markdown);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(stem(name))}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const BREAK = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^\s{0,3}#{1,2}\s/;

/**
 * A document's slides: split at a thematic break (`---` on a line of its own after a blank line; just
 * under text it is a heading), never inside a code block. A document with no break but two or more
 * top headings (# or ##) is split before each. Blank slides are dropped; one slide is the whole text.
 */
export function slidesOf(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const split = (at: (line: string, i: number) => boolean) => {
    const out: string[][] = [[]];
    let fence: string | null = null;
    lines.forEach((line, i) => {
      const f = FENCE.exec(line)?.[1];
      if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? null : f;
      if (!fence && !f && at(line, i)) out.push([]);
      else out.at(-1)!.push(line);
    });
    return out.map((s) => s.join('\n').trim()).filter(Boolean);
  };
  const byBreaks = split((line, i) => BREAK.test(line) && (i === 0 || !lines[i - 1].trim()));
  if (byBreaks.length > 1) return byBreaks;
  const headings = lines.filter((l) => HEADING.test(l)).length;
  if (headings < 2) return byBreaks.length ? byBreaks : [''];
  // Split before each heading: the heading starts its slide, so it is kept, not consumed.
  const out: string[][] = [[]];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? null : f;
    if (!fence && !f && HEADING.test(line) && out.at(-1)!.some((l) => l.trim())) out.push([]);
    out.at(-1)!.push(line);
  }
  return out.map((s) => s.join('\n').trim()).filter(Boolean);
}

const SLIDE_STYLE = `
@page { size: 13.333in 7.5in; margin: 0; }
section.slide { width: 13.333in; height: 7.5in; box-sizing: border-box; padding: 0.6in 0.8in; overflow: hidden; break-after: page; display: flex; flex-direction: column; justify-content: center; font-size: 24px; position: relative; }
section.slide:last-child { break-after: auto; }
section.slide h1 { font-size: 2.1em; margin-top: 0; } section.slide h2 { font-size: 1.6em; margin-top: 0; }
section.slide .n { position: absolute; right: 0.5in; bottom: 0.35in; font-size: 0.55em; color: #9a948a; }
main { max-width: none; padding: 0; }
`;

/** A deck: each slide a 16:9 page, rendered as the reader renders, with its number. Same policy as a page: no script, nothing fetched. */
export function exportSlides(name: string, markdown: string): string {
  const slides = slidesOf(markdown);
  const body = slides.map((s, i) => `<section class="slide"><div>${rendered(s)}</div><span class="n">${i + 1} / ${slides.length}</span></section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(stem(name))}</title><style>${STYLE}${SLIDE_STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}
