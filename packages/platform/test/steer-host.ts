// A host on an engine of the test's own making: the native piece's files with its module swapped for
// one that hands back the engine given here, in this process. It calls no client and no model.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Receipt, TurnSettings } from '../src/api.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import type { Host } from '../src/composition/host.ts';
import type { HarnessV1 } from '../src/ports/harness.ts';

const settings: TurnSettings = { permission: 'full', model: 'controlled', effort: 3, runsOn: 'this-computer', mode: 'chat' };
let fixture: string | undefined;
function piece() {
  if (fixture) return fixture;
  const dir = mkdtempSync(join(tmpdir(), 'backbone-steer-engine-'));
  for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(PIECE_DIRS['harness-codex'], rel), join(dir, rel));
  }
  writeFileSync(join(dir, 'src', 'index.ts'), 'export function createCodexHarness() { return globalThis.__steerEngine; }\n');
  const path = join(dir, 'backbone.module.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), digest: pieceDigest(dir) }));
  fixture = dir;
  return dir;
}
process.once('exit', () => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

type Open = (home?: string, options?: { pieceDirs?: Record<string, string> }) => { home: string; host: Host };
const must = <T>(r: Receipt<T>) => { if (!r.ok) throw new Error(r.detail); return r.value; };

/** A thread with one turn running on `engine`. */
export async function steeredHost(engine: HarnessV1, open: Open) {
  const saved = { harness: process.env.BACKBONE_HARNESS, model: process.env.BACKBONE_CODEX_MODEL };
  (globalThis as { __steerEngine?: HarnessV1 }).__steerEngine = engine;
  process.env.BACKBONE_HARNESS = 'harness-codex';
  process.env.BACKBONE_CODEX_MODEL = 'controlled';
  const dir = piece();
  let opened: ReturnType<Open>;
  try { opened = open(undefined, { pieceDirs: { 'harness-codex': dir } }); }
  finally { if (saved.harness === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = saved.harness; }
  const { host, home } = opened;
  const project = must(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = must(await host.call('turns.send', { projectId: project.id, text: 'Work on it', attachments: [], settings, clientKey: 'first' }));
  if (saved.model === undefined) delete process.env.BACKBONE_CODEX_MODEL; else process.env.BACKBONE_CODEX_MODEL = saved.model;
  return { host, home, project, threadId: sent.threadId, get: async () => must(await host.call('threads.get', { id: sent.threadId })) };
}
