import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessLinuxAudit, linuxExpected, inventoryPaths, createLinuxInventoryCache } from '../src/linux-audit.ts';

test('product assessment enforces its exact Node cases and declares only raw sendmsg unavailable', () => {
  for (const environment of ['full','contained','bare','readOnly'] as const) {
    const expected = linuxExpected(environment);
    const result: Record<string,unknown> = {...expected,fresh_proc:true,pid_namespace_distinct:true,network_namespace_distinct:true,host_hits:[]};
    for (const key of ['unix_datagram_sendmsg','abstract_datagram_sendmsg','host_datagram_visible']) delete result[key];
    assert.equal(assessLinuxAudit(environment,result,'node').expected,true);
    assert.throws(()=>assessLinuxAudit(environment,{...result,dns:'allowed'},'node'),/mismatch/);
    assert.throws(()=>assessLinuxAudit(environment,{...result,host_hits:['udp']},'node'),/network delivery/);
    assert.throws(()=>assessLinuxAudit(environment,{...result,unix_stream:undefined},'node'),/mismatch/);
    assert.throws(()=>assessLinuxAudit(environment,result),/Missing/);
  }
});
test('inventory uses writable, service, socket-bearing and workspace roots, excluding runtime trees', () => {
  const mounts = '1 0 0:1 / / ro - ext4 root ro\n2 1 0:2 / /usr ro - ext4 usr ro\n3 1 0:3 / /owned rw - tmpfs tmp rw\n4 1 0:4 / /dev rw - tmpfs tmp rw\n';
  const paths = inventoryPaths(mounts,'/stage',['/owned/socket-dir']);
  for (const path of ['/run','/var/run','/tmp','/var/tmp','/dev','/owned','/stage','/owned/socket-dir']) assert.ok(paths.includes(path));
  for (const path of ['/','/usr','/etc','/lib','/proc','/sys']) assert.ok(!paths.includes(path));
  assert.throws(()=>inventoryPaths('broken','/stage',[]),/mount table/);
});
test('inventory cache is bounded and belongs to its Host instance', () => {
  const first=createLinuxInventoryCache(), second=createLinuxInventoryCache();
  first.set('contained:mount-a','ok'); assert.equal(second.get('contained:mount-a'),undefined);
  assert.equal(first.get('full:mount-a'),undefined); assert.equal(first.get('contained:mount-b'),undefined);
  for(let i=0;i<40;i++)first.set(String(i),'ok'); assert.ok(first.size<=32);
});


import { refuseVisibleHostDatagrams } from '../src/linux-audit.ts';
test('native inventory caches stable roots, rescans new workspace, and invalidates mount/profile changes', async () => {
  const cache=createLinuxInventoryCache();let scans: string[][]=[];let mountExtra='';
  const evidence={mounts:'host mounts',sockets:'header\n'};
  const command=async(args:string[])=>{
    if(args.some(value=>value.includes('readdirSync'))){
      scans.push(JSON.parse(args.at(-1)!).paths);
      return JSON.stringify({visible:false,complete:true,network_namespace:'net:[2]',count:3,limit:250000,time_limit_ms:10000,elapsed_ms:1});
    }
    const stage=args[args.indexOf('-C')+1];
    return JSON.stringify({mounts:`1 0 0:1 / / ro - ext4 root ro\n2 1 0:2 ${stage} ${stage} rw - ext4 root rw\n${mountExtra}`,network_namespace:'net:[2]'});
  };
  await refuseVisibleHostDatagrams(command,'/stage-one','contained',process.execPath,[],'net:[1]',cache,evidence);
  assert.equal(scans.length,2);assert.deepEqual(scans.at(-1),['/stage-one']);
  await refuseVisibleHostDatagrams(command,'/stage-two','contained',process.execPath,[],'net:[1]',cache,evidence);
  assert.equal(scans.length,3);assert.deepEqual(scans.at(-1),['/stage-two']);
  mountExtra='3 1 0:3 / /new-mount rw - tmpfs tmp rw\n';
  await refuseVisibleHostDatagrams(command,'/stage-three','contained',process.execPath,[],'net:[1]',cache,evidence);
  assert.equal(scans.length,5);assert.ok(scans.at(-2)?.includes('/new-mount'));
  await refuseVisibleHostDatagrams(command,'/stage-four','full',process.execPath,[],'net:[1]',cache,evidence);
  assert.equal(scans.length,7);
  await refuseVisibleHostDatagrams(command,'/stage-five','full',process.execPath,[],'net:[1]',cache,{...evidence,mounts:'changed Host mount table'});
  assert.equal(scans.length,9);
});
test('failed inventory is not cached and reports its entry/time bounds', async () => {
  const cache=createLinuxInventoryCache();let scans=0;
  const command=async(args:string[])=>{
    if(!args.some(value=>value.includes('readdirSync')))return JSON.stringify({mounts:'1 0 0:1 / / ro - ext4 root ro',network_namespace:'net:[2]'});
    scans++;return JSON.stringify({visible:false,complete:false,network_namespace:'net:[2]',count:250001,limit:250000,time_limit_ms:10000,elapsed_ms:10001});
  };
  for(let i=0;i<2;i++)await assert.rejects(refuseVisibleHostDatagrams(command,'/stage','contained',process.execPath,[],'net:[1]',cache,{mounts:'host',sockets:''}),/250001\/250000 entries, 10001\/10000 ms/);
  assert.equal(scans,2);assert.equal(cache.size,0);
});

