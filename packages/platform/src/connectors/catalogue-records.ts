// Content-free installation ownership survives a deleted or malformed servers.json entry.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import type { CatalogueId } from '../api-catalogue.ts';
import { catalogueEnvelope, type CatalogueEnvelope } from './catalogue-store.ts';
import type { CatalogueRevocation } from './catalogue-revocation.ts';
interface Records { installs: Partial<Record<CatalogueId, CatalogueEnvelope>>; receipts: { id: CatalogueId; instance: string; at: string; revocation: CatalogueRevocation; reason: 'disconnect' | 'install-failed' }[] }
export function catalogueRecords(home: string): Records {
  const file = join(home, 'connectors', 'catalogue-installs.json');
  if (!existsSync(file)) return { installs: {}, receipts: [] };
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Records> | null;
  const installs: Records['installs'] = {};
  // This index is writable home data, not proof of credential ownership.
  for (const id of ['calendar', 'drive', 'github', 'slack'] as const) {
    const entry = data?.installs?.[id];
    if (catalogueEnvelope(entry) && entry.id === id) installs[id] = entry;
  }
  return { installs, receipts: Array.isArray(data?.receipts) ? data.receipts : [] };
}
/** Caller holds the home lock. This file contains handles and outcomes, never credentials. */
export function saveCatalogueRecords(home: string, records: Records) {
  const root = join(home, 'connectors');
  assertHomeWriteAdmission(home, root); mkdirSync(root, { recursive: true, mode: 0o700 });
  assertHomeWriteAdmission(home, root); writeDurable(join(root, 'catalogue-installs.json'), JSON.stringify(records));
}
