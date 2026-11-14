// Loading pieces (docs/repo-design.md, Manifests) over the real core in fresh data homes: the
// composition recomputes a piece's digest from its files and refuses one that is not what was
// declared and registered; the work a piece carries is bound to its registration, so the core caps
// it by the piece's declaration whatever the person's grant allows; an upgrade needs a new grant.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { CoreLink } from '../src/composition/core.ts';
import { grantDoor, openGateway } from '../src/composition/gateway.ts';
import { outboxExecutor } from '../src/composition/outbox.ts';
import { grantPieceIn, PIECE_DIRS, registerPieceIn } from '../src/composition/pieces.ts';
import type { Gateway, GatewayResult } from '../src/gateway.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { hostClosed } from '../src/composition/host.ts';
import { b64, freshDir, freshHome, idle, open, settings, value } from './helpers.ts';

const copies: string[] = [];
const gateways: Gateway[] = [];
let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  for (const g of gateways) await g.close();
  for (const c of copies) rmSync(c, { recursive: true, force: true });
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

/** A copy of a piece's files (exactly those its digest covers) in a folder of its own, its dependencies linked beside them. */
function copyOf(name: string): string {
  const from = PIECE_DIRS[name];
  const dir = mkdtempSync(join(tmpdir(), `backbone-piece-${name}-`));
  copies.push(dir);
  for (const f of pieceFiles(from)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(from, f), join(dir, f));
  }
  if (existsSync(join(PIECE_DIRS[name], 'node_modules'))) symlinkSync(realpathSync(join(PIECE_DIRS[name], 'node_modules')), join(dir, 'node_modules'));
  return dir;
}
/** Replace words in one of a copy's files. */
function edit(dir: string, file: string, from: string, to: string) {
  const before = readFileSync(join(dir, file), 'utf8');
  assert.ok(before.includes(from), `${from} is not in ${file}`);
  writeFileSync(join(dir, file), before.replace(from, to));
}
const tamper = (dir: string, file: string) => writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}\n// changed after it was registered\n`);
/** Rewrite the manifest (and its digest, as a forger or an upgrade would) so the files agree with it again. */
function redeclare(dir: string, change: (m: Record<string, any>) => void = () => {}) {
  const path = join(dir, 'backbone.module.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  change(m);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(path, `${JSON.stringify({ ...m, digest: pieceDigest(dir) }, null, 2)}\n`);
}
const receipt = <T>(r: GatewayResult<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.detail}`);
  return r.value;
};
async function door(home: string, grant: string, piece: string, executors = { 'outbox.write': outboxExecutor(home), 'outbox.other': outboxExecutor(home) }) {
  const g = await openGateway({ home, grant, piece, executors });
  gateways.push(g);
  return g;
}
const write = (operation: string, key: string) => ({ operation, args: { name: `${key}.txt`, content: key }, description: key, idempotencyKey: key });
// Two data homes for the whole file (one for Pi, one for the door), so the suite starts few clusters
// beside the other files that run in parallel. Cases run in order and build on each other.
const piHome = freshHome();
const doorHome = freshHome();
let piHost: ReturnType<typeof open>['host'] | undefined;

async function runsOf(home: string): Promise<{ piece_id: string | null; piece: string | null; digest: string | null }[]> {
  const link = await CoreLink.open({ home });
  try {
    return (await link.read<{ piece_id: string | null; piece: string | null; digest: string | null }>(
      link.person(),
      'SELECT r.piece_id, p.piece, p.digest FROM app.runs r LEFT JOIN app.pieces p ON p.id = r.piece_id ORDER BY r.created_at',
    )).rows;
  } finally {
    await link.release();
  }
}

test('Pi loads under its registration, and every run it carries is bound to it', async () => {
  const { host } = open(piHome, { harness: 'harness-pi' });
  piHost = host;
  const p = value(await host.call('projects.create', { name: 'Brief', kind: 'folder' }));
  const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('# Revenue\nUp 4%.\n'), mediaType: 'text/markdown' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief from these', attachments: [note.id], settings, clientKey: 'c1' }));
  await idle(host, sent.threadId);
  const runs = await runsOf(piHome);
  assert.ok(runs.length > 0);
  assert.deepEqual(runs.map((r) => r.digest), runs.map(() => pieceDigest(PIECE_DIRS['harness-pi'])));
});

test('a tampered Pi file refuses to load, and so does a forged manifest the person never registered', async () => {
  piHost?.close();
  const pi = copyOf('harness-pi');
  // The copy is the registered content, so it loads.
  const first = open(piHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': pi } }).host;
  await first.call('projects.list', {});
  first.close();
  tamper(pi, 'src/index.ts');
  assert.throws(() => open(piHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': pi } }), /not the content its manifest declares/);
  redeclare(pi);
  const forged = open(piHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': pi } }).host;
  await assert.rejects(forged.call('projects.list', {}), /not a registered piece/);
});

test('an operation the door did not declare is refused, although the grant allows it', async () => {
  await grantDoor({ home: doorHome, name: 'wide', operations: ['outbox.write', 'outbox.other'], ceiling: 4 });
  const g = await door(doorHome, 'wide', PIECE_DIRS.mcp);
  assert.equal(receipt(await g.call('effects.propose', write('outbox.write', 'w-1'))).outcome, 'DONE');
  const outside = receipt(await g.call('effects.propose', write('outbox.other', 'o-1')));
  assert.equal(outside.outcome, 'REFUSED');
  assert.equal(outside.reason, 'outside_piece');
});

test('a door whose files changed after its grant does not open: tampered, forged or upgraded, it needs a new grant', async () => {
  const mcp = copyOf('mcp');
  await grantDoor({ home: doorHome, name: 'pinned', operations: ['outbox.write', 'outbox.other'], ceiling: 3, piece: mcp });
  receipt(await (await door(doorHome, 'pinned', mcp)).call('effects.list', {}));
  tamper(mcp, 'src/tools.ts');
  await assert.rejects(door(doorHome, 'pinned', mcp), /not the content its manifest declares/);
  // An upgrade that declares more: the person registers it, and the live grant still does not take it.
  redeclare(mcp, (m) => {
    m.version = '0.0.1';
    m.capabilities.operations = ['outbox.write', 'outbox.other'];
  });
  await assert.rejects(door(doorHome, 'pinned', mcp), /not a registered piece/);
  await registerPieceIn({ home: doorHome, dir: mcp });
  await assert.rejects(door(doorHome, 'pinned', mcp), /granted for another version or content/);
  await grantDoor({ home: doorHome, name: 'regranted', operations: ['outbox.write', 'outbox.other'], ceiling: 3, piece: mcp });
  const g = await door(doorHome, 'regranted', mcp);
  assert.equal(receipt(await g.call('effects.propose', write('outbox.other', 'r-1'))).outcome, 'DONE');
});

test('a class above the door\'s declared ceiling is refused, although the grant\'s ceiling allows it', async () => {
  // Last in this home: the person raises outbox.write to class 4 for every grant here.
  await grantDoor({ home: doorHome, name: 'high', operations: ['outbox.write'], ceiling: 4 });
  const link = await CoreLink.open({ home: doorHome });
  await link.read(link.person(), 'SELECT * FROM gov.classify_operations($1::jsonb)', [JSON.stringify([{ operation: 'outbox.write', class: 4, external: true }])]);
  await link.release();
  const g = await door(doorHome, 'high', PIECE_DIRS.mcp);
  const above = receipt(await g.call('effects.propose', write('outbox.write', 'h-1')));
  assert.equal(above.outcome, 'REFUSED');
  assert.equal(above.reason, 'above_piece_ceiling');
});

// Pi is loaded from the folder that was checked, after the check: its module never runs before.
const MARKER = join(mkdtempSync(join(tmpdir(), 'backbone-marker-')), 'ran.txt');
copies.push(dirname(MARKER));
const ran = () => (existsSync(MARKER) ? readFileSync(MARKER, 'utf8').split('\n').filter(Boolean) : []);
/** A Pi copy whose engine names itself `label` and, when its module runs, leaves `label` in MARKER. */
function piCopy(label: string): string {
  const dir = copyOf('harness-pi');
  edit(dir, 'src/index.ts', 'label: `Pi ${PI_VERSION}`', `label: \`${label} \${PI_VERSION}\``);
  writeFileSync(join(dir, 'src/index.ts'), `import { appendFileSync as markRan } from 'node:fs';\nmarkRan(${JSON.stringify(MARKER)}, ${JSON.stringify(`${label}\n`)});\n${readFileSync(join(dir, 'src/index.ts'), 'utf8')}`);
  redeclare(dir);
  return dir;
}
// These cases continue in the door's home (no Pi there yet), in order; the last one also takes the stub's interrupted turn.
const upgradeHome = doorHome;
let upgraded = '';

