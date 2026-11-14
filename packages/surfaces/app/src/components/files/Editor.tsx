// CodeMirror 6 for editing text and markdown, in the app's colours and type. The parent owns the
// text: a change from outside (a restored draft, a save) replaces the document; typing reports up.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import * as React from 'react';

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 16px 0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--draft-bg)', outline: '1px solid var(--draft)' },
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600', color: 'var(--code-heading)' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--code-link)' },
  { tag: [tags.keyword, tags.processingInstruction], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.monospace], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.quote, tags.meta], color: 'var(--code-comment)' },
]);

export function Editor({ value, onChange, onSave, label, lang }: { value: string; onChange: (v: string) => void; onSave: () => void; label: string; lang: 'markdown' | 'text' }) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView>(null);
  // The latest callbacks, so the editor is built once.
  const handlers = React.useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  // Set while the parent's value is written in, so that write is not reported back as typing.
  const external = React.useRef(false);

  React.useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          search({ top: true }),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          placeholder('Empty file'),
          ...(lang === 'markdown' ? [markdown()] : []),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !external.current) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Built once per file and language; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, lang]);

  React.useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    external.current = true;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    external.current = false;
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="editor" />;
}
