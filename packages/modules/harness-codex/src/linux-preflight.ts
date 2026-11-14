// Node-only observations of the pinned native sandbox, never filesystem/network enforcement.
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile, rename, rm, readlink, lstat, readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { filesystemOverride, type NativeEnvironment } from './native.ts';
import { assessLinuxAudit } from './linux-audit.ts';
import type { SandboxCommand } from './readonly-proof.ts';

export const LINUX_NODE_AUDIT_PROGRAM = String.raw`
// backbone-linux-node-audit-v1
const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
const spec=JSON.parse(process.argv[1]);
function emit(value){const data=Buffer.from(JSON.stringify(value)+'\n');let n=0;while(n<data.length)n+=fs.writeSync(1,data,n,data.length-n);}
const denied=error=>['EACCES','EPERM','ENOENT','ENOTDIR','EROFS','EAFNOSUPPORT','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(error.code);
function read(path,kind='file',token){try{const value=kind==='directory'?fs.readdirSync(path):fs.readFileSync(path,'utf8');return token!==undefined && value!==token?'denied':'allowed';}catch(error){if(denied(error))return 'denied';throw error;}}
function udp(port,dns){return new Promise((resolve,reject)=>{
  let socket;try{socket=dgram.createSocket('udp4');}catch(error){if(denied(error)){resolve('denied');return;}reject(error);return;}
  let settled=false;const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);try{socket.close();}catch(closeError){if(closeError.code!=='ERR_SOCKET_DGRAM_NOT_RUNNING'){reject(closeError);return;}}if(error&&!denied(error))reject(error);else resolve(error?'denied':'allowed');};
  const timer=setTimeout(()=>finish({code:'ENETUNREACH'}),1000);
  socket.on('error',finish);socket.on('message',message=>{if(dns && (message[0]!==18||message[1]!==52||message[2]!==129))finish(Error('DNS control'));else finish();});
  const payload=dns?Buffer.from('123401000001000000000000056f776e656407696e76616c69640000010001','hex'):Buffer.from(spec.token);
  socket.send(payload,port,'127.0.0.1',error=>{if(error)finish(error);});
});}
function stream(path){return new Promise((resolve,reject)=>{
  let socket;try{socket=net.createConnection(path);}catch(error){if(denied(error)){resolve('denied');return;}reject(error);return;}
  let settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(error&&!denied(error))reject(error);else resolve(error?'denied':'allowed');};
  const timer=setTimeout(()=>finish({code:'ENETUNREACH'}),1000);socket.once('error',finish);socket.once('connect',()=>finish());
});}
(async()=>{
  const single_file_initial=read(spec.single,'file',spec.token);emit({ready:true,single_file_initial});
  const deadline=Date.now()+10000;while(!fs.existsSync(spec.release)){if(Date.now()>deadline)throw Error('release timeout');await new Promise(resolve=>setTimeout(resolve,10));}
  const result={single_file_initial,single_file_renamed:read(spec.single,'file',spec.token),created_path:read(spec.late+'/canary','file',spec.token),data_home:read(spec.data+'/canary','file',spec.token),arrangement:read(spec.arrangement+'/canary','file',spec.token)};
  result.run_visible=fs.existsSync('/run');
  result.extra_denies=spec.extra.map(target=>read(target.path,target.kind));
  result.udp=await udp(spec.udp,false);result.dns=await udp(spec.dns,true);
  result.unix_stream=await stream(spec.stream);result.abstract_stream=await stream(spec.abstract);
  result.network_namespace_distinct=fs.readlinkSync('/proc/self/ns/net')!==spec.host_net;
  try{result.pid_namespace_distinct=fs.readlinkSync('/proc/self/ns/pid')!==spec.host_pid_ns;result.fresh_proc=result.pid_namespace_distinct&&fs.readlinkSync('/proc/self')===String(process.pid);}catch(error){if(!denied(error))throw error;result.pid_namespace_distinct=null;result.fresh_proc=false;}
  result.proc_cmdline=read('/proc/'+spec.host_pid+'/cmdline');result.proc_environ=read('/proc/'+spec.host_pid+'/environ');emit(result);
})().catch(()=>{process.exitCode=1;});
`;

