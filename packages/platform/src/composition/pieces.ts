// Loading a piece (docs/repo-design.md, Manifests). The composition recomputes a piece's digest from
// its files on disk, with the core's one algorithm, and refuses a piece whose files are not what its
// manifest declares, or whose content matches no standing registration in the core. Registering is
// the person's act (gov.register_piece, as the person, never as a run the piece carries). The work a
// piece carries is bound to its registration, so the core caps that work by what was registered.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pieceDigest, readManifest, type PieceManifest } from '../pieces/digest.ts';
import { CoreLink, type CoreOptions } from './core.ts';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));
/**
 * The pieces this composition loads, by configuration name: the identity each must declare (fixed
 * here, never taken from the manifest being checked) and its folder in a checkout. A bundled app
 * ships copies and names their folders (HostOptions.pieceDirs).
 */
export const PIECES: Record<string, { id: string; dir: string }> = {
  'harness-pi': { id: 'io.github.albertoangulo/harness-pi', dir: join(PACKAGES, 'modules/harness-pi') },
  'harness-codex': { id: 'io.github.albertoangulo/harness-codex', dir: join(PACKAGES, 'modules/harness-codex') },
  'harness-acp': { id: 'io.github.albertoangulo/harness-acp', dir: join(PACKAGES, 'modules/harness-acp') },
  mcp: { id: 'io.github.albertoangulo/mcp', dir: join(PACKAGES, 'surfaces/mcp') },
  'connector-mail': { id: 'io.github.albertoangulo/connector-mail', dir: join(PACKAGES, 'modules/connector-mail') },
};
export const PIECE_DIRS: Record<string, string> = Object.fromEntries(Object.entries(PIECES).map(([name, p]) => [name, p.dir]));

/** A piece the composition will not load, and why. */
export class PieceRefused extends Error {
  readonly registeredContent: boolean;
  constructor(message: string, registeredContent = false) { super(message); this.registeredContent = registeredContent; }
}

export interface PieceOnDisk {
  dir: string;
  manifest: PieceManifest;
  digest: string;
}

export interface Registration {
  id: string;
  piece: string;
  version: string;
  digest: string;
}

/**
 * A piece as its files are now; refused when they are not the content its manifest's digest
 * declares, or (with `expected`) when the manifest names another piece than the configured one.
 */
export function pieceOnDisk(dir: string, expected?: string): PieceOnDisk {
  const manifest = readManifest(dir);
  if (expected && manifest.id !== expected) {
    throw new PieceRefused(`${dir} declares ${manifest.id}, not the configured piece ${expected}; it is not loaded.`);
  }
  const digest = pieceDigest(dir);
  if (manifest.digest !== digest) {
    throw new PieceRefused(`${manifest.id} in ${dir} is not the content its manifest declares (its files digest to ${digest}, not ${manifest.digest}); it is not loaded.`);
  }
  return { dir, manifest, digest };
}

/** The person registers the piece as it is on disk; registering the same content again returns the same registration. */
export async function registerPiece(link: CoreLink, piece: PieceOnDisk): Promise<Registration> {
  const id = await link.call<string>(link.person(), 'SELECT gov.register_piece($1::jsonb)', [JSON.stringify(piece.manifest)]);
  return { id, piece: piece.manifest.id, version: piece.manifest.version, digest: piece.digest };
}

/** The person registers a piece from its folder, in a data home: how an upgrade is accepted. */
export async function registerPieceIn(options: { home: string; dir: string } & Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>): Promise<Registration> {
  const piece = pieceOnDisk(options.dir);
  const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
  try {
    return await registerPiece(link, piece);
  } finally {
    await link.release();
  }
}

/**
 * The person grants a registered piece their worker's authority: a mandate bound to that
 * registration, which its work never exceeds. A new version or digest needs this again.
 */
export async function grantPieceIn(options: { home: string; dir: string } & Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>): Promise<string> {
  const piece = pieceOnDisk(options.dir);
  const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
  try {
    const { registration } = await loadPiece(link, piece);
    return await link.grantPiece(registration.id);
  } finally {
    await link.release();
  }
}

