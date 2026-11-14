// Product resources only: these reads never open a data folder or contact a service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NoticeEntry {
  id: string;
  name: string;
  version: string;
  license: string;
  format: 'text' | 'html';
  file: string;
  sha256: string;
}
export interface NoticeText extends NoticeEntry { text: string }

export function listNotices(directory: string): NoticeEntry[] {
  let index: { schema?: unknown; entries?: unknown };
  try { index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')); }
  catch { throw new Error('Bundled notices are unavailable. Build or reinstall this product.'); }
  if (index.schema !== 1 || !Array.isArray(index.entries) || !index.entries.length) throw new Error('Invalid bundled notices index.');
  const seen = new Set<string>();
  for (const entry of index.entries) {
    if (!entry || !['id', 'name', 'version', 'license', 'file', 'sha256'].every(key => typeof entry[key] === 'string' && entry[key].length) ||
        !['text', 'html'].includes(entry.format) || !/^\d+\.(txt|html)$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.id)) throw new Error('Invalid bundled notice entry.');
    seen.add(entry.id);
  }
  return index.entries as NoticeEntry[];
}

export function readNotice(directory: string, id: string): NoticeText {
  const entry = listNotices(directory).find(entry => entry.id === id);
  if (!entry) throw new Error('Bundled notice not found.');
  const text = readFileSync(join(directory, entry.file), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== entry.sha256) throw new Error('Bundled notice digest differs from the build.');
  return { ...entry, text };
}
