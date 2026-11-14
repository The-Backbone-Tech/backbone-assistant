// Saves the selected version (current by default) through the browser's own download.
import { call } from './api';

export async function downloadMaterial(id: string, version?: number): Promise<string | undefined> {
  const r = await call('material.read', { id, version });
  if (!r.ok) return r.detail;
  const { entry, text, base64 } = r.value;
  const bytes = base64 !== undefined ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(text ?? '');
  const url = URL.createObjectURL(new Blob([bytes], { type: entry.mediaType || 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: entry.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return undefined;
}
