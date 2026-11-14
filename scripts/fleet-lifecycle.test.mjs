import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {prepareFleetHome} from '../deploy/helm/backbone/files/prepare.mjs';
const files = resolve(import.meta.dirname, '../deploy/helm/backbone/files');
const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('policy copy turns projected symlinks into regular protected files without altering signed bytes', t => {
  const root = temporary(t), source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(source); mkdirSync(target);
  const keys = ['managed-policy.json', 'managed-policy.json.sig', 'policy-trust.json'];
  for (const key of keys) {
    writeFileSync(join(source, `real-${key}`), `signed bytes for ${key}\n`);
    symlinkSync(`real-${key}`, join(source, key));
  }
  const ownership = [],admitted=[];
  // Exercise real copying and modes. Runtime acceptance asserts the resulting files' actual uid 0.
  prepareFleetHome({data:root,source,target,admit:dir=>admitted.push(dir),ownership:{chownSync:(...args)=>ownership.push(args),fchownSync:()=>{}}});
  assert.ok(admitted.includes(join(root,'home')));assert.ok(admitted.includes(join(root,'backups')));
  for (const key of keys) {
    const path = join(target, key), stat = lstatSync(path);
    assert.ok(stat.isFile()); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o022, 0);
    assert.deepEqual(readFileSync(path), readFileSync(join(source, key)));
    assert.ok(ownership.some(([p, uid, gid]) => p === path && uid === 0 && gid === 0));
  }
});

test('readiness requires successful doctor properties and a live daemon, independent of diagnostic wording', t => {
  const root = temporary(t), cliDir = join(root, 'packages/surfaces/cli/src');
  mkdirSync(cliDir, {recursive:true});
  writeFileSync(join(root, 'daemon.json'), JSON.stringify({pid:process.pid}));
  const invoke = (report, exit = 0) => {
    writeFileSync(join(cliDir, 'main.ts'), `console.log(${JSON.stringify(JSON.stringify(report))});process.exit(${exit});`);
    return spawnSync(process.execPath, [join(files, 'ready.mjs')], {cwd:root, env:{...process.env, BACKBONE_HOME:root}}).status;
  };
  assert.equal(invoke({ok:true,checks:[{name:'holder',status:'ok',detail:'arbitrary human wording'}]}), 0);
  assert.equal(invoke({ok:true,checks:[{name:'holder',status:'warn'}]}), 1);
  assert.equal(invoke({ok:false,checks:[{name:'holder',status:'ok'}]}), 1);
  assert.equal(invoke({ok:true,checks:[{name:'holder',status:'ok'}]}, 1), 1);
  rmSync(join(root, 'daemon.json'));
  assert.equal(invoke({ok:true,checks:[{name:'holder',status:'ok'}]}), 1);
});

async function lifecycle(t, phase, { failHome, backupFails = false, existingBackup = false, backupPending = false, controllerUnobserved = false, malformedDelete = false } = {}) {
  temporary(t); // No home, Kubernetes client or retained job is shared between tests.
  const actions = [], sets = ['alpha','beta'].map(home => ({metadata:{name:`fleet-${home}`,generation:2},spec:{template:{spec:{containers:[{image:'new@sha256:222'}]}}},status:{observedGeneration:controllerUnobserved?1:2,updateRevision:'new'}}));
  const pods = new Map(sets.map(set => [set.metadata.name+'-0',{metadata:{uid:set.metadata.name,labels:{'controller-revision-hash':phase === 'backup' ? 'new' : 'old'}},spec:{containers:[{image:'old@sha256:111',env:[{name:'BACKBONE_MODEL_ID',value:'模型'}],volumeMounts:[],readinessProbe:{}}],volumes:[{name:'runtime',configMap:{name:'old-runtime'}}],initContainers:[{name:'prepare',volumeMounts:[]},{name:'postgres-cache',volumeMounts:[]}]},status:{conditions:[{type:'Ready',status:'True'}]}}]));
  const jobs = new Map();
  const fake = {request(url, options, callback) {
    const req = new EventEmitter(); req.destroy = error => req.emit('error',error);
    req.end = bytes => queueMicrotask(() => {
      const path = new URL(url).pathname, name = path.split('/').at(-1), body = bytes ? JSON.parse(bytes) : null;
      if(bytes) assert.equal(Number(options.headers['Content-Length']),Buffer.byteLength(bytes),'mutating Kubernetes requests must frame their UTF-8 bodies explicitly');
      actions.push({method:options.method,path,body}); let value;
      if (path.endsWith('/statefulsets')) value = {items:sets};
      else if (path.includes('/statefulsets/') && name !== 'scale') value = sets.find(s=>s.metadata.name===name);
      else if (name === 'scale') {
        const home = path.split('/').at(-2), pod = home+'-0';
        if (body.spec.replicas === 0) pods.delete(pod);
        else pods.set(pod,{metadata:{uid:home+'-restarted',labels:{'controller-revision-hash':'new'}},status:{conditions:[{type:'Ready',status:'True'}]}});
        value = {};
      } else if (path.includes('/jobs')) {
        if (options.method === 'POST') {jobs.set(body.metadata.name,{status:backupPending?{}:backupFails?{failed:1}:{succeeded:1}});value={};}
        else if (options.method === 'DELETE') {if(malformedDelete)value='400 Bad Request';else{jobs.delete(name);value={};}}
        else value=jobs.get(name) ?? (existingBackup ? {status:{succeeded:1}} : null);
      } else if (options.method === 'DELETE') {
        const home = name.replace(/-0$/,'');
        pods.set(name,{metadata:{uid:home+'-new',labels:{'controller-revision-hash':'new'}},status:{conditions:[{type:'Ready',status:home===failHome?'False':'True'}]}});
        value={};
      } else value=pods.get(name);
      const response = new EventEmitter(); response.statusCode=typeof value==='string'?400:value?200:404; callback(response);
      response.emit('data',typeof value==='string'?value:JSON.stringify(value??{})); response.emit('end');
    });
    return req;
  }};
  const source = readFileSync(join(files, 'rollout.mjs'), 'utf8').replace(/^import .*;$/mg,'');
  const execute = new Function('https','readFileSync','process','setTimeout','console',`return (async()=>{${source}})()`);
  // A zero test deadline takes the failure path immediately; production schema bounds it to >=30s.
  let error;
  try {await execute(fake,()=>'',{env:{NAMESPACE:'test',RELEASE:'fleet',REVISION:'2',TIMEOUT:'0',HOMES:JSON.stringify(['fleet-alpha','fleet-beta']),RUNTIME_CONFIGMAP:'new-runtime',RETENTION:'3'},argv:['node','script',phase]},fn=>{fn();}, {log(){}});} catch(e){error=e;}
  return {actions,error};
}

