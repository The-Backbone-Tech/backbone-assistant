import type { HomePort } from './lifecycle/port.ts';
import type { JourneyPort } from './journey/port.ts';
import type { ScenePort } from './scenes/port.ts';

/**
 * The behaviour oracle's target: a whole running Backbone, reached the way people and operators
 * reach it. Three ports, one per area, each defined beside its cases:
 * - `scenes` — attack scenarios: a world with people, connected outside servers and the scripted
 *   adversary; judged from what reached the outside world and what the database lets people read.
 * - `homes` — the command line's lifecycle on a scratch Home: export and import, ledger
 *   verification, backup and restore.
 * - `journeys` — J-01 through the service's HTTP API, with restarts and kills.
 */
export interface BehaviourTarget {
  readonly name: string;
  readonly scenes: ScenePort;
  readonly homes: HomePort;
  readonly journeys: JourneyPort;
  /** How each step was implemented since the last drain (for the report). */
  drainUsage(): BehaviourUse[];
}

/**
 * How an adapter implemented one step of a behaviour case:
 * - `api`: the service's public HTTP API, as an app would call it;
 * - `process`: the command line run as its own process, or the service process started, stopped or killed;
 * - `crossing` / `governed-write` / `view`: as in the core oracle (a view reads as a session, under its grants);
 * - `observer`: a read-only look below every grant (the administrator), only to judge;
 * - `clock`: the one change to the world itself, time passing;
 * - `operator` / `adversary`: as in the core oracle.
 */
export type BehaviourKind = 'api' | 'process' | 'crossing' | 'governed-write' | 'view' | 'observer' | 'clock' | 'operator' | 'adversary';

export interface BehaviourUse {
  readonly name: string;
  readonly kind: BehaviourKind;
}