/** All Node-capable cases per turn/profile; raw Unix datagram sendmsg is CI-only (no Node API). */
export async function verifyLinuxAudit(command: SandboxCommand, work: string, stage: string, environment: NativeEnvironment, node: string, extraDenies: readonly string[]) {
  const token=randomBytes(16).toString('hex'), root=join(work,'linux-audit-'+token), release=join(stage,'.linux-audit-release-'+token);
  const host_net=await readlink('/proc/self/ns/net'), host_pid_ns=await readlink('/proc/self/ns/pid');
  // Positive Host controls never log the process bytes or enumerate existing services.
  if (!(await readFile(`/proc/${process.pid}/cmdline`)).length || !(await readFile(`/proc/${process.pid}/environ`)).length) throw Error('Linux proc positive control failed.');
  await mkdir(root,{mode:0o700});
  const single=join(root,'single'),late=join(root,'late'),data=join(root,'data-home'),arrangement=join(root,'arrangement');
  const hits: string[]=[];
  const udp=createSocket('udp4'),dns=createSocket('udp4');
  const stream=createServer(peer=>{hits.push('unix_stream');peer.destroy();});
  const abstract=createServer(peer=>{hits.push('abstract_stream');peer.destroy();});
  const sockets=[udp,dns,stream,abstract];
  let writer: Promise<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for(const path of [data,arrangement]){await mkdir(path);await writeFile(join(path,'canary'),token);}
    await writeFile(single,token);
    const extra: {path:string;kind:string}[]=[];
    for(const path of extraDenies){
      try {const stat=await lstat(path);if(stat.isDirectory()){await readdir(path);extra.push({path,kind:'directory'});}else if(stat.isFile()){await readFile(path);extra.push({path,kind:'file'});}else throw Error('Unsupported Linux denied-path positive control.');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Linux denied-path positive control failed.');}
    }
    for(const [socket,name] of [[udp,'udp'],[dns,'dns']] as const){
      socket.on('message',(message,peer)=>{hits.push(name);const reply=name==='dns'?Buffer.concat([message.subarray(0,2),Buffer.from([129,128]),message.subarray(4)]):Buffer.from(token);socket.send(reply,peer.port,peer.address);});
      await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'127.0.0.1',resolve);});
    }
    const path=join(root,'stream'),abstractPath='\0backbone-audit-'+process.pid+'-'+token;
    for(const [server,address] of [[stream,path],[abstract,abstractPath]] as const)await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
    // Completed owned-listener controls precede clearing the delivery counters.
    const { connect }=await import('node:net');
    for(const address of [path,abstractPath])await new Promise<void>((resolve,reject)=>{const peer=connect(address);peer.once('error',reject);peer.once('close',()=>resolve());});
    for(const [socket,isDns] of [[udp,false],[dns,true]] as const)await new Promise<void>((resolve,reject)=>{
      const peer=createSocket('udp4');const deadline=setTimeout(()=>{peer.close();reject(Error('Linux UDP positive control timeout.'));},1000);
      peer.once('error',reject);peer.once('message',message=>{clearTimeout(deadline);peer.close();if(isDns&&message[2]!==129)reject(Error('Linux DNS positive control failed.'));else resolve();});
      const address=socket.address();peer.send(isDns?Buffer.from('123401000001000000000000056f776e656407696e76616c69640000010001','hex'):Buffer.from(token),address.port,'127.0.0.1');
    });
    hits.length=0;
    let ready!: (value: unknown)=>void, failed!: (error: Error)=>void;
    const readiness=new Promise<unknown>((resolve,reject)=>{ready=resolve;failed=reject;});
    timer=setTimeout(()=>failed(Error('Linux security probe readiness timeout.')),10000);
    const spec={token,single,late,data,arrangement,release,extra,udp:udp.address().port,dns:dns.address().port,stream:path,abstract:abstractPath,host_net,host_pid_ns,host_pid:process.pid};
    writer=command(['sandbox','-C',stage,'-P','backbone-native-staged','-c',filesystemOverride(environment,[...extraDenies,single,late,data,arrangement]),'-c','permissions.backbone-native-staged.network.enabled=false','--',node,'--openssl-config=/dev/null','-e',LINUX_NODE_AUDIT_PROGRAM,JSON.stringify(spec)],output=>{
      if(output.includes('\n'))try{ready(JSON.parse(output.split('\n')[0]!));}catch{failed(Error('Invalid Linux security readiness.'));}
    });
    let exited=false;void writer.then(()=>{exited=true;failed(Error('Linux security probe exited before release.'));},()=>{exited=true;failed(Error('Linux security probe command failed.'));});
    const proof=await readiness;
    if(JSON.stringify(proof)!==JSON.stringify({ready:true,single_file_initial:'denied'})||exited)throw Error('Linux single-file deny was not established.');
    await writeFile(single+'.replacement',token);await rename(single+'.replacement',single);await mkdir(late);await writeFile(join(late,'canary'),token);await writeFile(release,token,{flag:'wx'});
    const lines=(await writer).trim().split('\n');if(lines.length!==2)throw Error('Invalid Linux security probe output.');
    const result=JSON.parse(lines[1]!);
    if(!Array.isArray(result.extra_denies)||result.extra_denies.length!==extra.length||result.extra_denies.some((value:unknown)=>value!=='denied'))throw Error('Linux configured deny was readable.');
    delete result.extra_denies;result.host_hits=[...hits];
    return assessLinuxAudit(environment,result,'node');
  } finally {
    clearTimeout(timer);
    if(writer){await writeFile(release,token).catch(()=>{});await writer.catch(()=>{});}
    for(const socket of sockets)try{socket.close();}catch{}
    await rm(release,{force:true});await rm(root,{recursive:true,force:true});
  }
}