test('backup runs old images after stopping writers, restores replicas, and disables automatic retries', async t => {
  const {actions,error}=await lifecycle(t,'backup'); assert.ifError(error);
  const posts=actions.filter(a=>a.method==='POST'); assert.equal(posts.length,2);
  for (const post of posts) {
    assert.equal(post.body.spec.template.spec.containers[0].image,'old@sha256:111');
    assert.equal(post.body.spec.backoffLimit,0);
    assert.equal(post.body.spec.template.spec.automountServiceAccountToken,false);
    assert.equal(post.body.spec.template.spec.volumes.find(v=>v.name==='backups').persistentVolumeClaim.claimName,post.body.metadata.name+'s');
    assert.equal(post.body.spec.template.spec.volumes.find(v=>v.name==='runtime').configMap.name,'new-runtime');
    const index=actions.indexOf(post);
    assert.ok(actions.slice(0,index).some(a=>a.method==='PATCH'&&a.body.spec.replicas===0));
    assert.ok(actions.slice(index).some(a=>a.method==='PATCH'&&a.body.spec.replicas===1));
  }
});

test('a failed backup restores the old replica and leaves later homes untouched', async t => {
  const {actions,error}=await lifecycle(t,'backup',{backupFails:true}); assert.ok(error);
  assert.equal(actions.filter(a=>a.method==='POST').length,1);
  assert.ok(actions.some(a=>a.method==='PATCH'&&a.body.spec.replicas===1));
  assert.equal(actions.some(a=>a.path.includes('fleet-beta')),false);
});

test('interrupted backup state is inspected rather than repeated', async t => {
  const {actions,error}=await lifecycle(t,'backup',{existingBackup:true}); assert.ok(error);
  assert.equal(actions.some(a=>a.method==='POST'),false);
});

test('a failed readiness stops replacement before the next home; rollback replaces back to the requested revision', async t => {
  const failed=await lifecycle(t,'rollout',{failHome:'fleet-alpha'}); assert.ok(failed.error);
  assert.equal(failed.actions.filter(a=>a.method==='DELETE').length,1);
  const recovered=await lifecycle(t,'rollout'); assert.ifError(recovered.error);
  assert.equal(recovered.actions.filter(a=>a.method==='DELETE').length,2);
  for (const action of recovered.actions.filter(a=>a.method==='DELETE')) assert.ok(action.body.preconditions.uid);
});


test('an active or unconfirmed backup never restarts a competing writer', async t => {
  const {actions,error}=await lifecycle(t,'backup',{backupPending:true}); assert.ok(error);
  assert.equal(actions.some(a=>a.method==='PATCH'&&a.body.spec.replicas===1),false);
  assert.equal(actions.some(a=>a.path.includes('fleet-beta')),false);
});

test('rollout waits for the controller to observe the desired generation before replacing pods', async t => {
  const {actions,error}=await lifecycle(t,'rollout',{controllerUnobserved:true}); assert.ok(error);
  assert.equal(actions.some(a=>a.method==='DELETE'),false);
});


test('a non-JSON Kubernetes error rejects normally, preserves evidence and restores the confirmed stopped home', async t => {
  const {actions,error}=await lifecycle(t,'backup',{malformedDelete:true});assert.ok(error);
  assert.equal(actions.filter(a=>a.method==='DELETE').length,1);
  assert.ok(actions.some(a=>a.method==='PATCH'&&a.body.spec.replicas===1));
  assert.equal(actions.some(a=>a.path.includes('fleet-beta')),false);
});


test('unsupported storage is refused before the init container creates a data home', t => {
  const root=temporary(t);
  assert.throws(()=>prepareFleetHome({data:root,source:root,target:root,admit:()=>{throw new Error('unsupported filesystem');}}));
  assert.throws(()=>lstatSync(join(root,'home')));
});
