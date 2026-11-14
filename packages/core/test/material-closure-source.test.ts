import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { createHash } from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { baselineFiles, buildBaseline } from '../src/db/baseline.ts';
import {materialGuardStep} from '../src/db/material-guard.ts';
import {materialLinkStep} from '../src/db/material-link.ts';
import {materialEnforcementStep} from '../src/db/material-enforcement.ts';
import {signatureLedgerStep} from '../src/db/signature-ledger.ts';
import { MATERIAL_CLOSURE_RELEASE } from '../src/db/material-closure-release.generated.ts';
import { MATERIAL_CLOSURE_RELEASE as MATERIAL_CLOSURE_HARDENING_RELEASE } from '../src/db/material-closure-hardening-release.generated.ts';
import { assembleClosedVersion, checkCoreSources, functionDeclarations, policyDeclarations, runtimeReleaseArtifacts } from '../scripts/closed-version.mjs';
const teamStems=['identity-role-closure','identity-piece-admission','identity-lookup-closure','identity-invitation-closure','identity-device-recovery','identity-device-lockout','identity-device-subject','identity-native-turn','identity-device-current'];
const teamArtifacts=teamStems.map(stem=>({file:`packages/core/src/db/${stem}-release.generated.ts`,artifact:readFileSync(new URL(`../src/db/${stem}-release.generated.ts`,import.meta.url),'utf8')}));
const team=teamArtifacts.map(({artifact},index)=>({manifest:{version:teamStems[index]+'-v1'},built:{artifact}}));
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const root = new URL('../../../', import.meta.url);
const schema = new URL('../schema/', import.meta.url);
const manifest = () => JSON.parse(readFileSync(new URL('versions/material-closure-foundation-v1/manifest.json', schema), 'utf8'));
const sourceMap = () => new Map<string, Buffer>(manifest().sections.flatMap((s: { files: { path: string }[] }) => s.files.map(f => [f.path, readFileSync(new URL('versions/material-closure-foundation-v1/' + f.path, schema))])));

