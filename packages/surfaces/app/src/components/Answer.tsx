// An answer's markdown. A link to a document of this workspace opens it in the side pane, beside
// the conversation; any other local path stays text. Web links keep Streamdown's safe handling.
import type { FileLink } from '@backbone-next/platform';
import * as React from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';
import { useApp } from '../lib/state';
import { call } from '../lib/api';
import { answerPlugins } from '../lib/answer-plugins';
import { resolveLink, type LinkContext } from '../lib/workspace-links';

const CONTROLS = { table: false, code: { copy: true, download: false }, mermaid: false };
const NO_FILES: FileLink[] = [];

const Targets = React.createContext<LinkContext>({ projectId: '', touched: [] });

function WorkspaceLink({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
  const { openTab,remote } = useApp();
  const context = React.useContext(Targets);
  const target = resolveLink(String(props['data-href'] ?? ''), context);
  if (remote||target.kind !== 'workspace') return <BlockedLink>{children}</BlockedLink>;
  const { materialId: id, version, path } = target;
  return (
    <button type="button" data-workspace-link={path} title={`Open ${path}${version === undefined ? '' : ` v${version}`} beside the conversation`} className="wrap-anywhere appearance-none text-left font-medium text-primary underline" onClick={() => openTab('file', id, version)}>
      {children}
    </button>
  );
}

function BlockedLink({ children }: React.PropsWithChildren) {
  return <span data-blocked-link="true" title="Not a document in this workspace, so it does not open." className="text-muted underline decoration-dotted">{children}</span>;
}

const COMPONENTS = { 'workspace-link': WorkspaceLink, 'blocked-link': BlockedLink } as unknown as StreamdownProps['components'];

type Resolved = NonNullable<LinkContext['resolved']>;

/** Streamdown memoizes its outer renderer without comparing rehypePlugins. Local anchors therefore
 * resolve in React context: link eligibility updates without remounting Markdown or losing selection.
 * Web anchors retain the maintained renderer's own hardening and link-safety handling. */
export function Answer({ text, projectId, workspace, touched = NO_FILES, streaming = false }: { text: string; streaming?: boolean; projectId: string; workspace?: LinkContext['workspace']; touched?: FileLink[] }) {
  const [resolved, setResolved] = React.useState<Resolved>({ projectId, links: {} });
  const found = React.useRef(new Set<string>());
  const asked = React.useRef({ projectId, hrefs: new Set<string>() });
  const context: LinkContext = { projectId, workspace, touched, resolved };
  const answer = React.useId();
  const plugins = React.useMemo(() => answerPlugins({
    key: answer, answer, defer: true,
    // Only classifies web vs local here. Local eligibility belongs to the live React context.
    resolve: (href) => resolveLink(href, { projectId: '', touched: [] }),
    found: (href) => found.current.add(href),
  }), [answer]);
  React.useEffect(() => {
    if (asked.current.projectId !== projectId) asked.current = { projectId, hrefs: new Set() };
    const mine = asked.current;
    const fresh = [...found.current].filter((href) => !mine.hrefs.has(href));
    if (!fresh.length) return;
    for (const href of fresh) mine.hrefs.add(href);
    void Promise.all(fresh.map(async (href) => {
      const r = await call('files.resolveLink', { projectId, href }).catch(() => null);
      return r?.ok ? [href, r.value] as const : null;
    })).then((answers) => {
      if (asked.current !== mine) return;
      const links = Object.fromEntries(answers.filter((x) => !!x));
      if (!Object.keys(links).length) return;
      setResolved((current) => ({ projectId, links: { ...(current.projectId === projectId ? current.links : {}), ...links } }));
    });
  });
  return (
    <Targets.Provider value={context}>
      <Streamdown mode="streaming" isAnimating={streaming} controls={CONTROLS} rehypePlugins={plugins} components={COMPONENTS}>
        {text}
      </Streamdown>
    </Targets.Provider>
  );
}
