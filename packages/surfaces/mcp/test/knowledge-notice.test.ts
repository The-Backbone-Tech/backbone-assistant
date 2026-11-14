// The official client and actual server adapter must preserve additive policy notices.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import type {Gateway} from '@backbone-next/platform/gateway';
import {createDoorServer} from '../src/server.ts';
test('a successful empty recall keeps its source-withheld notice across the MCP serialization',async()=>{
 const notice={kind:'source-withheld' as const,detail:'Synthetic policy coverage; recorded material is retained.'};
 const gateway={async call(){return{ok:true as const,value:[],notice};},async close(){}} as Gateway;
 const server=createDoorServer(gateway,{async open(){return null;}});
 const client=new Client({name:'synthetic-notice',version:'0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const result=await client.callTool({name:'recall_knowledge',arguments:{}});
  assert.equal(result.isError,false);
  assert.deepEqual(result.structuredContent,{ok:true,value:[],notice});
  assert.match(JSON.stringify(result.content),/source-withheld/);
 }finally{await client.close();await server.close();}
});
