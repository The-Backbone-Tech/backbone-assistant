import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('shared channel fixtures do not install a network guard or contaminate app children',()=>{
 const probe=`
 import assert from 'node:assert/strict';
 import {spawnSync} from 'node:child_process';
 import http from 'node:http';import https from 'node:https';import dns from 'node:dns';
 const before={fetch:globalThis.fetch,http:http.request,https:https.request,dns:dns.lookup,options:process.env.NODE_OPTIONS,audit:process.env.BACKBONE_TEST_NETWORK_AUDIT};
 await import('./packages/surfaces/channels/test/fake-providers.ts');
 await import('./packages/surfaces/channels/test/messages.ts');
 assert.equal(globalThis.fetch,before.fetch);assert.equal(http.request,before.http);assert.equal(https.request,before.https);assert.equal(dns.lookup,before.dns);
 assert.equal(process.env.NODE_OPTIONS,before.options);assert.equal(process.env.BACKBONE_TEST_NETWORK_AUDIT,before.audit);
 assert.equal(globalThis[Symbol.for('backbone.test.local-network')],undefined);
 const child=spawnSync(process.execPath,['-e',"if(globalThis[Symbol.for('backbone.test.local-network')]||process.env.BACKBONE_TEST_NETWORK_AUDIT)process.exit(1)"],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',probe],{cwd:root,env:{...process.env,NODE_OPTIONS:'',BACKBONE_TEST_NETWORK_AUDIT:undefined},encoding:'utf8',timeout:30_000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('an opted-in test guard never propagates through NODE_OPTIONS',()=>{
 const probe=`
 const assert=require('node:assert/strict');const before=process.env.NODE_OPTIONS;
 require('./scripts/lib/test-local-network.cjs');
 assert.equal(process.env.NODE_OPTIONS,before);
 const result=require('node:child_process').spawnSync(process.execPath,['-e',"require('node:assert/strict').equal(process.env.NODE_OPTIONS,'');require('node:assert/strict').ok(globalThis[Symbol.for('backbone.test.local-network')]);"],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 `;
 const result=spawnSync(process.execPath,['-e',probe],{cwd:root,env:{...process.env,NODE_OPTIONS:'',BACKBONE_TEST_NETWORK_AUDIT:undefined},encoding:'utf8',timeout:30_000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
