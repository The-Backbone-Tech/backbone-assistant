// Real child for the home lock's pause/crash controls; no Core, provider or shared test home.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {withHomeLock} from '../src/composition/home-lock.ts';

const [home,mode]=process.argv.slice(2);
await withHomeLock(home,async()=>{
 const state=mode==='snapshot'?JSON.parse(readFileSync(join(home,'state.json'),'utf8')) as {value:number;writer:string}:undefined;
 await new Promise<void>(resolve=>{
  process.stdin.once('data',()=>resolve());
  process.stdout.write('held\n');
 });
 if(state)writeFileSync(join(home,'state.json'),JSON.stringify({value:state.value+1,writer:'holder'}));
});
process.stdout.write('released\n');
