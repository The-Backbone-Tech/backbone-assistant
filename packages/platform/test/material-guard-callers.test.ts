// A change detector for the audited runtime surface, not an arbitrary-SQL security boundary.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const sensitive=/\bgov\.(propose_candidate|request_promotion|answer_decision|answer_decision_with_basis|verifier_answer|may_decide|claim_next_verification|recall_knowledge|recall_knowledge_traced_v1)\s*\(|\bapp\.(knowledge(?:_candidates)?)\b/g;
const pureMetadata=new Map([
 ['packages/core/src/db/identity-admission-release.generated.ts','Closed admission SQL defines the native decision guard; exact released bytes and per-body rollback invocations are checked independently.'],
 ['packages/core/src/db/identity-resource-release.generated.ts','Closed resource SQL defines verifier queue admission; the explicit native qualifier below invokes it only in disposable fixtures.'],
 ['packages/core/src/db/identity-guarantees-release.generated.ts','Closed guarantee SQL defines candidate capture and its immutable table trigger; source reproduction and native body controls cover these exact bytes.'],
 ['packages/core/src/db/identity-lookup-closure-release.generated.ts','Closed lookup SQL redefines the candidate proposal crossing with its own run lookup; exact source reproduction and the native per-body rollback invocation of gov.propose_candidate cover these bytes.'],
 ['packages/core/src/db/identity-platform-release.generated.ts','Closed platform SQL attaches the named-actor statement trigger to candidates; exact source reproduction and real trigger controls cover it.'],
 ['packages/core/src/db/material-closure-hardening-pins.ts','Frozen signature-exact hardening body fingerprints, not runtime calls.'],
 ['packages/core/src/db/material-closure-hardening-profile.ts','Complete catalogue verification names composite function signatures as metadata; it does not invoke proposal or recall crossings.'],
 ['packages/core/src/db/material-closure-hardening-release.generated.ts','Exact append-only hardening SQL installed by the owned migration, independently source-reproduced and native-qualified.'],
 ['packages/core/src/db/material-guard.ts','Released function profiles and installer dependencies name signatures; they do not invoke the approval crossing.'],
 ['packages/core/src/db/signature-ledger-catalogue.ts','Catalogue dependencies name signatures for inspection, not invocation.'],
 ['packages/core/src/db/signature-ledger-pins.ts','Generated fingerprints key signatures to digests, not runtime calls.'],
 ['packages/core/src/db/signature-ledger-source.ts','Object names assemble additive DDL and EXECUTE grants, not runtime approval calls.'],
 // Exact source owners only: neither Core directories nor generated files are excluded as a class.
 ['packages/core/scripts/closed-version-functions.mjs','The offline SQL lexer recognizes the knowledge_candidates composite type; it executes no SQL.'],
 ['packages/core/scripts/material-closure-pins.mjs','The offline profile freezer compares captured object identities and writes fixed fingerprints; it has no database connection or RPC invocation.'],
 ['packages/core/src/db/material-closure-inherited-catalogue.ts','Inherited catalogue collectors inspect named signatures and pg_catalog metadata without invoking the named crossings.'],
 ['packages/core/src/db/material-closure-inherited.ts','Frozen inherited signature and catalogue fingerprints are data, preserving the old material profile coverage.'],
 ['packages/core/src/db/material-closure-pins.ts','Generated prerequisite/current fingerprints key exact signatures and object-family identities to digests, not runtime calls.'],
 ['packages/core/src/db/material-closure-scope.ts','The complete profile inventory names function signatures and relation families passed to catalogue inspection, not executed as crossings.'],
 ['packages/core/src/db/material-closure-release.generated.ts','Exact versioned native SQL release data is installed by the owned migration, not a TypeScript runtime RPC; its full bytes are covered by closed-source reproduction and native catalogue/control qualification.'],
]);
function files(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>
 entry.isDirectory()?(['node_modules','dist','test','e2e'].includes(entry.name)?[]:files(join(path,entry.name))):/\.[cm]?[jt]sx?$/.test(entry.name)?[join(path,entry.name)]:[]);}
