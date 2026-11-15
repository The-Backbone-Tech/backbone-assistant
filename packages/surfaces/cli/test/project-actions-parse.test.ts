import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse} from '../src/commands.ts';
for(const command of ['rename','archive','restore'])test(`projects ${command} parses its project id and name`,()=>{
  const parsed=parse(['projects',command,'project-id',...(command==='rename'?['New name']:[])],{BACKBONE_HOME:'/unused'});
  assert.equal(parsed.usage,undefined);assert.equal(parsed.name,`projects ${command}`);
  assert.equal(parsed.target,'project-id');if(command==='rename')assert.equal(parsed.options.name,'New name');
});
test('project rename requires both id and nonempty name',()=>{
  for(const args of [[],['id'],['id','']])assert.ok(parse(['projects','rename',...args],{BACKBONE_HOME:'/unused'}).usage);
});

test('the normal conversation list hides archived projects and --all keeps them inspectable',async()=>{
  const {runCommand}=await import('../src/commands.ts');
  const api={call:async(method:string)=>method==='projects.list'?[{id:'active'},{id:'archived',archived:true}]:[
    {id:'live',projectId:'active',title:'Visible',archived:false},
    {id:'hidden',projectId:'archived',title:'Put away',archived:false},
  ]} as unknown as import('../src/commands.ts').Api;
  for(const all of [false,true]){
    let output='';const io={out:(text:string)=>{output+=text;},err:()=>{},onInterrupt:()=>{},holding:()=>{},pollMs:1,stopWaitMs:1};
    assert.equal(await runCommand(parse(['threads','list',...(all?['--all']:[])],{BACKBONE_HOME:'/unused'}),api,io),0);
    assert.match(output,/Visible/);assert.equal(output.includes('Put away'),all);
  }
});
