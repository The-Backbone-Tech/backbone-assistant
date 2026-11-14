// Test-only preloader. Refused attempts remain failures even when an SDK catches
// the exception or a parent test expects a child command to exit unsuccessfully.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const https=require('node:https');
const net=require('node:net');
const dns=require('node:dns');
const cp=require('node:child_process');
const {promisify}=require('node:util');
const {syncBuiltinESMExports}=require('node:module');
const marker=Symbol.for('backbone.test.local-network');
if(!globalThis[marker]){
 const own=!process.env.BACKBONE_TEST_NETWORK_AUDIT;
 const dir=own?fs.mkdtempSync(path.join(os.tmpdir(),'network-audit-')):undefined;
 const audit=process.env.BACKBONE_TEST_NETWORK_AUDIT||path.join(dir,'attempts');
 process.env.BACKBONE_TEST_NETWORK_AUDIT=audit;
 // Opt-in runners may guard their Node subprocesses, but never rewrite NODE_OPTIONS.
 // An unrelated app/Electron process must not inherit a preloader through its environment.
 for(const name of ['spawn','spawnSync','execFile','execFileSync']){
  const native=cp[name];
  cp[name]=function(file,args,...rest){
   if(file===process.execPath){
    if(!Array.isArray(args)){rest.unshift(args);args=[];}
    // Bootstrap scripts may explicitly install the guard after their transport canaries.
    if(!args.some(arg=>typeof arg==='string'&&arg.includes(__filename)))args=['--require',__filename,...args];
   }
   return Reflect.apply(native,this,[file,args,...rest]);
  };
  if(name==='execFile'){
   const guarded=cp[name];
   // Reusing Node's custom promisifier would call its unguarded original function.
   Object.defineProperty(guarded,promisify.custom,{configurable:true,value:function(...args){
    let child;
    const result=new Promise((resolve,reject)=>{
     child=guarded(...args,(error,stdout,stderr)=>{
      if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}
      else resolve({stdout,stderr});
     });
    });
    result.child=child;
    return result;
   }});
  }
 }
 function refuse(kind){
  // Never print a URL: Telegram paths and HTTP headers can contain credentials.
  fs.appendFileSync(audit,kind+'\n',{mode:0o600});
  process.stderr.write('TEST_EXTERNAL_NETWORK_REFUSED '+kind+'\n');
  process.exitCode=1;
  throw new Error('Outside network refused by test fixture');
 }
 function local(host){
  const value=String(host||'localhost').toLowerCase().replace(/^\[|\]$/g,'');
  return value==='localhost'||value==='localhost.'||value==='::1'||value==='::ffff:127.0.0.1'||(net.isIP(value)===4&&value.startsWith('127.'));
 }
 function target(args){
  const first=args[0];
  if(typeof first==='string'||first instanceof URL){
   const url=new URL(first);if(!['http:','https:'].includes(url.protocol))return false;
   if(!local(url.hostname))return false;
  }
  const opts=(typeof first==='object'&&!(first instanceof URL)?first:args[1])||{};
  if(typeof opts!=='object')return true;
  if(opts.socketPath)return true;
  if(opts.hostname||opts.host){if(!local(opts.hostname||opts.host))return false;}
  if(opts.method==='CONNECT')return false;
  if(typeof opts.path==='string'&&/^https?:\/\//.test(opts.path)&&!local(new URL(opts.path).hostname))return false;
  return true;
 }
 for(const [module,kind] of [[http,'http'],[https,'https']]){
  const request=module.request;
  module.request=function(...args){if(!target(args))return refuse(kind);return Reflect.apply(request,this,args);};
  module.get=function(...args){const req=module.request(...args);req.end();return req;};
 }
 const fetch=globalThis.fetch;
 globalThis.fetch=function(input,...args){
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!['http:','https:'].includes(url.protocol)||!local(url.hostname))return refuse('fetch');
  return Reflect.apply(fetch,this,[input,...args]);
 };
 const connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){
  let value=args[0];if(Array.isArray(value))value=value[0];
  const host=typeof value==='object'?value.host:typeof args[1]==='string'?args[1]:'localhost';
  if(!(typeof value==='string'||value?.path)&&!local(host))return refuse('socket');
  return Reflect.apply(connect,this,args);
 };
 const lookup=dns.lookup;
 dns.lookup=function(host,...args){if(host&&!local(host))return refuse('dns');return Reflect.apply(lookup,this,[host,...args]);};
 syncBuiltinESMExports();
 globalThis[marker]={refuse};
 process.on('exit',()=>{
  try{if(fs.existsSync(audit)&&fs.statSync(audit).size){process.stderr.write('TEST_EXTERNAL_NETWORK_REFUSED audit\n');process.exitCode=1;}}
  finally{if(own)fs.rmSync(dir,{recursive:true,force:true});}
 });
}
module.exports=globalThis[marker];