import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { LINUX_NODE_AUDIT_PROGRAM } from '../src/linux-preflight.ts';
for(const environment of ['full','contained','bare','readOnly'] as const)test(`${environment}: executable Node program measures all product cases with mocked OS results`,async()=>{
  const spec={single:'/single',late:'/late',release:'/release',data:'/data',arrangement:'/arrangement',token:'owned',host_net:'net:[1]',host_pid_ns:'pid:[1]',host_pid:9000,stream:'/stream',abstract:'\0owned',udp:1,dns:2,extra:[{path:'/actual-data',kind:'directory'}]};
  const output:string[]=[];let released=false;const attempted:string[]=[];
  class Socket extends EventEmitter {send(){attempted.push('datagram');queueMicrotask(()=>this.emit('error',{code:'EPERM'}));}close(){}destroy(){} }
  const fs={
    readFileSync(path:string){if((path==='/single'||path==='/late/canary')&&released&&environment==='full')return 'owned';throw Object.assign(Error('blocked'),{code:'EACCES'});},
    readdirSync(){throw Object.assign(Error('blocked'),{code:'EACCES'});},
    existsSync(path:string){return path==='/run'?environment==='full':released;},
    readlinkSync(path:string){return path.endsWith('/net')?'net:[2]':path.endsWith('/pid')?'pid:[2]':'1';},
    writeSync(_fd:number,data:Buffer,offset:number,length:number){output.push(data.subarray(offset,offset+length).toString());if(output.length===1)released=true;return length;},
  };
  const require=(name:string)=>name==='node:fs'?fs:name==='node:dgram'?{createSocket(){return new Socket();}}:{createConnection(path:string){attempted.push(path);const socket=new Socket();queueMicrotask(()=>socket.emit('error',{code:'EPERM'}));return socket;}};
  const child={argv:['node',JSON.stringify(spec)],pid:1,exitCode:0};
  runInNewContext(LINUX_NODE_AUDIT_PROGRAM,{require,process:child,Buffer,setTimeout,clearTimeout});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(child.exitCode,0);assert.equal(output.length,2);
  const result=JSON.parse(output[1]!);assert.deepEqual(result.extra_denies,['denied']);delete result.extra_denies;
  assert.equal(assessLinuxAudit(environment,{...result,host_hits:[]},'node').expected,true);
  assert.deepEqual(attempted,['datagram','datagram','/stream','\0owned']);
});

import { LINUX_SOCKET_INVENTORY_PROGRAM } from '../src/linux-audit.ts';
test('selected aliases into runtime trees are canonicalized byte-exactly before exclusions', () => {
  const output:string[]=[];
  const canonical=Buffer.from('/usr/local/service/socket  \tname');
  const realpath=Object.assign(()=>canonical,{native:()=>canonical});
  const fs={realpathSync:realpath,statSync:()=>({isSocket:()=>true}),readlinkSync:()=> 'net:[2]',writeSync:(_fd:number,data:Buffer,offset:number,length:number)=>{output.push(data.subarray(offset,offset+length).toString());return length;}};
  runInNewContext(LINUX_SOCKET_INVENTORY_PROGRAM,{require:()=>fs,process:{argv:['node',JSON.stringify({paths:['/opt/service-alias'],exclude_runtime:true})]},Buffer,Date});
  assert.equal(JSON.parse(output.join('')).visible,true);
});
test('selected alias to an entire excluded runtime root fails closed', () => {
  const output:string[]=[];
  const fs={realpathSync:{native:()=>Buffer.from('/usr')},readlinkSync:()=> 'net:[2]',statSync:()=>{throw Error('must not walk runtime root');},writeSync:(_fd:number,data:Buffer,offset:number,length:number)=>{output.push(data.subarray(offset,offset+length).toString());return length;}};
  runInNewContext(LINUX_SOCKET_INVENTORY_PROGRAM,{require:()=>fs,process:{argv:['node',JSON.stringify({paths:['/opt/runtime-alias'],exclude_runtime:true})]},Buffer,Date});
  const result=JSON.parse(output.join(''));assert.equal(result.complete,false);assert.equal(result.count,0);assert.equal(result.limit,250000);assert.ok(result.elapsed_ms>=0);
});
test('unexpected Node probe read error exits nonzero without assessment evidence', async () => {
  const child={argv:['node',JSON.stringify({single:'/single',token:'owned'})],pid:1,exitCode:0};
  const fs={readFileSync(){throw Object.assign(Error('unexpected I/O'),{code:'EIO'});},writeSync(){throw Error('must not emit success');}};
  runInNewContext(LINUX_NODE_AUDIT_PROGRAM,{require:(name:string)=>name==='node:fs'?fs:{},process:child,Buffer,setTimeout,clearTimeout});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(child.exitCode,1);
});
