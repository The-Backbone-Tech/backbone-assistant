import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startChannels} from '../src/index.ts';
import {breadthEndpoint} from './breadth-fixtures.ts';
import {localTeamsKeys} from './teams-jwt-fixtures.ts';

for(const scenario of ['unsigned','HS256','unknown kid','wrong audience','wrong issuer','expired','service URL mismatch','foreign signed tenant','Entra issuer','foreign body tenant','valid'] as const)test(`Teams native verification: ${scenario}`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'teams-native-')),fake=await breadthEndpoint(),keys=await localTeamsKeys();
 const service=await startChannels(undefined,{home,teams:{appId:'app-id',password:'synthetic-password',tenantId:'tenant-one',apiUrl:fake.url},consume:async()=>{}});
 try{
  const header=scenario==='unsigned'?{alg:'none'}:scenario==='HS256'?{alg:'HS256'}:scenario==='unknown kid'?{kid:'unknown-key'}:{};
  const claims=scenario==='wrong audience'?{aud:'another-app'}:scenario==='wrong issuer'?{iss:'https://untrusted.invalid'}:scenario==='expired'?{exp:1}:scenario==='service URL mismatch'?{serviceurl:'https://another-service.invalid'}:scenario==='foreign signed tenant'?{tid:'tenant-two'}:scenario==='Entra issuer'?{iss:'https://login.microsoftonline.com/tenant-one/v2.0',tid:'tenant-one',appid:'5a807f24-c9de-44ee-a3a7-329e88a00ffc'}:{};
  const request=keys.request(keys.token(fake.url,claims,header),fake.url,scenario==='foreign body tenant'?{channelData:{tenant:{id:'tenant-two'}}}:{});
  const response=await service.webhook('teams',request);await service.idle();
  assert.equal(response.status,scenario==='valid'||scenario==='foreign body tenant'?200:401);
  assert.equal(service.ledger.intakeCount(),scenario==='valid'?1:0);
  if(scenario==='valid'){assert.equal(keys.tokens(),1,'the SDK uses the local MSAL token endpoint');assert.equal(fake.posts().length,1,'the refusal is delivered to the local connector');}
  if(['valid','wrong audience','foreign signed tenant','Entra issuer'].includes(scenario))assert.ok(keys.fetches()>0,'the SDK fetched and verified the local signing key');
 }finally{await service.close();await keys.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
