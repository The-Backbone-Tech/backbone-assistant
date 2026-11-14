// Shiki, loaded lazily with only the grammars slice 1 needs. Dual themes follow the app's Light/Dark.
import type { HighlighterCore } from 'shiki/core';

let loading: Promise<HighlighterCore> | undefined;

function highlighter() {
  loading ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [import('shiki/langs/diff.mjs'), import('shiki/langs/markdown.mjs'), import('shiki/langs/typescript.mjs'), import('shiki/langs/json.mjs')],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return loading;
}

export function langFor(path: string): string {
  if (/\.(ts|tsx|js|mjs)$/.test(path)) return 'typescript';
  if (/\.json$/.test(path)) return 'json';
  if (/\.md$/.test(path)) return 'markdown';
  return 'text';
}

export async function highlight(code: string, lang: string): Promise<string> {
  const h = await highlighter();
  return h.codeToHtml(code, { lang: lang === 'text' ? 'markdown' : lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
}