test('new runtime promotion, approval, verifier and recall callers require an explicit source-check audit',()=>{
 const actual=files(join(root,'packages')).filter(file=>!pureMetadata.has(relative(root,file))).flatMap(file=>callers(readFileSync(file,'utf8')).map(name=>`${relative(root,file)}:${name}`)).sort();
 assert.deepEqual(actual,[
  // Explicit synthetic crash qualifier: owns a new loopback PostgreSQL cluster, invokes a pending
  // candidate only to prove uncommitted rollback, and inspects its synthetic rows after recovery.
  // Its traced-read crash control uses imported TRACED_RECALL from the native test fixture;
  // those rows stay inside the qualifier and never cross a product-consumer handover.
  'packages/core/scripts/material-closure-durability.mjs:propose_candidate',
  'packages/core/scripts/material-closure-durability.mjs:relation:knowledge_candidates',
  // Actual typed recall consumer: captures native run/fence/session arguments, holds every row
  // privately until an actual COMMIT tag, and refuses lost COMMIT or Stop before handover.
  'packages/core/src/db/material-closure-read.ts:recall_knowledge_traced_v1',
  // Actual owned installer serializes old candidate inserts with bounded NOWAIT table admission;
  // this is the DDL lock target, not permission for an unaudited promotion/recall query.
  'packages/core/src/db/material-closure-hardening.ts:relation:knowledge_candidates',
  // Referenced-table/index NOWAIT prelock, before any head or DDL.
  'packages/core/src/db/material-closure.ts:relation:knowledge',
  'packages/core/src/db/material-closure.ts:relation:knowledge_candidates',
  // Connectors answer a held effect's decision as its person on per-call release/discard when the step is unavailable.
  'packages/platform/src/connectors/service.ts:answer_decision',
  // Connectors answer that decision as its person on release/discard with a checked person or standing-signature basis.
  'packages/platform/src/connectors/service.ts:answer_decision_with_basis',
  // The gateway recalls as the current run after checking the verified capability.
  'packages/platform/src/composition/gateway.ts:recall_knowledge',
  // Triage answers a held effect's decision as its person when the person accepts or discards it in the brief.
  'packages/platform/src/triage/service.ts:answer_decision',
 ].sort());
 const gateway=readFileSync(join(root,'packages/platform/src/composition/gateway.ts'),'utf8');
 assert.match(gateway,/'knowledge\.recall':[\s\S]*?link\.requireMaterialGuard\(\);[\s\S]*?gov\.recall_knowledge/);
});

// A complete quoted PostgreSQL signature is metadata by form, wherever it appears.
// Calls use arguments, placeholders or executable SQL after the quote, not just type names.
const typeList=/^\s*(?:uuid|text(?:\[\])?|jsonb|integer|timestamp with time zone)(?:\s*,\s*(?:uuid|text(?:\[\])?|jsonb|integer|timestamp with time zone))*\s*\)(['"])/;
function callers(source:string):string[]{
 return [...source.matchAll(sensitive)].filter(match=>{
  if(!match[1])return true;
  const quote=source[match.index!-1],tail=source.slice(match.index!+match[0].length);
  return !(['"',"'"].includes(quote)&&typeList.exec(tail)?.[1]===quote);
 }).map(match=>match[1] ?? `relation:${match[2]}`);
}

test('signature metadata never exempts another executable caller in the same source',()=>{
 const signature="'gov.answer_decision(uuid,text,text,text)'";
 assert.deepEqual(callers(signature),[]);
 assert.deepEqual(callers(signature+"; link.call(actor, 'SELECT gov.answer_decision($1,$2,$3,$4)', args)"),['answer_decision']);
 assert.deepEqual(callers('"SELECT gov.answer_decision(uuid,text,text,text)"'),['answer_decision']);
 assert.deepEqual(callers('gov.answer_decision(uuid,text,text,text)'),['answer_decision']);
 assert.deepEqual(callers("'SELECT * FROM app.knowledge'"),['relation:knowledge']);
 // Catalogue signature literals need no whole-file exemption. A future query
 // in the same catalogue must enter the audited runtime inventory.
 const catalogue=readFileSync(join(root,'packages/core/src/db/identity-catalogue.ts'),'utf8');
 assert.deepEqual(callers(catalogue),[]);
 assert.deepEqual(callers(catalogue+"; client.query('SELECT gov.claim_next_verification($1,$2)')"),['claim_next_verification']);
 for(const qualifier of ['identity-guarantees-qualify.ts','identity-resource-qualify.ts']){
  const source=readFileSync(join(root,'packages/core/scripts',qualifier),'utf8');
  assert.deepEqual(callers(source),[],'qualifier replacement lists contain signatures, not runtime calls');
  assert.deepEqual(callers(source+"; client.query('SELECT gov.propose_candidate($1,$2,$3,$4)')"),['propose_candidate']);
 }
});
