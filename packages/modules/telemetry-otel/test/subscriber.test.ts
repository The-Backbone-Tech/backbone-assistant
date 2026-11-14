import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ApiEvent, Turn } from '@backbone-next/platform';
import type { TelemetryObservation } from '@backbone-next/platform/ports/telemetry';
import { startTelemetry, type TelemetryHost } from '../src/subscriber.ts';
import { createExporter } from '../src/exporter.ts';
import { ATTRIBUTES, TOOLS, type SafeAttributes } from '../src/conventions.ts';
import { TELEMETRY_TOOLS } from '@backbone-next/platform/ports/telemetry';

test('README and runtime attribute allowlist match exactly; fixed catalogue matches platform', () => {
  const readme = readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const section = readme.split('The full allowlist, including resource attributes, is:')[1].split('Only fixed')[0];
  assert.deepEqual([...section.matchAll(/^- `([^`]+)`/gm)].map(x=>x[1]),[...ATTRIBUTES]);
  assert.deepEqual([...TOOLS],[...TELEMETRY_TOOLS]);
});

test('subscriber correlates completed turn, tool, effect, goal and schedule without content or ambient attributes', async () => {
  const marker='PRIVATE_MARKER_23af9';
  const requests: string[]=[];
  const collector=createServer((req,res)=>{ let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{requests.push(JSON.stringify({url:req.url,headers:req.headers,body}));res.end('{}');}); });
  collector.listen(0,'127.0.0.1'); await once(collector,'listening');
  const endpoint=`http://127.0.0.1:${(collector.address() as {port:number}).port}/v1/traces`;
  const envNames=['OTEL_RESOURCE_ATTRIBUTES','OTEL_SERVICE_NAME','OTEL_EXPORTER_OTLP_HEADERS','OTEL_EXPORTER_OTLP_TRACES_HEADERS'];
  const prior=envNames.map(name=>process.env[name]); for(const name of envNames)process.env[name]=`secret=${marker}`;
  let events:((event:ApiEvent)=>void)|undefined, observations:((event:TelemetryObservation)=>void)|undefined;
  let projection:unknown;
  const threadId=randomUUID(),turnId=randomUUID(),runId=randomUUID();
  const host={ on(listener:(event:ApiEvent)=>void){events=listener;return()=>{events=undefined;};},async call(method:string){
    if(method==='threads.get')return {ok:true,value:projection};
    return {runs:[{id:runId,threadId,turnId,startedAt:new Date(at).toISOString(),endedAt:new Date(at+60_004).toISOString(),outcome:'done',title:marker,summary:marker}]};
  }} as unknown as TelemetryHost;
  const service=startTelemetry(host,{endpoint,observe:listener=>{observations=listener;return()=>{observations=undefined;};}})!;
  const at=Date.now()-60_000; // A run resumed after subscribing keeps its original start.
  const turn={id:turnId,side:false,user:{text:marker,at:new Date(at).toISOString(),attachments:[{name:marker,materialId:randomUUID(),version:1}]},answer:{text:marker,files:[{name:marker,materialId:randomUUID(),version:1}]},work:{startedAt:new Date(at).toISOString(),endedAt:new Date(at+60_003).toISOString(),harness:marker,steps:[{kind:'read',label:marker}],usage:{input:12,output:4}},effects:[],status:'done'} as Turn;
  projection={turns:[turn,{...turn,id:randomUUID()}],sideTurns:[],goalRun:{threadId,startedAt:new Date(at).toISOString(),updatedAt:new Date(at+60_005).toISOString(),status:'met',used:1,goal:marker,detail:marker}};
  try {
    observations!({kind:'turn',threadId,turnId,runId,engineId:marker,routeId:marker,at});
    observations!({kind:'tool',threadId,turnId,tool:'read',startedAt:at,endedAt:at+1,outcome:'done'});
    observations!({kind:'effect',threadId,turnId,effectId:randomUUID(),phase:'held',at:at+2,outcome:'held'});
    events!({topic:'threads',id:threadId,urgent:marker}); events!({topic:'schedules'});
    await service.flush();
    assert.ok(requests.length); assert.ok(!requests.join('').includes(marker));
    const spans=requests.flatMap(request=>JSON.parse(JSON.parse(request).body).resourceSpans.flatMap((resource:any)=>{
      for(const attribute of resource.resource.attributes)assert.ok(ATTRIBUTES.includes(attribute.key));
      return resource.scopeSpans.flatMap((scope:any)=>scope.spans);
    }));
    assert.deepEqual(spans.map((span:any)=>span.name).sort(),['effect','execute_tool','goal','invoke_agent','schedule']);
    const root=spans.find((span:any)=>span.name==='invoke_agent');
    for(const span of spans){
      for(const attribute of span.attributes)assert.ok(ATTRIBUTES.includes(attribute.key));
      assert.equal(span.events.length,0);assert.equal(span.links.length,0);assert.equal(span.status.message,undefined);
      if(['effect','execute_tool','schedule'].includes(span.name)){assert.equal(span.parentSpanId,root.spanId);assert.equal(span.traceId,root.traceId);}
    }
    const attrs=Object.fromEntries(root.attributes.map((a:any)=>[a.key,a.value.stringValue??a.value.intValue]));
    assert.equal(attrs['backbone.thread.id'],threadId); assert.equal(attrs['backbone.turn.id'],turnId);assert.equal(attrs['backbone.run.id'],runId);
    assert.equal(Number(attrs['gen_ai.usage.input_tokens']),12);
  } finally {
    await service.close(); collector.closeAllConnections();await new Promise<void>(r=>collector.close(()=>r()));
    envNames.forEach((name,i)=>{if(prior[i]===undefined)delete process.env[name];else process.env[name]=prior[i];});
  }
});

test('unexpected keys and free-form attribute values are never serialized',async()=>{
  const bodies:string[]=[];
  const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{bodies.push(body);res.end('{}');});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const exporter=createExporter({endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/traces`});
  try{
    const marker='PRIVATE_MARKER_762';
    exporter.emit('tool',Date.now(),Date.now(),{'gen_ai.tool.name':marker,'backbone.outcome':marker,'backbone.effect.phase':marker,'backbone.thread.id':marker,'arbitrary.content':marker} as SafeAttributes);
    await exporter.flush();assert.ok(bodies.length);assert.ok(!bodies.join('').includes(marker));assert.ok(!bodies.join('').includes('arbitrary.content'));
  }finally{await exporter.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('normal close delivers a final root; a hanging collector cannot hold shutdown', async () => {
  for (const hang of [false,true]) {
    const bodies:string[]=[];
    const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{bodies.push(body);if(!hang)res.end('{}');});});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    let event:((event:ApiEvent)=>void)|undefined;
    const threadId=randomUUID(),turnId=randomUUID();
    let turn:unknown;
    const host={on(listener:(e:ApiEvent)=>void){event=listener;return()=>{event=undefined;};},async call(){return {ok:true,value:{turns:[turn],sideTurns:[]}};}} as unknown as TelemetryHost;
    const service=startTelemetry(host,{endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/traces`,timeoutMs:100})!;
    const at=new Date().toISOString();
    turn={id:turnId,status:'done',work:{startedAt:at,endedAt:at,steps:[]},effects:[]};
    try {
      event!({topic:'threads',id:threadId});
      const started=performance.now(); await service.close();
      assert.ok(performance.now()-started<500,'shutdown is bounded independently of collector');
      assert.equal(bodies.length,1);
      assert.equal(JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0].spans[0].name,'invoke_agent');
      assert.equal(service.stats.dropped,hang?1:0);
      assert.equal(service.stats.queued,0);
    } finally {await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }
});

