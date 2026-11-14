import * as React from 'react';
import type { NoticeEntry, NoticeText } from '@backbone-next/platform/notices';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

/** Upstream HTML is a document to read; remove navigation and external resource elements. */
function offlineHtml(text: string): string {
  const document = new DOMParser().parseFromString(text, 'text/html');
  document.querySelectorAll('script,link,iframe,frame,object,embed,img,video,audio,source,base,meta,form').forEach(element => element.remove());
  document.querySelectorAll('a').forEach(anchor => {
    if (!anchor.getAttribute('href')?.startsWith('#')) anchor.removeAttribute('href');
  });
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${document.documentElement.outerHTML}`;
}

export function NoticesSection() {
  const [entries, setEntries] = React.useState<NoticeEntry[]>([]);
  const [selected, setSelected] = React.useState<NoticeText>();
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState('');
  const request = React.useRef(0);
  React.useEffect(() => {
    let live = true;
    const read = window.backbone?.listNotices;
    if (!read) { setError('Read bundled notices in the desktop app.'); return; }
    void read().then(value => { if (live) setEntries(value); }, () => { if (live) setError('Bundled notices could not be read. Reinstall this product.'); });
    return () => { live = false; request.current++; };
  }, []);
  const open = async (id: string) => {
    const token = ++request.current; setSelected(undefined); setError('');
    try {
      const notice = await window.backbone!.readNotice!(id);
      if (request.current === token) setSelected(notice);
    } catch { if (request.current === token) setError('This bundled notice could not be read. Reinstall this product.'); }
  };
  const visible = entries.filter(entry => `${entry.name} ${entry.version} ${entry.license}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-4 py-5">
    <p className="text-sm text-muted">Licences and attribution supplied with this build. Available offline.</p>
    {error && <p role="alert">{error}</p>}
    {selected ? <>
      <Button variant="outline" size="sm" onClick={() => { request.current++; setSelected(undefined); }}>All bundled pieces</Button>
      <h3 className="break-words font-semibold">{selected.name} {selected.version}</h3>
      <p className="text-sm text-muted">{selected.license}</p>
      {selected.format === 'html'
        ? <iframe title={`${selected.name} licences`} sandbox="" referrerPolicy="no-referrer" className="h-[420px] w-full bg-white" srcDoc={offlineHtml(selected.text)} />
        : <pre data-testid="notice-text" className="whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{selected.text}</pre>}
    </> : <>
      <Input type="search" aria-label="Search bundled pieces" placeholder="Search bundled pieces" value={query} onChange={event => setQuery(event.target.value)} />
      <p role="status" className="text-xs text-muted">{visible.length} bundled pieces</p>
      <ul className="space-y-1">{visible.map(entry => <li key={entry.id}>
        <Button variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => void open(entry.id)}>
          <span className="min-w-0 break-words">{entry.name} <span className="text-muted">{entry.version} · {entry.license}</span></span>
        </Button>
      </li>)}</ul>
    </>}
  </div>;
}
