// Stable job identity is a source fact, not a grant. Callers hold the existing authority lock.
import { join } from 'node:path';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import type { Connection } from './service.ts';

type Owner = { provider: string; account: string };
type Anchor = Owner & { format: 'triage-mailbox/1'; workspace: string; agent: string; task: string; projectId: string };
const pathOf = (home: string, workspace: string, owner: Owner) => join(home, 'triage', 'mailboxes', `${sha256(JSON.stringify([workspace, owner.provider, owner.account]))}.json`);

export function mailboxAnchor(home: string, workspace: string, owner: Owner): Anchor | null {
  const saved = readJson<Anchor | null>(pathOf(home, workspace, owner), null);
  if (saved && (saved.format !== 'triage-mailbox/1' || saved.workspace !== workspace || saved.provider !== owner.provider || saved.account !== owner.account || !saved.agent || !saved.task || !saved.projectId)) throw new Error('The mailbox job identity does not match this workspace/account.');
  return saved;
}

export function rememberMailbox(home: string, workspace: string, connection: Connection) {
  if (mailboxAnchor(home, workspace, connection)) return;
  const { provider, account, agent, task, projectId } = connection;
  writeJson(pathOf(home, workspace, connection), { format: 'triage-mailbox/1', workspace, provider, account, agent, task, projectId });
}
