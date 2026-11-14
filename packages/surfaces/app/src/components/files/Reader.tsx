// Reading a file: Streamdown renders markdown (tables included); code is highlighted by Shiki;
// other text reads as it is.
import * as React from 'react';
import { Streamdown } from 'streamdown';
import { showAddresses } from '../../lib/addresses';
import { highlight, langFor } from '../../lib/highlight';
import { kindOf } from './kind-label';

export function Reader({ name, text }: { name: string; text: string }) {
  const kind = kindOf(name);
  if (kind === 'markdown')
    return (
      <div className="reading mx-auto max-w-3xl px-6 py-5 text-[15px] leading-relaxed" data-testid="reader">
        <Streamdown mode="static" parseIncompleteMarkdown={false} controls={{ table: false, code: false, mermaid: false }}>
          {showAddresses(text)}
        </Streamdown>
      </div>
    );
  return <Code name={name} text={text} />;
}

function Code({ name, text }: { name: string; text: string }) {
  const [html, setHtml] = React.useState<string>();
  const lang = langFor(name);
  React.useEffect(() => {
    if (lang !== 'text') void highlight(text, lang).then(setHtml);
  }, [text, lang]);
  return html ? (
    <div className="p-4 font-mono text-ui leading-6 [&_pre]:whitespace-pre-wrap" data-testid="reader" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="whitespace-pre-wrap p-4 font-mono text-ui leading-6" data-testid="reader">
      {text}
    </pre>
  );
}
