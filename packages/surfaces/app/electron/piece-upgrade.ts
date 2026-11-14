// Main-process presentation of the platform's one manifest comparison; no permission decisions here.
import type { PieceUpgrade } from '@backbone-next/platform/composition/pieces';

const words = (value: string) => value.replace(/[._-]+/g, ' ');
export function pieceUpgradeDialog(brand: string, piece: PieceUpgrade) {
  const added = piece.addedCapabilities;
  const native = added.operations.includes('native.account_tools') || added.network.includes('native-codex-account-tools-in-full');
  const engine = piece.id.endsWith('/harness-codex') ? 'Codex engine' : 'engine';
  const changes: string[] = [];
  if (native) changes.push('use the connectors, plugins and MCP servers of your own Codex app (mail, calendar, files) when a chat has Full access');
  if (added.planes.length) changes.push(`work in these areas: ${added.planes.map(words).join(', ')}`);
  const operations = added.operations.filter(value => value !== 'native.account_tools');
  if (operations.length) changes.push(`perform these actions: ${operations.map(words).join(', ')}`);
  const network = added.network.filter(value => value !== 'native-codex-account-tools-in-full');
  if (network.length) changes.push(`connect to ${network.join(', ')}`);
  // Class 6 is the declared ceiling of native account tools, already explained above.
  const classes = added.effectClasses.filter(value => !native || value !== '6');
  if (classes.length) changes.push(`perform actions at additional effect levels (${classes.join(', ')})`);
  if (added.secrets) changes.push(`use secrets from ${words(added.secrets)}`);
  return {
    type: 'question' as const, buttons: ['Allow', "Don't allow"], defaultId: 1, cancelId: 1,
    message: changes.length ? `${brand}'s ${engine} can now ${changes.join('; ')}. Allow?`
      : `${brand} was updated. Allow its new ${engine} to work in this data folder?`,
    detail: `${native ? 'With Full access this includes sending, changing and deleting in those accounts without asking each time, also in scheduled and delegated work. ' + brand + ' shows each call as a step but holds no receipt for it.\n\n' : ''}${piece.id} ${piece.version}\ncontent ${piece.digest}\n\nWork begun under the earlier version keeps that version's terms and is not resumed by this one. If you don't allow it, this engine is not opened and its registration and permission stay unchanged. To get the previous version back, quit the app and reinstall the previous app version with the same data folder.`,
  };
}

// A quit can race an Allow response; withdrawal never grants the update.
export const upgradeAnswer = (response: number, withdrawn: boolean) => !withdrawn && response === 0;

// Static markup with escaped manifest text; the window has no Node or preload access.
export function upgradeQuestionPage(message: string, detail: string) {
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Engine update</title><style>
    body { font: 14px -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; color: #222; background: #f8f8f8; }
    h1 { font-size: 16px; } p { white-space: pre-wrap; line-height: 1.4; } .buttons { display: flex; justify-content: flex-end; gap: 10px; }
    a { color: inherit; text-decoration: none; border: 1px solid #999; border-radius: 6px; padding: 6px 16px; background: white; }
    a:focus { outline: 2px solid #1677ff; } @media (prefers-color-scheme: dark) { body { background: #292929; color: #eee; } a { background: #444; } }
  </style></head><body><h1>${escape(message)}</h1><p>${escape(detail)}</p><div class="buttons"><a href="https://backbone.invalid/decline" autofocus>Don't allow</a><a href="https://backbone.invalid/allow">Allow</a></div></body></html>`;
}