test('the code that runs is the code that was checked, imported only after the check passed', async () => {
  const checked = piCopy('Pi checked');
  const host = open(upgradeHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': checked } }).host;
  assert.match((await host.call('settings.model.get', {})).harness, /^Pi checked /);
  assert.deepEqual(ran(), ['Pi checked']);
  host.close();
  // Changed again (and its manifest forged to match) in a folder never loaded: refused before its module runs.
  const forged = piCopy('Pi forged');
  const refused = open(upgradeHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': forged } }).host;
  await assert.rejects(refused.call('projects.list', {}), /not a registered piece/);
  assert.deepEqual(ran(), ['Pi checked']);
});

test('a harness whose manifest names another piece is never registered on first use, and never loads', async () => {
  const renamed = piCopy('Pi renamed');
  edit(renamed, 'backbone.module.json', '"id": "io.github.albertoangulo/harness-pi"', '"id": "io.github.albertoangulo/harness-other"');
  redeclare(renamed);
  const home = freshHome();
  assert.throws(() => open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': renamed } }), /not the configured piece/);
  assert.throws(() => open(upgradeHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': renamed } }), /not the configured piece/);
  assert.ok(!ran().includes('Pi renamed'));
});

test('an upgrade the person registered is not used until the person grants it: the host never widens its own mandate', async () => {
  upgraded = piCopy('Pi upgraded');
  edit(upgraded, 'backbone.module.json', '"version": "0.0.0"', '"version": "0.0.1"');
  edit(upgraded, 'package.json', '"version": "0.0.0"', '"version": "0.0.1"');
  redeclare(upgraded);
  await registerPieceIn({ home: upgradeHome, dir: upgraded });
  const before = open(upgradeHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': upgraded } }).host;
  await assert.rejects(before.call('projects.list', {}), /has no grant/);
  assert.ok(!ran().includes('Pi upgraded'));
  await grantPieceIn({ home: upgradeHome, dir: upgraded });
  const after = open(upgradeHome, { harness: 'harness-pi', pieceDirs: { 'harness-pi': upgraded } }).host;
  assert.match((await after.call('settings.model.get', {})).harness, /^Pi upgraded /);
  const link = await CoreLink.open({ home: upgradeHome });
  try {
    const { rows } = await link.read<{ version: string; n: number }>(
      link.person(),
      `SELECT p.version, count(*)::int AS n FROM app.mandates m JOIN app.pieces p ON p.id = m.piece_id
       WHERE m.revoked_at IS NULL AND p.piece = 'io.github.albertoangulo/harness-pi' GROUP BY 1 ORDER BY 1`,
    );
    assert.deepEqual(rows, [{ version: '0.0.0', n: 1 }, { version: '0.0.1', n: 1 }]);
  } finally {
    await link.release();
  }
  after.close();
  await hostClosed(upgradeHome); // The next test's child opens this home.
});

test('a turn interrupted on another harness is not resumed by Pi under its run', async () => {
  const home = upgradeHome;
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-turn.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-stub', BACKBONE_CRASH_AT: 'write.begun' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  assert.equal(await new Promise<number | string | null>((r) => child.on('exit', (c, sig) => r(c ?? sig))), 'SIGKILL', out);
  const { threadId } = JSON.parse(out.trim().split('\n').at(-1)!) as { threadId: string };
  const requests = model.requests.length;
  const { host } = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': upgraded } });
  await new Promise((r) => setTimeout(r, 7000)); // the dead run's lease lapses before a resume would claim it
  const turn = (await idle(host, threadId)).turns[0];
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /another harness/);
  assert.equal(model.requests.length, requests, 'Pi never ran the stub\'s run');
  const runs = (await runsOf(home)).filter((r) => r.piece !== 'io.github.albertoangulo/mcp');
  assert.deepEqual(runs.map((r) => r.piece_id), [null]);
});

test('deniedFolders in settings.json is absent or a list of folder paths for the native engine; anything else refuses the host before an engine starts', async () => {
  const { createHost, deniedFoldersOf } = await import('../src/composition/host.ts');
  const at = (settings: unknown) => { const h = freshDir('backbone-denied-'); writeFileSync(join(h, 'settings.json'), JSON.stringify(settings)); return h; };
  assert.deepEqual(deniedFoldersOf(at({}), 'harness-codex'), []);
  assert.deepEqual(deniedFoldersOf(at({ deniedFolders: ['/srv/scoring'] }), 'harness-codex'), ['/srv/scoring']);
  for (const bad of ['/srv/scoring', { a: '/srv' }, null, ['/srv', 3]]) assert.throws(() => deniedFoldersOf(at({ deniedFolders: bad }), 'harness-codex'), /must be a list of folder paths/, JSON.stringify(bad));
  assert.throws(() => deniedFoldersOf(at({ deniedFolders: ['/srv/scoring'] }), 'harness-pi'), /needs an engine with path-deny support/);
  assert.throws(() => createHost({ home: at({ deniedFolders: '/srv/scoring' }), harness: 'harness-stub' }), /must be a list of folder paths/, 'the host itself refuses, before any engine');
});

test('an app update\'s changed engine works in an existing home only on the person\'s yes in main, and only that content', async () => {
  const home = freshHome();
  const first = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': piCopy('Pi before update') } }).host;
  await first.call('projects.list', {});
  first.close();
  const updated = piCopy('Pi after update');
  const asked: string[] = [];
  const refusedWithout = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': updated } }).host;
  await assert.rejects(refusedWithout.call('projects.list', {}), /not a registered piece/, 'no dialog: refused as before');
  refusedWithout.close();
  const declined = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': updated }, confirmPieceUpgrade: async (p) => { asked.push(p.digest); return false; } }).host;
  await assert.rejects(declined.call('projects.list', {}), /not a registered piece/, 'the person said no');
  declined.close();
  assert.ok(!ran().includes('Pi after update'), 'nothing of it ran');
  const allowed = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': updated }, confirmPieceUpgrade: async (p) => { asked.push(p.digest); return true; } }).host;
  await allowed.call('projects.list', {});
  assert.match((await allowed.call('settings.model.get', {})).harness, /^Pi after update /);
  allowed.close();
  assert.equal(new Set(asked).size, 1, 'asked about exactly the new content');
  assert.equal(asked[0], pieceDigest(updated));
});

test('a wider update asks once, names added capabilities and registers only on Allow', async () => {
  const home = freshHome();
  const first = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': piCopy('Pi narrow') } }).host;
  await first.call('projects.list', {}); first.close();
  const wider = piCopy('Pi wider');
  redeclare(wider, m => { m.capabilities.operations.push('native.account_tools'); m.capabilities.effectClasses.push(6); });
  const headless = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': wider }, bundledResources: dirname(wider) }).host;
  await assert.rejects(headless.call('projects.list', {}), /not a registered piece[\s\S]*Open the app once to allow the update/); headless.close();
  for (const allow of [false, true]) {
    const asked: unknown[] = [];
    const logs: any[] = [];
    const host = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': wider }, bundledResources: dirname(wider), pieceUpgradeLog: e => logs.push(e), confirmPieceUpgrade: async p => { asked.push(p); return allow; } }).host;
    if (allow) await host.call('projects.list', {});
    else await assert.rejects(host.call('projects.list', {}), /not a registered piece/);
    host.close();
    assert.equal(asked.length, 1);
    assert.equal(logs.length, allow ? 1 : 0);
    if (allow) {
      assert.equal(logs[0].reason, 'person allowed wider capabilities');
      assert.deepEqual(logs[0].addedCapabilities.operations, ['native.account_tools']);
      const again = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': wider }, confirmPieceUpgrade: async () => { throw new Error('Already allowed content must not ask again'); } }).host;
      await again.call('projects.list', {}); again.close();
    }
    assert.deepEqual((asked[0] as any).addedCapabilities.operations, ['native.account_tools']);
    assert.deepEqual((asked[0] as any).addedCapabilities.effectClasses, ['6']);
    const link = await CoreLink.open({home});
    try { const rows = (await link.read<{digest:string}>(link.person(), 'SELECT digest FROM app.pieces WHERE piece = $1', ['io.github.albertoangulo/harness-pi'])).rows;
      assert.equal(rows.some(r => r.digest === pieceDigest(wider)), allow);
    } finally { await link.release(); }
  }
});

test('bundled same or narrower capability content updates without confirmation and retains registrations', async () => {
  const home = freshHome();
  const old = piCopy('Pi bundled old');
  const first = open(home, {harness:'harness-pi',pieceDirs:{'harness-pi':old}}).host;
  await first.call('projects.list',{}); first.close();
  let previousDigest = pieceDigest(old);
  for (const narrow of [false, true]) {
    const updated = piCopy(`Pi bundled ${narrow}`);
    redeclare(updated, m => { m.version = narrow ? '0.0.2' : '0.0.1'; if(narrow) m.capabilities.network = []; });
    const logs: unknown[] = [];
    const host = open(home,{harness:'harness-pi',pieceDirs:{'harness-pi':updated},bundledResources:dirname(updated),pieceUpgradeLog: e => logs.push(e),confirmPieceUpgrade:async()=>{throw new Error('No dialog for bundled narrowing');}}).host;
    await host.call('projects.list',{}); host.close();
    assert.equal(logs.length,1);
    assert.equal((logs[0] as any).reason,'bundled update within existing permission');
    assert.equal((logs[0] as any).previous.digest, previousDigest);
    previousDigest = pieceDigest(updated);
    assert.equal((logs[0] as any).digest,pieceDigest(updated));
    const link = await CoreLink.open({home});
    try { const rows=(await link.read<{digest:string}>(link.person(),'SELECT digest FROM app.pieces WHERE piece = $1',['io.github.albertoangulo/harness-pi'])).rows;
      assert.ok(rows.some(r=>r.digest===pieceDigest(old))); assert.ok(rows.some(r=>r.digest===pieceDigest(updated)));
      const history = (await link.read<{payload:{version:string;digest:string};at:string}>(link.person(), "SELECT payload, at::text FROM app.ledger WHERE entry_type = 'piece.registered' AND payload->>'piece' = $1 ORDER BY seq", ['io.github.albertoangulo/harness-pi'])).rows;
      assert.ok(history.some(entry => entry.payload.digest === pieceDigest(updated) && entry.payload.version === (narrow ? '0.0.2' : '0.0.1') && !Number.isNaN(Date.parse(entry.at))));
    } finally { await link.release(); }
  }
});

test('a resource path outside the bundle, including a symlink escape, still needs confirmation', async () => {
  const home = freshHome(), resources = freshDir('piece-resources-');
  const first = open(home,{harness:'harness-pi',pieceDirs:{'harness-pi':piCopy('Pi external old')}}).host;
  await first.call('projects.list',{}); first.close();
  const updated = piCopy('Pi external update');
  const alias=join(resources,'escape'); symlinkSync(updated,alias);
  for(const path of [updated,alias]) {
    let asks=0;
    const host=open(home,{harness:'harness-pi',pieceDirs:{'harness-pi':path},bundledResources:resources,confirmPieceUpgrade:async()=>{asks++;return false;}}).host;
    await assert.rejects(host.call('projects.list',{}),/not a registered piece/); host.close(); assert.equal(asks,1);
  }
});

for (const revoke of ['registration', 'mandate'] as const) test(`a bundled update cannot quietly restore a revoked ${revoke}`, async () => {
  const home = freshHome();
  const old = piCopy(`Pi before ${revoke}`), updated = piCopy(`Pi revoked ${revoke}`);
  const first = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': old } }).host;
  await first.call('projects.list', {}); first.close();
  const allowed = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': updated }, confirmPieceUpgrade: async () => true }).host;
  await allowed.call('projects.list', {}); allowed.close();
  const link = await CoreLink.open({ home });
  try {
    const registration = (await link.read<{ id: string }>(link.person(), 'SELECT id FROM app.pieces WHERE piece = $1 AND digest = $2', ['io.github.albertoangulo/harness-pi', pieceDigest(updated)])).rows[0].id;
    if (revoke === 'registration') await link.call(link.person(), 'SELECT gov.unregister_piece($1)', [registration]);
    else await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [await link.pieceMandate(registration)]);
  } finally { await link.release(); }
  let asked = 0;
  const declined = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': updated }, bundledResources: dirname(updated), confirmPieceUpgrade: async () => { asked++; return false; } }).host;
  await assert.rejects(declined.call('projects.list', {}), /not a registered piece|has no grant/); declined.close();
  assert.equal(asked, 1);
  // New content after that revocation declares nothing beyond the first, still granted version.
  // The person's latest decision was to revoke, so the older grant is not inherited: they are asked.
  const third = piCopy(`Pi after revoked ${revoke}`);
  let askedAgain = 0;
  const later = open(home, { harness: 'harness-pi', pieceDirs: { 'harness-pi': third }, bundledResources: dirname(third), confirmPieceUpgrade: async () => { askedAgain++; return false; } }).host;
  await assert.rejects(later.call('projects.list', {}), /not a registered piece|has no grant/); later.close();
  assert.equal(askedAgain, 1);
});
