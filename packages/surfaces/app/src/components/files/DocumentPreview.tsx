import * as React from 'react';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { checkImageHeader, IMAGE_PIXEL_LIMIT, SHEET_WINDOW_ROWS, SHEET_WINDOW_COLUMNS, imageSource, MAX_PREVIEW_BYTES, PREVIEW_LIMIT, previewBytes, previewKind, previewTag, safeImage, previewRefusal, READ_FAILURE, type OfficePreview, type SafeNode, type SheetPreview } from './preview-boundary';
import OfficeWorker from './office-worker?worker';
import { rememberedFailure, rememberFailure, forgetFailure } from './preview-failures';

class PreviewBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function nodes(items: SafeNode[]): React.ReactNode {
  return items.map((node, key) => {
    if (typeof node === 'string') return node;
    const tag = previewTag(node.tag);
    if (!tag) return nodes(node.children);
    if (tag === 'img') {
      const src = safeImage(node.src ?? '');
      return src ? <img key={key} src={src} alt="Embedded document image" className="max-w-full" /> : '[Image unavailable]';
    }
    return React.createElement(tag, { key }, tag === 'br' ? undefined : nodes(node.children));
  });
}
export function DocumentPreview({ name, base64, text, bytes, cacheKey }: { cacheKey?: string; name: string; base64?: string; text?: string; bytes: number }) {
  const [attempt, setAttempt] = React.useState(0);
  const [value, setValue] = React.useState<OfficePreview>();
  const [error, setError] = React.useState<string | undefined>(() => rememberedFailure(cacheKey));
  const PdfPreview = React.useMemo(() => React.lazy(() => import('./PdfPreview').then(module => ({ default: module.PdfPreview }))), [attempt]);
  const [imageReady, setImageReady] = React.useState(false);
  const [actual, setActual] = React.useState(false);
  const kind = previewKind(name);
  const encoded = base64 ?? (text !== undefined ? btoa(unescape(encodeURIComponent(text))) : '');
  const tooLarge = bytes > MAX_PREVIEW_BYTES || encoded.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4;
  const fail = React.useCallback((message: string) => {
    setError(message);
    // A failed conversion is never retried just because a saved tab was restored.
    rememberFailure(cacheKey, message);
  }, [cacheKey]);
  React.useEffect(() => {
    setImageReady(false);
    setValue(undefined); setActual(false);
    const previous = attempt === 0 ? rememberedFailure(cacheKey) : undefined;
    setError(previous);
    if (previous) return;
    if (!kind || tooLarge) return;
    if (kind === 'image') {
      let live = true;
      const image = new Image();
      try { checkImageHeader(previewBytes(encoded)); } catch (e) { fail(e instanceof Error && e.message === IMAGE_PIXEL_LIMIT ? IMAGE_PIXEL_LIMIT : READ_FAILURE); return; }
      image.onload = () => { if (live) { if (image.naturalWidth * image.naturalHeight > 40_000_000) fail(IMAGE_PIXEL_LIMIT); else setImageReady(true); } };
      image.onerror = () => { if (live) fail(READ_FAILURE); };
      // Decode as a detached, inert image before admitting it to the page.
      image.src = imageSource(name, encoded);
      return () => { live = false; image.onload = null; image.onerror = null; image.src = ''; };
    }
    if (kind === 'pdf') return;
    let worker: Worker | undefined;
    try {
      worker = new OfficeWorker();
      const data = previewBytes(encoded);
      worker.postMessage({ name, bytes: data }, [data.buffer]);
    } catch { worker?.terminate(); fail(READ_FAILURE); return; }
    const timeout = setTimeout(() => { worker?.terminate(); fail('This document took too long to preview. You can retry or download it.'); }, 15000);
    worker!.onmessage = (event: MessageEvent<{ value?: OfficePreview; error?: string }>) => {
      clearTimeout(timeout); setValue(event.data.value); if (event.data.error) fail(event.data.error); worker?.terminate();
    };
    worker!.onerror = () => { clearTimeout(timeout); fail(READ_FAILURE); worker?.terminate(); };
    return () => { clearTimeout(timeout); worker?.terminate(); };
  }, [name, encoded, kind, tooLarge, attempt, fail, cacheKey]);
  // A fixed limit fails the same way every time: only Download (in the file's header) is offered. A failure that can change keeps Try again.
  const failure = (message: string, retry = !previewRefusal(message), label = 'Try again') => <div className="space-y-3 p-6 text-sm" role="alert"><p>{message}</p>{retry && <Button variant="outline" size="sm" onClick={() => { forgetFailure(cacheKey); setError(undefined); setAttempt(n => n + 1); }}>{label}</Button>}</div>;
  if (!kind) return <p className="p-6 text-sm text-muted">This file type has no preview.</p>;
  if (tooLarge) return failure(PREVIEW_LIMIT, false);
  if (error) return failure(error);
  if (kind === 'image' && !imageReady) return <p role="status" className="p-6 text-sm text-muted">Loading image…</p>;
  if (kind === 'image') return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2" role="group" aria-label="Image zoom">
      <Button variant="ghost" size="sm" aria-pressed={!actual} onClick={() => setActual(false)}>Fit to pane</Button>
      <Button variant="ghost" size="sm" aria-pressed={actual} onClick={() => setActual(true)}>Actual size</Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-surface p-4"><img key={attempt} alt={name} src={imageSource(name, encoded)} className={actual ? 'max-w-none' : 'mx-auto max-h-full max-w-full object-contain'} onError={() => fail(READ_FAILURE)} /></div>
  </div>;
  if (kind === 'pdf') return <PreviewBoundary key={attempt} fallback={failure('This preview could not be loaded', true, 'Retry')}><React.Suspense fallback={<p role="status" className="p-6 text-sm text-muted">Loading PDF…</p>}><PdfPreview key={attempt} base64={encoded} onError={fail} /></React.Suspense></PreviewBoundary>;
  if (!value) return <p className="p-6 text-sm text-muted" role="status">Loading preview…</p>;
  if (value.kind === 'word') return <article aria-label="Word document" className="document-preview space-y-3 p-6 text-sm">{value.nodes.length ? nodes(value.nodes) : <p role="status" className="text-muted">No supported document content could be previewed. Download to inspect the original.</p>}</article>;
  if (value.kind === 'slides' && !value.slides.length) return <p role="status" className="p-6 text-sm text-muted">This deck has no slides to preview.</p>;
  if (value.kind === 'slides') return <div className="space-y-4 p-4"><p className="text-xs text-muted">Slide layout is simplified. Text and embedded images appear in document order.</p>{value.slides.map((slide, i) => <section key={i} aria-label={`Slide ${i + 1}`} className="document-preview space-y-3 rounded-lg border border-border bg-surface p-5"><h2 className="text-xs font-medium text-muted">Slide {i + 1} of {value.slides.length}</h2>{nodes(slide)}</section>)}</div>;
  if (!value.sheets.length) return <p className="p-6 text-sm text-muted">This workbook has no sheets.</p>;
  return <Tabs defaultValue="0" className="flex h-full min-h-0 flex-col"><TabsList aria-label="Workbook sheets" className="shrink-0 overflow-x-auto border-b border-border p-2">{value.sheets.map((sheet, i) => <TabsTrigger key={i} value={String(i)}>{sheet.name}</TabsTrigger>)}</TabsList>{value.sheets.map((sheet, i) => <TabsContent key={i} value={String(i)} className="h-full"><SheetGrid sheet={sheet} /></TabsContent>)}</Tabs>;
}
function columnName(n: number): string { let result = ''; for (n++; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; }
function SheetGrid({ sheet }: { sheet: SheetPreview }) {
  const [start, setStart] = React.useState(0);
  const [column, setColumn] = React.useState(0);
  const count = sheet.rows.length;
  const columns = Math.min(100, sheet.totalColumns);
  const visibleColumns = Math.min(SHEET_WINDOW_COLUMNS, columns - column);
  const notice = sheet.partial ? `Showing the first ${count} ${count === 1 ? 'row' : 'rows'}${sheet.totalRows === undefined ? '' : ` of ${sheet.totalRows}`}.` : undefined;
  return <div className="flex h-full min-h-0 flex-col text-xs">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2" role="group" aria-label="Sheet rows">
      <span role="status">{count ? `Rows ${start + 1}–${Math.min(start + SHEET_WINDOW_ROWS, count)}${sheet.totalRows === undefined ? '' : ` of ${sheet.totalRows}`}` : sheet.partial ? 'No cells fit in the remaining preview budget.' : 'This sheet is empty.'}</span>
      <Button variant="ghost" size="sm" disabled={!start} onClick={() => setStart(n => Math.max(0, n - SHEET_WINDOW_ROWS))}>Previous rows</Button>
      <Button variant="ghost" size="sm" disabled={start + SHEET_WINDOW_ROWS >= count} onClick={() => setStart(n => n + SHEET_WINDOW_ROWS)}>Next rows</Button>
      {count > 0 && columns > SHEET_WINDOW_COLUMNS && <><span>Columns {columnName(column)}–{columnName(column + visibleColumns - 1)}</span><Button variant="ghost" size="sm" disabled={!column} onClick={() => setColumn(n => Math.max(0, n - SHEET_WINDOW_COLUMNS))}>Previous columns</Button><Button variant="ghost" size="sm" disabled={column + visibleColumns >= columns} onClick={() => setColumn(n => n + SHEET_WINDOW_COLUMNS)}>Next columns</Button></>}
      {notice && <p>{notice} {sheet.partialRow && 'The last preview row is incomplete. '}{sheet.totalColumns > columns && `${sheet.totalColumns - columns} columns left out. `}Download for the whole file.</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label={`${sheet.name} cell values`}>
      <table className="border-separate border-spacing-0 text-left"><thead className="sticky top-0 z-20 bg-surface"><tr><th scope="col" className="sticky left-0 z-30 min-w-10 border-b border-r border-border bg-surface p-2">Row</th>{Array.from({ length: visibleColumns }, (_, c) => <th scope="col" key={c} className="min-w-28 border-b border-r border-border bg-surface p-2">{columnName(column + c)}</th>)}</tr></thead><tbody>{Array.from({ length: Math.min(SHEET_WINDOW_ROWS, count - start) }, (_, i) => { const row = sheet.rows[start + i] ?? []; return <tr key={start + i}><th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-surface p-2 text-muted">{start + i + 1}</th>{Array.from({ length: visibleColumns }, (_, c) => <td key={c} className="max-w-96 whitespace-pre-wrap break-words border-b border-r border-border px-2 py-1.5">{row[column + c] ?? ''}</td>)}</tr>; })}</tbody></table>
    </div>
  </div>;
}
