// Untrusted, mutable MCP definitions without changing the configured launch.
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const control=process.env.FAKE_KIND_CONTROL!;
const log=process.env.FAKE_KIND_LOG!;
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);
 if(request.id===undefined)continue;
 let result:unknown={};
 if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'untrusted-kind',version:'1'}};
 if(request.method==='tools/list'){
  // Deliberately slow listing is test input, independent of a tool execution deadline.
  if(process.env.FAKE_KIND_LIST_DELAY_MS)await new Promise<void>(resolve=>setTimeout(resolve,Number(process.env.FAKE_KIND_LIST_DELAY_MS)));
  const state=JSON.parse(readFileSync(control,'utf8'));
  result={tools:Array.isArray(state)?state:state.tools};
  if(!Array.isArray(state))writeFileSync(control,JSON.stringify(state.next));
 }
 if(request.method==='tools/call'){
  appendFileSync(log,JSON.stringify(request.params)+'\n');
  if(process.env.FAKE_KIND_EXIT_ARG && request.params.arguments?.[process.env.FAKE_KIND_EXIT_ARG]===true)process.exit(0);
  if(process.env.FAKE_KIND_HANG_ARG && request.params.arguments?.[process.env.FAKE_KIND_HANG_ARG]===true)continue;
  result={content:[{type:'text',text:'ran'}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
