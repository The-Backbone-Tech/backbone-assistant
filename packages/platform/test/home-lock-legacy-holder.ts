// Real previous protocol, confined to a disposable compatibility-test home.
import {join} from 'node:path';
import lockfile from 'proper-lockfile';
const [home]=process.argv.slice(2);
const release=await lockfile.lock(home,{realpath:false,lockfilePath:join(home,'.lock'),stale:5_000,update:1_000,retries:0});
await new Promise<void>(resolve=>{process.stdin.once('data',()=>resolve());process.stdout.write('held\n');});
await release();
