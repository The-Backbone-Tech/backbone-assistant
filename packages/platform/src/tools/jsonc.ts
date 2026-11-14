// A careful edit of a JSON-with-comments settings file, on Microsoft's jsonc-parser (as VS Code
// edits its settings): its parser finds every member's place and refuses a file with any error, its
// scanner finds the commas past comments, and `applyEdits` applies the change. Only the placement of
// the one edit is ours: jsonc-parser's own `modify` drops the comments between a removed member and
// the one before it, and its formatter reflows neighbouring members (test/jsonc.test.ts shows both),
// so the edit keeps every comment and whitespace span that is not ours.
import { applyEdits, createScanner, type Edit, type Node, parseTree, type ParseError, printParseErrorCode, SyntaxKind } from 'jsonc-parser';

export class JsoncError extends Error {}

function tree(text: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !root) throw new JsoncError(errors.length ? `${printParseErrorCode(errors[0].error)} at character ${errors[0].offset}` : 'an empty file');
  return root;
}

/** The file's value; a file with any parse error is refused. */
export function parseJsonc(text: string): unknown {
  return nodeValue(tree(text));
}

function nodeValue(node: Node): unknown {
  if (node.type === 'object') return Object.fromEntries((node.children ?? []).map((p) => [p.children![0].value as string, nodeValue(p.children![1])]));
  if (node.type === 'array') return (node.children ?? []).map(nodeValue);
  return node.value;
}

/** The value at `path`, or undefined. */
export function valueAt(value: unknown, path: string[]): unknown {
  let v = value;
  for (const key of path) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, key)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

interface Member {
  key: string;
  start: number;
  end: number;
  value: Node;
  /** The comma after the value, past comments, when there is one. */
  comma: number | null;
}

function commaAfter(text: string, at: number): number | null {
  const scanner = createScanner(text, false);
  scanner.setPosition(at);
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.Trivia || kind === SyntaxKind.LineBreakTrivia || kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) continue;
    return kind === SyntaxKind.CommaToken ? scanner.getTokenOffset() : null;
  }
  return null;
}

function membersOf(text: string, object: Node): Member[] {
  return (object.children ?? []).map((p) => ({ key: p.children![0].value as string, start: p.offset, end: p.offset + p.length, value: p.children![1], comma: commaAfter(text, p.offset + p.length) }));
}

