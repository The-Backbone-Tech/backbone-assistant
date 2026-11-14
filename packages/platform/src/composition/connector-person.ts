// Trusted native person boundary. These methods are absent from Host.call and every engine port.
import type { Receipt, ConnectorEffectQuestion } from '../api.ts';
import type { ConnectorService } from '../connectors/service.ts';
import type { Host } from './host-types.ts';
const refused = <T>(detail: string): Receipt<T> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const named = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1024;
const exactCall = (effect: unknown, hash: unknown) => typeof effect === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(effect) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
type PersonMethods = 'connectorCatalogue' | 'releaseConnectorCall' | 'connectorEffectDecisions' | 'endConnectorSignature' | 'openConnectorDoor' | 'markConnectorToolRead' | 'signConnectorTool';
export function connectorPerson(options: { connectors: ConnectorService; owner: Promise<unknown>; core: Promise<unknown>; unavailable(): string | undefined; enter(): () => void }): Pick<Host, PersonMethods> {
  const { connectors } = options;
  // A late native answer is refused before its arguments are inspected. run rechecks after waits.
  function admit<T>(work: () => Promise<Receipt<T>>): Promise<Receipt<T>> {
    const unavailable = options.unavailable();
    return unavailable ? Promise.resolve(refused(unavailable)) : work();
  }
  async function run<T>(work: () => Promise<Receipt<T>>, needsCore = true, failure?: Receipt<T>, rejection?: string): Promise<Receipt<T>> {
    const before = options.unavailable(); if (before) return refused(before);
    const leave = options.enter();
    try {
      await options.owner;
      const owned = options.unavailable(); if (owned) return refused(owned);
      if (needsCore) await options.core;
      const after = options.unavailable(); if (after) return refused(after);
      return await work();
    } catch { if (rejection) throw new Error(rejection); return failure ?? refused('The connector decision could not be confirmed. Inspect its receipt before trying again.'); }
    finally { leave(); }
  }
  return {
    connectorCatalogue: {
      connect: (id, app, open, preset) => admit(() => run(() => connectors.catalogue.connect(id, app, open, preset), false)),
      finish: id => admit(() => run(() => connectors.catalogue.finish(id), false)),
      question: id => admit(() => run(async () => connectors.catalogue.question(id), false)),
      activate: (id, preset, stamp) => admit(() => run(() => connectors.catalogue.activate(id, preset, stamp))),
      disconnect: id => admit(() => run(() => connectors.catalogue.disconnect(id), false)),
    },
    releaseConnectorCall: (effect, hash) => admit(() => exactCall(effect, hash) ? run(() => connectors.decide(effect, hash, 'release')) : Promise.resolve(refused('No call on that exact statement.'))),
    connectorEffectDecisions: {
      question: (effect, hash) => admit(() => !exactCall(effect, hash) ? Promise.resolve(refused('No unknown call on that exact statement.')) : run<ConnectorEffectQuestion>(async () => {
        const question = await connectors.unknownQuestion(effect, hash);
        if (!question.ok) return question;
        return connectors.list().held.some(h => h.effect === effect && h.argsHash === hash && h.state === 'unknown') ? question : refused('That call is not an unresolved unknown.');
      })),
      resolve: input => admit(() => exactCall(input?.effect, input?.argsHash) && ['happened', 'did_not_happen', 'keep_closed'].includes(input?.answer)
        ? run(() => connectors.resolveUnknown(input.effect, input.argsHash, input.answer)) : Promise.resolve(refused('No unknown call with that answer.'))),
    },
    endConnectorSignature: (server, tool) => admit(() => named(server) && named(tool) ? run(() => connectors.endStoredSignature(server, tool), false, { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'The signature end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.' }) : Promise.resolve(refused('A server and tool of at most 1024 characters each are required.'))),
    openConnectorDoor: (server, seal) => admit(() => named(server) && named(seal) ? run(() => connectors.set(server, { egress: true, seal })) : Promise.resolve(refused('No such connection.'))),
    markConnectorToolRead: (server, tool, asServer = false) => admit(() => named(server) && named(tool) && typeof asServer === 'boolean'
      ? run(() => connectors.set(server, { tool: { name: tool, override: asServer ? null : 'read' } })) : Promise.resolve(refused('No such tool.'))),
    signConnectorTool: (server, tool, seal, stamp, blockedToo = false) => admit(() => [server, tool, seal, stamp].every(named) && typeof blockedToo === 'boolean'
      ? run(() => connectors.set(server, { seal, tool: { name: tool, standing: { stamp, blockedToo } } }), true, undefined, 'The Core signature could not be confirmed. Inspect its receipt before trying again.') : Promise.resolve(refused('No such tool as shown.'))),
  };
}
