import * as React from 'react';
import { getDocument, PDFWorker, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { Input, Select } from '../ui/input';
import { Button } from '../ui/button';
import { previewBytes, READ_FAILURE, PDF_PAGE_LIMIT, PDF_CANVAS_LIMIT } from './preview-boundary';
import './pdf-text-layer.css';

// No embedded viewer, annotation layer, scripting manager, attachment or link service.
// PDF.js receives bytes, never a document URL. Fonts, wasm and XFA are disabled.
export function PdfPreview({ base64, onError }: { base64: string; onError(message: string): void }) {
  const [document, setDocument] = React.useState<PDFDocumentProxy>();
  const [scale, setScale] = React.useState(1);
  const [pageNumber, setPageNumber] = React.useState(1);
  const container = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let nativeWorker: Worker | undefined, worker: PDFWorker | undefined;
    let task: ReturnType<typeof getDocument>;
    try {
      nativeWorker = new PdfWorker();
      worker = PDFWorker.create({ port: nativeWorker });
      task = getDocument({ worker, data: previewBytes(base64), maxImageSize: 40_000_000, canvasMaxAreaInBytes: 16_000_000, useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, useWasm: false, enableXfa: false, disableAutoFetch: true });
    } catch { worker?.destroy(); nativeWorker?.terminate(); onError(READ_FAILURE); return; }
    let live = true;
    const timeout = setTimeout(() => { live = false; onError('This PDF took too long to preview. You can retry or download it.'); void task.destroy().catch(() => {}); }, 15000);
    void task.promise.then(doc => {
      clearTimeout(timeout);
      if (!live) return;
      if (doc.numPages > 200) { onError(PDF_PAGE_LIMIT); return; }
      setDocument(doc);
    }).catch(() => { if (live) onError(READ_FAILURE); });
    return () => { live = false; clearTimeout(timeout); void task.destroy().catch(() => {}); worker?.destroy(); nativeWorker?.terminate(); };
  }, [base64, onError]);
  const go = (n: number) => { setPageNumber(n); container.current?.querySelector(`[data-pdf-page="${n}"]`)?.scrollIntoView({ block: 'start' }); };
  return <div className="pdf-preview flex h-full min-h-0 flex-col">
    <div role="group" aria-label="PDF controls" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2 text-xs">
      <Button variant="ghost" size="sm" disabled={pageNumber === 1 || !document} onClick={() => go(pageNumber - 1)}>Previous page</Button>
      <label>Page <Input size="sm" aria-label="PDF page" className="w-14" type="number" min={1} max={document?.numPages ?? 1} value={pageNumber} onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= (document?.numPages ?? 1)) go(n); }} /></label><span>of {document?.numPages ?? '…'}</span>
      <Button variant="ghost" size="sm" disabled={!document || pageNumber === document.numPages} onClick={() => go(pageNumber + 1)}>Next page</Button>
      <label>Zoom <Select size="sm" aria-label="PDF zoom" value={scale} onChange={event => setScale(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(n => <option key={n} value={n}>{n * 100}%</option>)}</Select></label>
    </div>
    {!document && <p role="status" className="p-6 text-sm text-muted">Loading PDF…</p>}
    <div ref={container} tabIndex={0} role="region" aria-label="PDF pages" className="min-h-0 flex-1 space-y-4 overflow-auto bg-surface p-4">{document && Array.from({ length: document.numPages }, (_, i) => <PdfPage key={i} doc={document} n={i + 1} scale={scale} root={container} onVisible={setPageNumber} onError={onError} />)}</div>
  </div>;
}
function PdfPage({ doc, n, scale, root, onVisible, onError }: { doc: PDFDocumentProxy; n: number; scale: number; root: React.RefObject<HTMLDivElement | null>; onVisible(n: number): void; onError(message: string): void }) {
  const holder = React.useRef<HTMLDivElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const text = React.useRef<HTMLDivElement>(null);
  const [refusedScale, setRefusedScale] = React.useState<number>();
  const refused = refusedScale === scale;
  const [near, setNear] = React.useState(n === 1);
  React.useEffect(() => {
    const observer = new IntersectionObserver(entries => { setNear(entries[0].isIntersecting); }, { root: root.current, rootMargin: '300px' });
    const visible = new IntersectionObserver(entries => { if (entries[0].isIntersecting) onVisible(n); }, { root: root.current, threshold: 0.5 });
    observer.observe(holder.current!); visible.observe(holder.current!);
    return () => { observer.disconnect(); visible.disconnect(); };
  }, [n, root, onVisible]);
  React.useEffect(() => {
    if (!near) return;
    setRefusedScale(undefined);
    const timeout = setTimeout(() => { live = false; render?.cancel(); layer?.cancel(); onError('This PDF page took too long to preview. You can retry or download it.'); }, 15000);
    let live = true, render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined, layer: TextLayer | undefined;
    void (async () => {
      const page = await doc.getPage(n);
      if (!live) return;
      const viewport = page.getViewport({ scale });
      if (viewport.width * viewport.height > 16_000_000) {
        clearTimeout(timeout);
        canvas.current!.width = 0; canvas.current!.height = 0;
        text.current!.replaceChildren();
        setRefusedScale(scale); return;
      }
      const element = canvas.current!, target = text.current!;
      element.width = viewport.width; element.height = viewport.height;
      holder.current!.style.width = `${viewport.width}px`; holder.current!.style.height = `${viewport.height}px`;
      target.replaceChildren(); target.style.setProperty('--scale-factor', String(scale)); target.style.setProperty('--total-scale-factor', String(scale));
      render = page.render({ canvas: element, viewport });
      await render.promise;
      if (!live) return;
      const content = await page.getTextContent();
      if (!live) return;
      if (content.items.length > 50000) throw new Error(READ_FAILURE);
      layer = new TextLayer({ textContentSource: content, container: target, viewport });
      await layer.render();
      clearTimeout(timeout);
    })().catch(() => { clearTimeout(timeout); if (live) onError(READ_FAILURE); });
    return () => { live = false; clearTimeout(timeout); render?.cancel(); layer?.cancel(); canvas.current?.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height); };
  }, [doc, n, scale, near, onError]);
  return <div ref={holder} data-pdf-page={n} aria-label={`Page ${n}`} className="relative mx-auto" style={{ minHeight: 100, width: refused ? '100%' : 612 * scale, height: refused ? 'auto' : 792 * scale }}>{refused && <p role="alert" className="p-4 text-sm">{PDF_CANVAS_LIMIT} Choose a lower zoom to show this page.</p>}<canvas ref={canvas} hidden={refused} aria-label={`PDF page ${n}`} /><div ref={text} hidden={refused} className="textLayer" /></div>;
}