describe('closed Core source evolution', {concurrent: false}, () => {
  it('indexes standalone policy replacements by their exact table without reading quoted or commented SQL',()=>{
    expect(policyDeclarations("-- CREATE POLICY fake ON app.tasks;\nCREATE POLICY read ON app.documents USING(true); SELECT 'CREATE POLICY fake ON app.effects';")).toEqual(['policy app.documents.read']);
    expect(()=>policyDeclarations('CREATE POLICY "quoted" ON app.documents USING(true);')).toThrow('unsupported SQL policy declaration');
  });
  let fixture: string;
  const originals = new Map<string, Buffer>();
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'core-closed-source-'));
    const core = join(fixture, 'packages/core'); mkdirSync(join(core, 'src/db'), {recursive: true});
    cpSync(schema, join(core, 'schema'), {recursive: true});
    for (const file of ['material-closure-release.generated.ts', 'material-closure-hardening-release.generated.ts'])
      cpSync(new URL('../src/db/' + file, import.meta.url), join(core, 'src/db/' + file));
    for (const file of ['schema/baseline.json', 'schema/gov/_create_workspace.sql', 'schema/current.json', 'src/db/material-closure-release.generated.ts', 'src/db/material-closure-hardening-release.generated.ts']) {
      const path = join(core, file); originals.set(path, readFileSync(path));
    }
  });
  afterAll(() => { if (fixture) rmSync(fixture, {recursive: true, force: true}); });
  it('reproduces the frozen bootstrap independently of versioned SQL discovery', () => {
    const m = JSON.parse(readFileSync(new URL('baseline.json', schema), 'utf8'));
    expect(baselineFiles()).toHaveLength(251);
    expect(m.sections.flatMap((s: { files: string[] }) => s.files).some((p: string) => p.includes('*'))).toBe(false);
    const built = buildBaseline();
    expect(built.checksum).toBe('bfd246fcc4bd352ea9bb61114e827a20cae79c8b6bcc6359cef91965b0d8d21c');
    expect(built.checksum).toBe(m.bodyChecksum);
    expect(hash(built.sql)).toBe('4dcd5228d6e1eec7925f77a961b98275a17ce47a999548914ae77cafa25b8174');
    expect(hash(built.sql)).toBe(m.artifactChecksum);
  });
  it('reproduces the actual static runtime payload and current-definition index', () => {
    expect(checkCoreSources(new URL(root).pathname)).toEqual([]);
    expect(hash(MATERIAL_CLOSURE_RELEASE.sql)).toBe('e42bc9100005e2949ce5c6da5f535a59de8ef307766b532e2ec2f5c568fa866c');
    expect(hash(MATERIAL_CLOSURE_RELEASE.sql)).toBe(MATERIAL_CLOSURE_RELEASE.checksum);
    expect(MATERIAL_CLOSURE_RELEASE.sql).toContain('CREATE TRIGGER candidate_input_capture BEFORE INSERT');
    expect(MATERIAL_CLOSURE_RELEASE.sql).toContain('CREATE CONSTRAINT TRIGGER candidate_input_structure');
    expect(MATERIAL_CLOSURE_RELEASE.sql).toContain('ENABLE ALWAYS TRIGGER candidate_input_capture');
    expect(MATERIAL_CLOSURE_RELEASE.sql).not.toContain('-- gov/_material_source_state.sql\n\nCREATE FUNCTION');
    expect(functionDeclarations(MATERIAL_CLOSURE_RELEASE.sql)).toContain('gov.recall_knowledge_traced_v1(uuid,bigint,text[],integer)');
  });
  it('keeps the historical hardening artifact and advances the explicit current capture definition', () => {
    const state = JSON.parse(readFileSync(new URL('versions.json', schema), 'utf8'));
    expect(state.versions.map((row: any) => row.version)).toEqual(['material-closure-foundation-v1', 'material-closure-hardening-v1', 'identity-v1', 'identity-work-v1', 'identity-role-revocation-v1', 'identity-resource-guard-v1', 'identity-admission-closure-v1','identity-guarantees-v1','identity-platform-v1','identity-role-closure-v1','identity-piece-admission-v1','identity-lookup-closure-v1','identity-invitation-closure-v1','identity-device-recovery-v1','identity-device-lockout-v1','identity-device-subject-v1','identity-native-turn-v1','identity-device-current-v1']);
    expect(MATERIAL_CLOSURE_HARDENING_RELEASE.version).toBe('material-closure-hardening-v1');
    expect(hash(MATERIAL_CLOSURE_HARDENING_RELEASE.sql)).toBe(MATERIAL_CLOSURE_HARDENING_RELEASE.checksum);
    expect(MATERIAL_CLOSURE_HARDENING_RELEASE.checksum).toBe(state.versions[1].checksum);
    expect(MATERIAL_CLOSURE_HARDENING_RELEASE.checksum).not.toBe(MATERIAL_CLOSURE_RELEASE.checksum);
    const current = JSON.parse(readFileSync(new URL('current.json', schema), 'utf8'));
    const historical = JSON.parse(readFileSync(new URL('versions/material-closure-hardening-v1/manifest.json', schema), 'utf8'));
    expect(historical.changes.map((row:any)=>row.object).sort()).toEqual([
      'function gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)', 'function sec.t_candidate_input_capture_v1()',
    ]);
    expect(current.functions.filter((row:any)=>row.version==='material-closure-hardening-v1').map((row:any)=>row.signature)).toEqual([
      'gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)',
    ]);
    expect(current.functions.find((row:any)=>row.signature==='sec.t_candidate_input_capture_v1()').version).toBe('identity-guarantees-v1');
  });
  it('maps each released version to its own explicit runtime artifact, independent of list position', () => {
    const artifact = readFileSync(new URL('../src/db/material-closure-release.generated.ts', import.meta.url), 'utf8');
    const hardeningArtifact = readFileSync(new URL('../src/db/material-closure-hardening-release.generated.ts', import.meta.url), 'utf8');
    const foundation = {manifest: {version: 'material-closure-foundation-v1'}, built: {artifact}};
    const hardening = {manifest: {version: 'material-closure-hardening-v1'}, built: {artifact: hardeningArtifact}};
    const identityArtifact=readFileSync(new URL('../src/db/identity-release.generated.ts',import.meta.url),'utf8');
    const workArtifact=readFileSync(new URL('../src/db/identity-work-release.generated.ts',import.meta.url),'utf8');
    const identity={manifest:{version:'identity-v1'},built:{artifact:identityArtifact}};
    const work={manifest:{version:'identity-work-v1'},built:{artifact:workArtifact}};
    const roleArtifact=readFileSync(new URL('../src/db/identity-role-revocation-release.generated.ts',import.meta.url),'utf8');
    const role={manifest:{version:'identity-role-revocation-v1'},built:{artifact:roleArtifact}};
    const resourceArtifact=readFileSync(new URL('../src/db/identity-resource-release.generated.ts',import.meta.url),'utf8');
    const resource={manifest:{version:'identity-resource-guard-v1'},built:{artifact:resourceArtifact}};
    const admissionArtifact=readFileSync(new URL('../src/db/identity-admission-release.generated.ts',import.meta.url),'utf8');
    const admission={manifest:{version:'identity-admission-closure-v1'},built:{artifact:admissionArtifact}};
    const guaranteesArtifact=readFileSync(new URL('../src/db/identity-guarantees-release.generated.ts',import.meta.url),'utf8');
    const guarantees={manifest:{version:'identity-guarantees-v1'},built:{artifact:guaranteesArtifact}};
    const platformArtifact=readFileSync(new URL('../src/db/identity-platform-release.generated.ts',import.meta.url),'utf8');
    const platform={manifest:{version:'identity-platform-v1'},built:{artifact:platformArtifact}};
    const expected = [
      {file: 'packages/core/src/db/material-closure-release.generated.ts', artifact},
      {file: 'packages/core/src/db/material-closure-hardening-release.generated.ts', artifact: hardeningArtifact},
      {file:'packages/core/src/db/identity-release.generated.ts',artifact:identityArtifact},
      {file:'packages/core/src/db/identity-work-release.generated.ts',artifact:workArtifact},
      {file:'packages/core/src/db/identity-role-revocation-release.generated.ts',artifact:roleArtifact},
      {file:'packages/core/src/db/identity-resource-release.generated.ts',artifact:resourceArtifact},
      {file:'packages/core/src/db/identity-admission-release.generated.ts',artifact:admissionArtifact},
      {file:'packages/core/src/db/identity-guarantees-release.generated.ts',artifact:guaranteesArtifact},
      {file:'packages/core/src/db/identity-platform-release.generated.ts',artifact:platformArtifact},
      ...teamArtifacts,
    ];
    expect(runtimeReleaseArtifacts([foundation, hardening, identity, work, role, resource, admission, guarantees, platform, ...team])).toEqual(expected);
    expect(runtimeReleaseArtifacts([platform, guarantees, admission, resource, role, work, hardening, identity, foundation, ...team.toReversed()])).toEqual(expected);
  });
  it('refuses an unmapped future version instead of assigning its payload to the v1 artifact', () => {
    const v1 = {manifest: {version: 'material-closure-foundation-v1'}, built: {artifact: 'immutable v1 bytes'}};
    const hardening = {manifest: {version: 'material-closure-hardening-v1'}, built: {artifact: 'independent hardening bytes'}};
    const identity={manifest:{version:'identity-v1'},built:{artifact:'identity bytes'}};
    const work={manifest:{version:'identity-work-v1'},built:{artifact:'identity work bytes'}};
    const role={manifest:{version:'identity-role-revocation-v1'},built:{artifact:'role revocation bytes'}};
    const resource={manifest:{version:'identity-resource-guard-v1'},built:{artifact:'resource guard bytes'}};
    const admission={manifest:{version:'identity-admission-closure-v1'},built:{artifact:'admission closure bytes'}};
    const guarantees={manifest:{version:'identity-guarantees-v1'},built:{artifact:'native guarantees bytes'}};
    const platform={manifest:{version:'identity-platform-v1'},built:{artifact:'platform compatibility bytes'}};
    const v2 = {manifest: {version: 'material-closure-foundation-v2'}, built: {artifact: 'different v2 bytes'}};
    expect(() => runtimeReleaseArtifacts([v1, hardening, identity, work, role, resource, admission, guarantees, platform, ...team, v2])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([v2, hardening, identity, work, role, resource, admission, guarantees, platform, ...team, v1])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([v1])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([hardening])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([v1, v1, hardening, identity, work, role, resource, admission, guarantees, platform, ...team])).toThrow('runtime release artifact mapping differs');
    expect(() => runtimeReleaseArtifacts([v1, hardening, hardening, identity, work, role, resource, admission, guarantees, platform, ...team])).toThrow('runtime release artifact mapping differs');
  });
  it.each([
    ['unknown field', (m: any) => { m.unreviewed = true; }, 'manifest fields'],
    ['prerequisite order', (m: any) => { m.requires.reverse(); }, 'prerequisite order'],
    ['unlisted source', (_m: any, s: Map<string, Buffer>) => { s.set('gov/surprise.sql', Buffer.from('SELECT 1')); }, 'unlisted or missing source'],
    ['missing source', (_m: any, s: Map<string, Buffer>) => { s.delete(s.keys().next().value!); }, 'unlisted or missing source'],
    ['raw-byte mutation', (_m: any, s: Map<string, Buffer>) => { const k = s.keys().next().value!; s.set(k, Buffer.concat([s.get(k)!, Buffer.from('\n')])); }, 'raw source digest'],
    ['duplicate object', (m: any) => { m.changes.push(m.changes[0]); }, 'duplicate object'],
    ['add existing', (m: any) => { m.changes.find((c: any) => c.action === 'replace').action = 'add'; }, 'add existing object'],
    ['replace absent', (m: any) => { m.changes.find((c: any) => c.action === 'add').action = 'replace'; }, 'replace absent object'],
    ['unsafe role', (m: any) => { m.sections[0].role = 'postgres'; }, 'owning role'],
    ['unsafe path', (m: any) => { m.sections[0].files[0].path = '../escape.sql'; }, 'closed source path'],
    ['changed payload checksum', (m: any) => { m.checksum = '0'.repeat(64); }, 'payload checksum'],
  ])('rejects %s with its owning diagnostic', (_name, mutate, diagnostic) => {
    const m = manifest(), sources = sourceMap();
    const state = JSON.parse(readFileSync(new URL('versions.json', schema), 'utf8'));
    const current = JSON.parse(readFileSync(new URL('current.json', schema), 'utf8'));
    const prior = new Map(current.bootstrap.map((r: any) => [r.object, r]));
    mutate(m, sources);
    expect(() => assembleClosedVersion(m, sources, state.historical, prior, state.versions[0])).toThrow(diagnostic);
  });
  it('keeps byte-pinned SQL and generated release data LF even with an autocrlf checkout preference', () => {
    const files=['packages/core/schema/gov/_create_workspace.sql','packages/core/schema/versions/material-closure-foundation-v1/gov/_create_workspace.sql','packages/core/src/db/material-closure-release.generated.ts','packages/core/src/db/material-closure-hardening-release.generated.ts'];
    const actual=execFileSync('git',['-c','core.autocrlf=true','check-attr','eol','--',...files],{cwd:new URL(root),encoding:'utf8'}).trim().split('\n');
    expect(actual).toEqual(files.map(file=>`${file}: eol: lf`));
  });
  it('retains the exact four published executable payloads', () => {
    const baseline = buildBaseline().sql;
    expect(materialGuardStep(baseline)?.checksum).toBe('aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7');
    expect(materialLinkStep(baseline)?.checksum).toBe('26815c949303419f35ec3acbda282c9a875c73202336b46a0ff157c7c192d206');
    expect(materialEnforcementStep(baseline)?.checksum).toBe('7de82aa384da2c39b851b5a311fa8b7ead8be0eace69c00ed816248326e928bb');
    expect(signatureLedgerStep(baseline)?.checksum).toBe('e9b5b046d2dc27fe384e86767d7528e1d55e36596d921fdfcb312fdba9576bfe');
  });
  it.each([
    ['unlisted SQL', (dir: string) => writeFileSync(join(dir, 'packages/core/schema/versions/unlisted.sql'), 'SELECT 1;'), 'unlisted or missing Core SQL source'],
    ['raw bootstrap edit', (dir: string) => writeFileSync(join(dir, 'packages/core/schema/gov/_create_workspace.sql'), '-- changed historical bytes'), 'baseline raw source digest'],
    ['bootstrap wildcard', (dir: string) => {
      const path = join(dir, 'packages/core/schema/baseline.json'), m = JSON.parse(readFileSync(path, 'utf8'));
      m.sections[1].files = ['sec/*.sql']; writeFileSync(path, JSON.stringify(m));
    }, 'finite baseline source path'],
    ['bootstrap body receipt', (dir: string) => {
      const path = join(dir, 'packages/core/schema/baseline.json'), m = JSON.parse(readFileSync(path, 'utf8'));
      m.bodyChecksum = '0'.repeat(64); writeFileSync(path, JSON.stringify(m));
    }, 'baseline body checksum'],
    ['bootstrap artifact receipt', (dir: string) => {
      const path = join(dir, 'packages/core/schema/baseline.json'), m = JSON.parse(readFileSync(path, 'utf8'));
      m.artifactChecksum = '0'.repeat(64); writeFileSync(path, JSON.stringify(m));
    }, 'baseline artifact checksum'],
    ['stale current map', (dir: string) => writeFileSync(join(dir, 'packages/core/schema/current.json'), '{}'), 'current definition index differs'],
    ['changed packaged data', (dir: string) => writeFileSync(join(dir, 'packages/core/src/db/material-closure-release.generated.ts'), '// missing release'), 'generated release data differs'],
    ['changed hardening packaged data', (dir: string) => writeFileSync(join(dir, 'packages/core/src/db/material-closure-hardening-release.generated.ts'), '// missing hardening release'), 'generated release data differs'],
  ])('rejects %s at the complete Core source owner', (_label, mutate, message) => {
    try {
      mutate(fixture); expect(checkCoreSources(fixture).join('\n')).toContain(message);
    } finally {
      // Restore exact bytes even on a failed assertion; sequential cases cannot inherit a
      // previous mutation. The full schema is copied once, outside each test's timed work.
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      rmSync(join(fixture, 'packages/core/schema/versions/unlisted.sql'), {force: true});
    }
  });
  it('lexes exact function signatures without definitions inside literals/comments', () => {
    expect(functionDeclarations(`-- CREATE FUNCTION gov.fake() RETURNS text;\nCREATE FUNCTION gov.real(p text DEFAULT 'a,b', OUT n bigint) LANGUAGE sql AS $$ SELECT 1 $$;`)).toEqual(['gov.real(text)']);
    expect(() => functionDeclarations('CREATE FUNCTION gov.unknown(p custom) RETURNS text AS $$ $$ LANGUAGE sql;')).toThrow('unsupported SQL argument type');
  });
});
