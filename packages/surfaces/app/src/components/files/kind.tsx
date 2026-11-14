// The icon that shows what a file is. The name carries the same information; the tone only aids recognition.
import { File, FileArchive, FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, type LucideIcon, Presentation } from 'lucide-react';
import { cn } from '../../lib/utils';
import { type FileKind, kindOf } from './kind-label';

export { type FileKind, isText, KIND_LABEL, kindOf } from './kind-label';

const ICON: Record<FileKind, [LucideIcon, string]> = {
  markdown: [FileText, 'text-muted'],
  text: [FileText, 'text-muted'],
  document: [FileText, 'text-file-blue'],
  spreadsheet: [FileSpreadsheet, 'text-file-green'],
  slides: [Presentation, 'text-file-violet'],
  pdf: [FileText, 'text-file-red'],
  code: [FileCode2, 'text-file-amber'],
  json: [FileJson, 'text-file-amber'],
  image: [FileImage, 'text-file-violet'],
  archive: [FileArchive, 'text-muted'],
  file: [File, 'text-muted'],
};

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const [Icon, tone] = ICON[kindOf(name)];
  return <Icon aria-hidden className={cn('size-4 shrink-0', tone, className)} />;
}

