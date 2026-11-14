// Keep the image immutable. PostgreSQL restores its relative library links in this disposable copy.
import {cpSync,existsSync,readdirSync,lstatSync,lchownSync,chmodSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
const require=createRequire(resolve('packages/kernel/package.json'));
const embedded=dirname(require.resolve('embedded-postgres'));
const entry=createRequire(join(embedded,'index.js')).resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
const source=join(dirname(entry),'..'),target='/pg-runtime/package';
if(!existsSync(target))cpSync(source,target,{recursive:true,verbatimSymlinks:true});
function own(path){const stat=lstatSync(path);if(stat.uid!==1000||stat.gid!==1000)lchownSync(path,1000,1000);if(stat.isDirectory())for(const name of readdirSync(path))own(join(path,name));}
own(target);
chmodSync('/tmp',0o1777);
