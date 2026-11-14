// Die after the kernel creates the socket, before Node runs the listening callback.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {ownHome,ownerSocket} from '../src/composition/home-owner.ts';

const [home,account,mode]=process.argv.slice(2),readOnly=mode==='read';
const user=os.userInfo();os.userInfo=(()=>({...user,homedir:account})) as typeof os.userInfo;syncBuiltinESMExports();
const target=ownerSocket(home,readOnly),listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(this:net.Server,...args:Parameters<typeof listen>){
 const server=Reflect.apply(listen,this,args);
 if(args[0]===target&&fs.existsSync(target)){
  fs.writeSync(1,'bound\n');process.kill(process.pid,'SIGKILL');
 }
 return server;
} as typeof listen;
process.umask(0o022);
await ownHome(home,{readOnly});
throw new Error('The crash control did not reach socket creation.');
