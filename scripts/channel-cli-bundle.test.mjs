import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const root=join(import.meta.dirname,'..');
test('the npm CLI archive retains the silent Teams authentication logger with npm-provided dependencies',{timeout:180_000},()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-cli-bundle-'));
 try{
  const archive=execFileSync(process.execPath,[join(root,'scripts/pack-cli.mjs'),home],{encoding:'utf8'}).trim();
  const listing=execFileSync('tar',['-tzf',archive],{encoding:'utf8'});
  assert.doesNotMatch(listing,/\/(?:test|tests|testing|fixtures|__tests__)\//);
  assert.ok(listing.split('\n').every(path=>path.startsWith('package/')||!path),'archive paths stay inside the package');
  const unpack=join(home,'unpack');mkdirSync(unpack);execFileSync('tar',['-xzf',archive,'-C',unpack]);
  // Supply the dependencies npm owns from the frozen workspace install. This
  // logger test needs no npm cache or network; cli-install proves a real install.
  const cli=join(unpack,'package');
  const workspaces=Object.values(JSON.parse(readFileSync(join(cli,'bin/workspace-map.json'))));
  for(const [name,version] of Object.entries(JSON.parse(readFileSync(join(cli,'package.json'))).dependencies)){
   const target=join(cli,'node_modules',name);
   if(existsSync(target))continue;
   const source=workspaces.map(dir=>join(root,dir,'node_modules',name)).find(path=>existsSync(join(path,'package.json')));
   assert.ok(source,`a frozen CLI dependency is installed: ${name}`);
   assert.equal(JSON.parse(readFileSync(join(source,'package.json'))).version,version);
   mkdirSync(dirname(target),{recursive:true});symlinkSync(realpathSync(source),target,'dir');
  }
  const entry=pathToFileURL(join(unpack,'package/node_modules/@chat-adapter/teams/dist/index.js')).href;
  const probe=`
   const https=(await import('node:https')).default;
   const http=(await import('node:http')).default;
   const {EventEmitter}=await import('node:events');
   const {PassThrough}=await import('node:stream');
   const {publicKey}=await import('node:crypto').then(({generateKeyPairSync})=>generateKeyPairSync('rsa',{modulusLength:2048}));
   const jwk={...publicKey.export({format:'jwk'}),kid:'local-key',use:'sig',alg:'RS256'};
   let outside=0;
   const deny=()=>{outside++;throw new Error('Outside HTTP is forbidden');};
   http.request=deny;globalThis.fetch=deny;
   https.request=(options,callback)=>{
    if(options.hostname!=='login.botframework.com'||options.path!=='/v1/.well-known/keys'||(options.method&&options.method!=='GET'))return deny();
    const request=new EventEmitter();request.destroy=()=>{};
    request.end=()=>{const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};callback(response);response.end(JSON.stringify({keys:[jwk]}));};
    return request;
   };
   const {TeamsAdapter}=await import(${JSON.stringify(entry)});
   const silent={debug(){},info(){},warn(){},error(){},trace(){},log(){},child(){return this;}};
   const adapter=new TeamsAdapter({appId:'app-id',appPassword:'synthetic-password',appTenantId:'tenant-one',appType:'SingleTenant',logger:silent,appLogger:silent});
   await adapter.initialize({});
   const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
   const jwt=encoded({alg:'none',kid:'local-key'})+'.'+encoded({aud:'app-id',iss:'https://api.botframework.com',exp:Math.floor(Date.now()/1000)+600})+'.';
   const response=await adapter.handleWebhook(new Request('http://localhost/channels/teams',{method:'POST',headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},body:JSON.stringify({type:'message',id:'one',serviceUrl:'https://smba.trafficmanager.net/teams/',conversation:{id:'private'},from:{id:'person'},recipient:{id:'28:app-id'},text:'private body'})}));
   if(outside)throw new Error('Outside HTTP was attempted');
   if(response.status!==401)throw new Error('An unsigned token was admitted');
   await adapter.shutdown?.();
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',probe],{cwd:unpack,env:{...process.env,LOG_LEVEL:'debug',LOG:'*',NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:30_000});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout+child.stderr,'','a packaged SDK cannot fall back to its unsilenced App logger');
 }finally{rmSync(home,{recursive:true,force:true});}
});
