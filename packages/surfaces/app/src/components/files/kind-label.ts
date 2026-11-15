// What a file is, from its name. Pure, so the tree's logic and its tests can use it.
export type FileKind = 'markdown' | 'text' | 'document' | 'spreadsheet' | 'slides' | 'pdf' | 'code' | 'json' | 'image' | 'archive' | 'file';

const BY_EXT: Record<string, FileKind> = {
  md: 'markdown', markdown: 'markdown', txt: 'text', log: 'text',
  doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides', pdf: 'pdf',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', sh: 'code', css: 'code', html: 'code', sql: 'code', yaml: 'code', yml: 'code', toml: 'code',
  json: 'json', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', zip: 'archive', gz: 'archive', tar: 'archive',
};

export function kindOf(name: string): FileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || 'file';
}

export const KIND_LABEL: Record<FileKind | 'folder', string> = {
  markdown: 'Markdown', text: 'Text', document: 'Document', spreadsheet: 'Spreadsheet', slides: 'Slides', pdf: 'PDF',
  code: 'Code', json: 'JSON', image: 'Image', archive: 'Archive', file: 'File', folder: 'Folder',
};

/** Text the editor and reader can open; FileTab chooses supported document previews first. */
export const isText = (name: string, mediaType?: string) => ['markdown', 'text', 'code', 'json'].includes(kindOf(name)) || !!mediaType?.startsWith('text/');