for (const inFlight of [false, true]) test(`close re-reads a running turn before its final notification (read in flight=${inFlight})`, async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { bodies.push(body); res.end('{}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let event: ((event: ApiEvent) => void) | undefined;
  const threadId = randomUUID(), turnId = randomUUID();
  const at = new Date().toISOString();
  const turn = { id: turnId, status: 'running', work: { startedAt: at, endedAt: at, steps: [] }, effects: [] };
  let reads = 0;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const host = {
    on(listener: (event: ApiEvent) => void) { event = listener; return () => { event = undefined; }; },
    async call() {
      reads++;
      const snapshot = structuredClone(turn);
      if (reads === 1) { entered(); if (inFlight) await released; }
      return { ok: true, value: { turns: [snapshot], sideTurns: [] } };
    },
  } as unknown as TelemetryHost;
  const service = startTelemetry(host, { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces` })!;
  turn.work.startedAt = new Date().toISOString();
  try {
    event!({ topic: 'threads', id: threadId });
    const flushed = service.flush();
    await reading;
    if (!inFlight) await flushed;
    assert.equal(reads, 1); assert.equal(bodies.length, 0);
    turn.status = 'done'; // The caller can see this before the Host publishes its final event.
    const closed = service.close();
    release();
    await closed; await flushed;
    assert.equal(reads, 2, 'shutdown must refresh the last running projection');
    assert.equal(bodies.length, 1);
    const spans = JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 1); assert.equal(spans[0].name, 'invoke_agent');
    assert.equal(service.stats.dropped, 0);
  } finally {
    release();
    await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const outcome of ['failed', 'refused'] as const) {
  test(`${outcome} turn detail stays local and never becomes a span status message`, async () => {
    const marker = `PRIVATE_${outcome.toUpperCase()}_TURN_DETAIL_6ec91`;
    const requests: string[] = [];
    const collector = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => { requests.push(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body })); res.end('{}'); });
    });
    collector.listen(0, '127.0.0.1'); await once(collector, 'listening');
    let event: ((event: ApiEvent) => void) | undefined;
    const threadId = randomUUID(), turnId = randomUUID();
    let turn: Turn;
    const host = {
      on(listener: (event: ApiEvent) => void) { event = listener; return () => { event = undefined; }; },
      async call() { return { ok: true, value: { turns: [turn], sideTurns: [] } }; },
    } as unknown as TelemetryHost;
    const service = startTelemetry(host, { endpoint: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces` })!;
    const at = new Date().toISOString();
    turn = {
      id: turnId, side: false, user: { text: 'A local lifecycle fixture.', at, attachments: [] },
      work: { startedAt: at, endedAt: at, harness: 'fixture', steps: [] }, effects: [],
      ...(outcome === 'failed' ? { status: 'stopped' as const, failure: { detail: marker } }
        : { status: 'refused' as const, refusal: { reason: 'NOT_AVAILABLE' as const, detail: marker } }),
    };
    try {
      assert.equal(outcome === 'failed' ? turn.failure?.detail : turn.refusal?.detail, marker, 'the projection really contains the private detail');
      event!({ topic: 'threads', id: threadId });
      await service.flush();
      assert.ok(requests.length > 0);
      assert.ok(!requests.join('').includes(marker), 'scan the complete collector request, including status messages');
      const spans = requests.flatMap(request => JSON.parse(JSON.parse(request).body).resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
      assert.equal(spans.length, 1); assert.equal(spans[0].name, 'invoke_agent');
      const attrs = Object.fromEntries(spans[0].attributes.map((entry: any) => [entry.key, entry.value.stringValue ?? entry.value.intValue]));
      assert.equal(attrs['backbone.outcome'], outcome); assert.equal(attrs['backbone.turn.id'], turnId);
      assert.equal(spans[0].status.message, undefined);
    } finally {
      await service.close(); collector.closeAllConnections(); await new Promise<void>(resolve => collector.close(() => resolve()));
    }
  });
}