/** The object at `path` and how much of the path exists. */
function objectAt(text: string, root: Node, path: string[]): { node: Node; depth: number } {
  let node = root;
  let depth = 0;
  for (; depth < path.length; depth++) {
    const m = membersOf(text, node).findLast((x) => x.key === path[depth]);
    if (!m) break;
    if (m.value.type !== 'object') throw new JsoncError(`${path.slice(0, depth + 1).join('.')} is not an object`);
    node = m.value;
  }
  return { node, depth };
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const indentOf = (text: string, at: number) => {
  const before = text.slice(lineStart(text, at), at);
  return /^[ \t]*$/.test(before) ? before : null;
};
/** The file's own indent step: its shortest indent, two spaces when it shows none. */
function unitOf(text: string): string {
  const all = [...text.matchAll(/\n([ \t]+)["}\]]/g)].map((m) => m[1]);
  if (!all.length) return '  ';
  return all[0].startsWith('\t') ? '\t' : all.reduce((a, b) => (b.length < a.length ? b : a));
}
const outerIndent = (text: string, node: Node) => /^[ \t]*/.exec(text.slice(lineStart(text, node.offset)))![0];
const render = (value: unknown, indent: string, unit: string) => JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);
/** The end of a comment that follows `at` on the same line, or `at` itself. */
function pastLineComment(text: string, at: number): number {
  let i = at;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text.startsWith('//', i)) return text.includes('\n', i) ? text.indexOf('\n', i) : text.length;
  if (text.startsWith('/*', i)) {
    const close = text.indexOf('*/', i) + 2;
    if (close > 1 && !text.slice(i, close).includes('\n')) return close;
  }
  return at;
}
/** Whether only spaces lie between `at` and the end of its line. */
const blankToLineEnd = (text: string, at: number) => /^[ \t]*(?:\n|$)/.test(text.slice(at));

/**
 * Set `key` in the object at `path` (made when missing) to `value`, changing only that member's text:
 * a new member goes on its own line after the last one, its comma and a comment ending that line.
 */
export function setMember(text: string, path: string[], key: string, value: unknown): string {
  const root = tree(text);
  if (root.type !== 'object') throw new JsoncError('the file is not an object');
  const { node: parent, depth } = objectAt(text, root, path);
  const rest = path.slice(depth);
  const memberKey = rest[0] ?? key;
  const memberValue = rest.length ? rest.slice(1).reduceRight<unknown>((v, k) => ({ [k]: v }), { [key]: value }) : value;
  const members = membersOf(text, parent);
  const unit = unitOf(text);
  const indent = (members[0] && indentOf(text, members[0].start)) || outerIndent(text, parent) + unit;
  const body = `${JSON.stringify(memberKey)}: ${render(memberValue, indent, unit)}`;
  const edits: Edit[] = [];
  const existing = rest.length ? undefined : members.findLast((m) => m.key === key);
  if (existing) edits.push({ offset: existing.value.offset, length: existing.value.length, content: render(value, indentOf(text, existing.start) ?? indent, unit) });
  else if (!members.length) {
    // Whatever the empty object holds (comments, a blank line) stays; the member goes after it.
    const close = parent.offset + parent.length - 1;
    const inner = text.slice(parent.offset + 1, close);
    const kept = inner.replace(/\s+$/, '').length;
    edits.push({ offset: parent.offset + 1 + kept, length: inner.length - kept, content: `\n${indent}${body}\n${outerIndent(text, parent)}` });
  } else {
    const last = members.at(-1)!;
    if (last.comma !== null) edits.push({ offset: pastLineComment(text, last.comma + 1), length: 0, content: `\n${indent}${body},` });
    else {
      edits.push({ offset: last.end, length: 0, content: ',' });
      edits.push({ offset: pastLineComment(text, last.end), length: 0, content: `\n${indent}${body}` });
    }
  }
  return applyEdits(text, edits);
}

/** Remove `key` from the object at `path`, with the comma it needs and its own line; every other span stays. */
export function removeMember(text: string, path: string[], key: string): string {
  const root = tree(text);
  const { node: parent, depth } = objectAt(text, root, path);
  if (depth < path.length) return text;
  const members = membersOf(text, parent);
  const index = members.findLastIndex((m) => m.key === key);
  if (index < 0) return text;
  const m = members[index];
  const cut = (from: number, to: number): Edit => ({ offset: from, length: to - from, content: '' });
  // Our member alone on its line: the line goes. Anything else on that line (a comment) stays.
  const ownLine = indentOf(text, m.start) !== null;
  if (m.comma !== null) {
    // A comment between our value and its comma is not ours: our member goes, then the comma on its own.
    if (text.slice(m.end, m.comma).trim()) return applyEdits(text, [cut(m.start, m.end), cut(m.comma, m.comma + 1)]);
    let end = m.comma + 1;
    while (text[end] === ' ' || text[end] === '\t') end++;
    if (!ownLine || !blankToLineEnd(text, end)) return applyEdits(text, [cut(m.start, end)]);
    if (text[end] === '\n') return applyEdits(text, [cut(lineStart(text, m.start), end + 1)]);
    return applyEdits(text, [cut(Math.max(lineStart(text, m.start) - 1, 0), end)]);
  }
  const from = ownLine && blankToLineEnd(text, m.end) ? Math.max(lineStart(text, m.start) - 1, parent.offset + 1) : m.start;
  // The last of several: the comma before it goes too, and only that comma.
  if (index > 0) return applyEdits(text, [cut(members[index - 1].comma!, members[index - 1].comma! + 1), cut(from, m.end)]);
  return applyEdits(text, [cut(from, m.end)]);
}
