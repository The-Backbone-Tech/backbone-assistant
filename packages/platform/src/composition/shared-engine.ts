import { AsyncLocalStorage } from 'node:async_hooks';
import type { CredentialStore } from '../credentials/store.ts';
import { ModelRoutes } from '../models/route.ts';
import { engineDecision, governedPolicy } from '../policy/index.ts';
import type { HarnessV1 } from '../ports/harness.ts';
import type { CoreLink } from './core.ts';
import type { HostOptions } from './host-types.ts';
import { HARNESSES, hostToolsOnly, loadHarness, closeHarness } from './harnesses.ts';
import { PIECES, pieceOnDisk } from './pieces.ts';
import { redactWorkText } from '../ports/redaction.ts';
import { SharedEngineRequired } from './identity-core.ts';

type Execution = { engine: HarnessV1; routes: ModelRoutes; id: string; piece: ReturnType<typeof pieceOnDisk>; registration: string | null };
/** A second carrier shares the record, never the device owner's engine or route. */
export function createSharedEngine(options: HostOptions, credentials: CredentialStore, ownerHostToolsOnly: () => boolean) {
  const routes = new ModelRoutes(options.home, credentials, {}, false, false, undefined, undefined, true);
  const scope = new AsyncLocalStorage<Execution>();
  let loaded: Execution | undefined;
  let preparing: Promise<void> | undefined;
  let closing = false, closePromise: Promise<void> | undefined, loadError: string | undefined;
  const configured = () => routes.resolve() !== null;
  const available = () => { try { return !closing && configured() && !!loaded; } catch { return false; } };
  const settings = () => {
    try { return { ...routes.settings(), ...(loadError ? { hint: loadError } : {}), harness: 'Pi' }; }
    catch { return { own: null, gateway: null, local: null, active: null, hint: 'The shared model setting is invalid. Configure a Pi model for shared work.', harness: 'Pi' }; }
  };
  async function prepare(link: CoreLink) {
    if (closing) throw new Error('Shared work is closing. Restart the app or background service.');
    if (!configured()) { loadError = undefined; return; }
    if (loaded) return;
    preparing ??= (async () => {
      const id = 'harness-pi', definition = PIECES[id];
      const piece = pieceOnDisk(options.pieceDirs?.[id] ?? definition.dir, definition.id);
      if (!hostToolsOnly(id, piece.manifest)) throw new SharedEngineRequired();
      const result = await loadHarness(link, piece, options.home, HARNESSES[id], {}, [], options.confirmPieceUpgrade, options.bundledResources, options.pieceUpgradeLog, !link.deviceAvailable);
      if (!result.registration) { await closeHarness(result.engine); throw new Error('The shared engine needs a current registration. Open the app to allow its update.'); }
      loaded = { ...result, routes, id, piece };
      loadError = undefined;
    })();
    try { await preparing; }
    catch (error) {
      let detail = 'The load failed; reopen the app to inspect its configuration.';
      try { detail = redactWorkText(error instanceof Error ? error.message : String(error), await credentials.values()); } catch { /* Never expose an unchecked diagnosis. */ }
      loadError = `Shared engine could not load: ${detail}`;
      throw new Error(loadError);
    } finally { preparing = undefined; }
  }
  return {
    routes, prepare, configured, available, settings,
    loadError: () => loadError,
    current: () => scope.getStore(),
    async run<T>(work: () => Promise<T>, required = false): Promise<T> {
      if (closing) throw new Error('Shared work is closing. Restart the app or background service.');
      let selected: boolean;
      try { selected = configured(); } catch { throw new SharedEngineRequired(); }
      if (!selected) { if (required || !ownerHostToolsOnly()) throw new SharedEngineRequired(); return work(); }
      if (!loaded || !hostToolsOnly(loaded.id, loaded.piece.manifest)) throw new SharedEngineRequired();
      engineDecision(governedPolicy(options.home), loaded.id);
      return scope.run(loaded, work);
    },
    close() { closing = true; return closePromise ??= (async () => { await preparing?.catch(() => {}); await closeHarness(loaded?.engine); loaded = undefined; })(); },
  };
}
