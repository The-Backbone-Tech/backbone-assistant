// The one screen on which the person signs the mail triage capability, owned by the main process
// (as Settings › Assistants using this app is). Main reads the offer itself, shows a summary of the signed payload
// and its hash in its own native window, and on Sign asks the operating system for the person's
// presence: Touch ID where the Mac has it, else the system's own authentication prompt for the
// session's owner. Only then does it sign, naming the hash it showed. The renderer can only ask for
// this flow to start; signing is not a method of the transport it reaches, nor of the MCP door.
import { execFile } from 'node:child_process';
import { type BrowserWindow, dialog, type MessageBoxOptions, systemPreferences } from 'electron';
import type { CapabilityView, Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { brand } from '../src/brand';

const refused = (detail: string): Receipt<CapabilityView> => ({ ok: false, reason: 'NOT_AVAILABLE', detail, outcome: 'REFUSED' });

/** Touch ID, or the system's authentication prompt for the session's owner. Anything short of proof refuses. */
async function presence(reason: string): Promise<'touch-id' | 'device-password' | null> {
  if (process.platform !== 'darwin') return null;
  if (systemPreferences.canPromptTouchID()) {
    try {
      await systemPreferences.promptTouchID(reason);
      return 'touch-id';
    } catch {
      return null;
    }
  }
  // Authorization Services' own dialog, for the right that authenticates the session's owner.
  // Not verified on a Mac without Touch ID: if it fails in any way, nothing is signed.
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['authorize', '-u', 'authenticate-session-owner'], { timeout: 120_000 }, (error) => resolve(error ? null : 'device-password'));
  });
}

export async function confirmAndSign(host: Host, win: BrowserWindow | null): Promise<Receipt<CapabilityView>> {
  const view = await host.call('triage.get', {});
  const offer = view.offer;
  if (!view.connection) return refused('Connect the mailbox first.');
  if (!offer) return refused('There is no new permission to give: this permission already applies.');
  const show = (o: MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  const asked = await show({
    type: 'question',
    title: 'Give mail triage permission',
    message: offer.again ? `Give mail triage permission again?` : `Let ${brand.name} triage your mail?`,
    detail: `${offer.summary.join('\n')}${offer.widening.length ? `\n\nThis widens: ${offer.widening.join(', ')}.` : ''}\n\nPayload hash: sha256:${offer.hash}\n\nYou give this permission once. Every action afterwards still carries its own receipt; anything outside it waits for you. You can revoke it at any time.`,
    buttons: ['Permit…', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (asked.response !== 0) return refused('Not permitted: you cancelled.');
  const proved = await presence('give mail triage permission');
  if (!proved) return refused('Not permitted: your presence was not confirmed.');
  return host.signCapability({ hash: offer.hash, presence: proved });
}
