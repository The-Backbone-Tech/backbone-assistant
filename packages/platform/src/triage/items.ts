// Each run owns its item snapshot. Late writes from an older run cannot replace a newer request.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterialEntry } from '../api.ts';
import { documentPathCollision, type MaterialStore } from '../stub/material.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import type { Connection, Item } from './service.ts';

type Projection = { connection?: Connection | null; items: Record<string, Item>; restorations?: Record<string, Item> };

export const draftNameConflict = (material: MaterialStore, project: string, name: string) =>
  documentPathCollision(name, material.list(project, true).filter(entry => entry.projection === 'managed'));

/** Called after dispatch with no intervening wait: preserve human edits and refuse namespace races. */
export function retainDraft(material: MaterialStore, project: string, document: string, name: string, content: string): { entry: MaterialEntry } | { reason: string } {
  const existing = material.load(document);
  if (existing) {
    if (existing.class !== 'working' || existing.versions.some(version => version.by === 'person') || existing.versions.at(-1)!.sha256 !== sha256(content)) return { reason: 'A current draft already exists; its edits are preserved. Inspect it instead of replacing it.' };
    return { entry: existing };
  }
  const reason = draftNameConflict(material, project, name);
  if (reason) return { reason };
  return { entry: material.create(project, name, 'text/markdown', Buffer.from(content), 'working', 'agent', document) };
}
export function sameMailbox(item: Item, connection?: Connection | null): boolean {
  const owner = item.mailbox ?? item.proposal?.binding;
  return !connection || !!owner && owner.provider === connection.provider && owner.account === connection.account && owner.registration === connection.registration.id;
}

/** Retained uncertainty cannot be bypassed by a reconnect task, revised reply or new document ID. */
export function unsettledDraft(effects: Map<string, { operation: string; status: string; args?: Record<string, unknown> }>, message: { id: string; version: string }, owner: Pick<Connection, 'provider' | 'account'>): boolean {
  return [...effects.values()].some((e) => {
    if (!['unknown', 'dispatching', 'claimed'].includes(e.status) || e.operation !== 'workspace.write_document' || e.args?.message !== message.id || (e.args.message_version && e.args.message_version !== message.version)) return false;
    const mailbox = e.args.mailbox as { provider?: string; account?: string } | undefined;
    return !mailbox || mailbox.provider === owner.provider && mailbox.account === owner.account;
  });
}

export function beginItem(state: Projection, message: Pick<Item, 'id' | 'version' | 'from' | 'subject' | 'date'>, connection: Connection, run: string, order?: number): Item {
  const prior = state.items[message.id];
  const item: Item = prior?.version === message.version && sameMailbox(prior, connection) ? structuredClone(prior) : { id: message.id, version: message.version, from: structuredClone(message.from), subject: message.subject, date: message.date, done: false };
  item.mailbox = { provider: connection.provider, account: connection.account, registration: connection.registration.id };
  item.revision = (prior?.revision ?? 0) + 1;
  item.run = run; item.order = order; item.startedAt = new Date().toISOString(); delete item.needsYou;
  state.items[message.id] = item;
  return item;
}

function itemPath(home: string, item: Item, restoration?: string): string {
  const owner = item.mailbox ?? item.proposal?.binding;
  const key = restoration ?? `${owner?.provider ?? 'legacy'}\0${owner?.account ?? ''}\0${owner?.registration ?? ''}\0${item.id}\0${item.version}\0${item.run ?? 'legacy'}`;
  return join(home, 'triage', restoration ? 'restorations' : 'items', `${sha256(key)}.json`);
}

export function saveItem(home: string, item: Item, restoration?: string) {
  writeJson(itemPath(home, item, restoration), { key: restoration ?? item.id, item });
}

export function loadItems(home: string, local: Projection, disk: Projection, owned = new Set<Item>()): Projection {
  const items: Record<string, Item> = {}, restorations = { ...disk.restorations, ...local.restorations };
  const rank = (i: Item) => `${String(i.order ?? 0).padStart(16, '0')}:${String(i.revision ?? 0).padStart(16, '0')}:${i.done ? 1 : 0}:${i.endedAt ?? ''}`;
  const take = (item: Item) => { if (!sameMailbox(item, local.connection)) return; if (!items[item.id] || rank(item) >= rank(items[item.id])) items[item.id] = item; };
  for (const item of [...Object.values(disk.items), ...Object.values(local.items)]) {
    // Keep legacy aggregate evidence before excluding an unowned item from the current mailbox.
    if (!item.mailbox && !item.proposal?.binding && !existsSync(itemPath(home, item))) saveItem(home, item);
    take(item);
  }
  for (const kind of ['items', 'restorations'] as const) {
    const dir = join(home, 'triage', kind);
    if (existsSync(dir)) for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const saved = readJson<{ key: string; item: Item }>(join(dir, file), {} as never);
      if (kind === 'items') take(saved.item); else restorations[saved.key] = saved.item;
    }
  }
  for (const item of owned) take(item);
  return { items, restorations };
}