export interface AddedCapabilities {
  planes: string[];
  operations: string[];
  effectClasses: string[];
  network: string[];
  secrets?: string;
}
export interface PieceUpgrade {
  id: string;
  version: string;
  digest: string;
  previous?: { version: string; digest: string };
  addedCapabilities: AddedCapabilities;
}
export interface PieceUpgradeRecord extends PieceUpgrade {
  at: string;
  reason: 'bundled update within existing permission' | 'person allowed wider capabilities' | 'person allowed configured update';
}

/**
 * One comparison against the newest other version registered here. It counts as the previous version
 * only if it is still registered and still has its grant: when the person's latest decision about this
 * piece was to unregister it or revoke its grant, an older grant is not inherited and they are asked.
 */
export async function pieceUpgrade(link: CoreLink, piece: PieceOnDisk): Promise<PieceUpgrade> {
  const { rows } = await link.read<{ id: string; version: string; digest: string; planes: string[]; operations: string[]; effect_classes: number[]; network: string[]; secrets: string; unregistered_at: string | null }>(
    link.person(),
    'SELECT id, version, digest, planes, operations, effect_classes, network, secrets, unregistered_at FROM app.pieces WHERE piece = $1 AND digest <> $2 ORDER BY registered_at DESC LIMIT 1',
    [piece.manifest.id, piece.digest],
  );
  const caps = (piece.manifest as { capabilities?: Record<string, unknown> }).capabilities ?? {};
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : [];
  const newest = rows[0];
  const previous = newest && !newest.unregistered_at && await link.pieceMandate(newest.id) ? newest : undefined;
  const added = (value: unknown, old: unknown) => list(value).filter(x => !list(old).includes(x));
  return {
    id: piece.manifest.id, version: piece.manifest.version, digest: piece.digest,
    ...(previous ? { previous: { version: previous.version, digest: previous.digest } } : {}),
    addedCapabilities: {
      planes: added(caps.planes, previous?.planes), operations: added(caps.operations, previous?.operations),
      effectClasses: added(caps.effectClasses, previous?.effect_classes), network: added(caps.network, previous?.network),
      ...(caps.secrets && caps.secrets !== 'none' && caps.secrets !== previous?.secrets ? { secrets: String(caps.secrets) } : {}),
    },
  };
}
export const hasAddedCapabilities = (upgrade: PieceUpgrade): boolean => Object.values(upgrade.addedCapabilities).some(value => value.length > 0);

/** Whether changed content fits an existing granted version; used by headless consumers too. */
export async function withinGrantedVersion(link: CoreLink, piece: PieceOnDisk): Promise<boolean> {
  const upgrade = await pieceUpgrade(link, piece);
  return !!upgrade.previous && !hasAddedCapabilities(upgrade);
}

/** The person unregisters a piece; the core refuses while an effect it carried is UNKNOWN. */
export async function unregisterPieceIn(options: { home: string; registration: string } & Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>): Promise<boolean> {
  const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
  try {
    return await link.call<boolean>(link.person(), 'SELECT gov.unregister_piece($1)', [options.registration]);
  } finally {
    await link.release();
  }
}

/**
 * The standing registration a piece on disk loads under. A piece this workspace has never
 * registered is registered for the person on its first use (`firstUse`, only for a piece whose
 * identity the configuration fixes: the caller checked it with pieceOnDisk's `expected`); otherwise
 * content that matches no standing registration (tampered, an upgrade the person has not
 * registered, or one they unregistered) is refused. `firstRegistered` says it was registered now.
 */
export async function loadPiece(link: CoreLink, piece: PieceOnDisk, { firstUse = false } = {}): Promise<{ registration: Registration; firstRegistered: boolean }> {
  const { rows } = await link.read<{ id: string; digest: string; standing: boolean }>(
    link.person(),
    'SELECT id, digest, unregistered_at IS NULL AS standing FROM app.pieces WHERE piece = $1 ORDER BY registered_at',
    [piece.manifest.id],
  );
  if (!rows.length && firstUse) return { registration: await registerPiece(link, piece), firstRegistered: true };
  const match = rows.find((r) => r.standing && r.digest === piece.digest);
  if (!match) {
    throw new PieceRefused(`${piece.manifest.id} ${piece.manifest.version} (${piece.digest}) is not a registered piece in this workspace; the person registers it first (registerPieceIn).`, rows.some(r => r.digest === piece.digest));
  }
  return { registration: { id: match.id, piece: piece.manifest.id, version: piece.manifest.version, digest: piece.digest }, firstRegistered: false };
}
