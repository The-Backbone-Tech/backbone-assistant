import * as React from 'react';
import type { HeldAttachment } from '../../lib/connector-attachments';
import { exactText } from '../../lib/connector-call';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';

const label = (value: string) => exactText(value).slice(1, -1);

function OpenAttachment({ file, close }: { file: HeldAttachment; close(): void }) {
  const [url, setUrl] = React.useState<string>();
  React.useEffect(() => {
    const next = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
    setUrl(next); return () => URL.revokeObjectURL(next);
  }, [file]);
  let text: string | undefined;
  try { if (/^(text\/|application\/(json|xml)$)/.test(file.mime)) text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { /* Binary files have a byte view and exact-byte download. */ }
  const image = /^image\/(png|jpeg|gif|webp)$/.test(file.mime);
  const preview = text === undefined ? [...file.bytes.subarray(0, 65_536)].map(b => b.toString(16).padStart(2, '0')).join(' ')
    : text.slice(0, 65_536).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, char => exactText(char).slice(1, -1));
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent title={label(file.filename)} description={`${label(file.mime)} · ${file.bytes.byteLength} bytes`} className="max-w-3xl">
      {image ? <img className="max-h-[60dvh] max-w-full object-contain" alt={label(file.filename)} src={`data:${file.mime};base64,${file.content}`} />
        : <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-all text-xs" aria-label={text === undefined ? 'Attachment bytes in hexadecimal' : 'Attachment text'}>{preview}</pre>}
      {!image && (text?.length ?? file.bytes.length) > 65_536 && <p className="text-xs text-muted">Preview limited to 65,536 {text === undefined ? 'bytes' : 'characters'}. Save the attachment to read all of it.</p>}
      <div className="mt-4 flex gap-3">
        {url && <a className="text-xs underline" href={url} download={file.filename}>Save attachment</a>}
        <DialogClose asChild><Button size="sm" variant="outline">Close preview</Button></DialogClose>
      </div>
    </DialogContent>
  </Dialog>;
}

/** Preview stays inside the app: HTML/SVG are text, never executable pages or external URLs. */
export function HeldAttachments({ files }: { files: HeldAttachment[] }) {
  const [opened, setOpened] = React.useState<HeldAttachment>();
  return <>
    {files.map(file => <span key={file.index} className="mt-1 block" data-testid="held-attachment">
      {label(file.filename)} · {label(file.mime)} · {file.bytes.byteLength} bytes{' '}
      <Button size="sm" variant="outline" onClick={() => setOpened(file)}>Open attachment {label(file.filename)}</Button>
    </span>)}
    {opened && <OpenAttachment file={opened} close={() => setOpened(undefined)} />}
  </>;
}
