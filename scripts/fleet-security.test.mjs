import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import Ajv from 'ajv';
const root=resolve(import.meta.dirname,'..'),chart=join(root,'deploy/helm/backbone');
const raw=()=>JSON.parse(readFileSync(join(chart,'values.yaml'),'utf8'));
const configured=()=>({...raw(),trial:{plaintextKeysAcknowledged:true},namespace:{name:'fleet',dedicated:true,podSecurity:'baseline'},storage:{className:'encrypted-block',size:'10Gi',encryptionConfirmed:true},backups:{className:'encrypted-backups',size:'20Gi',encryptionConfirmed:true,retention:{maxArchives:3}},network:{apiServerCidrs:['10.0.0.1/32'],modelEgress:[]}});
const validate=new Ajv({allErrors:true}).compile(JSON.parse(readFileSync(join(chart,'values.schema.json'),'utf8')));
function render(t,v=configured()){
 const dir=mkdtempSync(join(tmpdir(),'fleet-security-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'values.json');writeFileSync(file,JSON.stringify(v));
 return execFileSync('helm',['template','fleet',chart,'-n','fleet','-f',file],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split(/^---\s*$/m).map(s=>s.replace(/^#.*$/mg,'').trim()).filter(Boolean).map(s=>JSON.parse(s));
}
const userContext={runAsUser:1000,runAsGroup:1000,runAsNonRoot:true,allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}};
const rootContext={runAsUser:0,runAsGroup:0,allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL'],add:['CHOWN']}};
test('deployment refuses unacknowledged plaintext, unconfirmed storage, shared namespaces and credential-bearing endpoints',()=>{
 assert.equal(validate(raw()),false);
 assert.equal(validate(configured()),true,JSON.stringify(validate.errors));
 for(const change of [v=>v.trial.plaintextKeysAcknowledged=false,v=>v.storage.encryptionConfirmed=false,v=>v.backups.encryptionConfirmed=false,v=>delete v.backups,v=>v.backups.retention.maxArchives=0,v=>v.namespace.dedicated=false,v=>v.namespace.podSecurity='privileged',v=>v.network.apiServerCidrs=[]]){const v=configured();change(v);assert.equal(validate(v),false);}
 for(const endpoint of ['https://user:token@host/v1','http://user@host','https://host/v1?key=secret','https://host?api_key=secret','https://host/#token']){const v=configured();v.homes[0].modelRoute.endpoint=endpoint;assert.equal(validate(v),false);}
 for(const endpoint of ['','http://model.svc:8000/v1','https://model.example/v1']){const v=configured();v.homes[0].modelRoute.endpoint=endpoint;assert.equal(validate(v),true);}
});
const helmAvailable=spawnSync('helm',['version','--short'],{stdio:'ignore'}).status===0;
if(helmAvailable){
test('rendered Role is limited to known homes and backup names, with explicit token opt-in',t=>{
 const objects=render(t),names=['fleet-alpha','fleet-beta'];
 assert.deepEqual(objects.find(o=>o.kind==='Role').rules,[
  {apiGroups:['apps'],resources:['statefulsets'],verbs:['get'],resourceNames:names},
  {apiGroups:['apps'],resources:['statefulsets/scale'],verbs:['get','patch'],resourceNames:names},
  {apiGroups:[''],resources:['pods'],verbs:['get','delete'],resourceNames:names.map(n=>n+'-0')},
  {apiGroups:['batch'],resources:['jobs'],verbs:['get','delete'],resourceNames:names.map(n=>n+'-backup')},
  {apiGroups:['batch'],resources:['jobs'],verbs:['create']},
 ]);
 assert.equal(objects.find(o=>o.kind==='ServiceAccount').automountServiceAccountToken,false);
 for(const j of objects.filter(o=>o.kind==='Job')){assert.equal(j.spec.template.spec.automountServiceAccountToken,true);assert.equal(j.spec.template.spec.serviceAccountName,'fleet-rollout');}
 const admission=objects.find(o=>o.kind==='ValidatingAdmissionPolicy');assert.ok(admission);assert.equal(admission.spec.failurePolicy,'Fail');assert.ok(admission.spec.validations.length>5);
 assert.deepEqual(objects.find(o=>o.kind==='ValidatingAdmissionPolicyBinding').spec.validationActions,['Deny']);
});
test('homes and hooks have exact security contexts, no external Service and separate retained backup claims',t=>{
 const objects=render(t);
 for(const s of objects.filter(o=>o.kind==='StatefulSet')){
  const p=s.spec.template.spec;assert.equal(p.automountServiceAccountToken,false);assert.deepEqual(p.securityContext,{seccompProfile:{type:'RuntimeDefault'}});
  for(const c of p.containers){assert.deepEqual(c.securityContext,userContext);assert.equal(c.image,`${configured().image.repository}@${configured().image.digest}`);}
  for(const c of p.initContainers){assert.deepEqual(c.securityContext,rootContext);assert.equal(c.image,`${configured().image.repository}@${configured().image.digest}`);}
  assert.ok(p.volumes.some(v=>v.name==='pg-runtime'&&v.emptyDir));assert.ok(p.volumes.some(v=>v.name==='scratch'&&v.emptyDir));
  assert.equal(p.containers[0].env.find(e=>e.name==='BACKBONE_POSTGRES_NATIVE').value,'/pg-runtime/package/native');
  assert.equal(p.volumes.some(v=>v.name==='backups'),false,'homes cannot read backup archives');
 }
 for(const j of objects.filter(o=>o.kind==='Job')){assert.deepEqual(j.spec.template.spec.securityContext,{runAsUser:1000,runAsNonRoot:true,seccompProfile:{type:'RuntimeDefault'}});for(const c of j.spec.template.spec.containers){assert.deepEqual(c.securityContext,userContext);assert.equal(c.image,`${configured().image.repository}@${configured().image.digest}`);}}
 for(const service of objects.filter(o=>o.kind==='Service'))assert.deepEqual(service.spec,{type:'ClusterIP',clusterIP:'None',selector:{'app.kubernetes.io/instance':'fleet','app.kubernetes.io/component':'home','backbone.home':service.metadata.name.endsWith('alpha')?'alpha':'beta'},ports:[{name:'identity',port:9,targetPort:9}]});
 const claims=objects.filter(o=>o.kind==='PersistentVolumeClaim');assert.deepEqual(claims.map(c=>c.metadata.name).sort(),['fleet-alpha-backups','fleet-beta-backups']);for(const c of claims){assert.equal(c.metadata.annotations['helm.sh/resource-policy'],'keep');assert.equal(c.spec.storageClassName,'encrypted-backups');}
 const ns=objects.find(o=>o.kind==='Namespace');assert.equal(ns.metadata.name,'fleet');assert.equal(ns.metadata.labels['pod-security.kubernetes.io/enforce'],'baseline');assert.equal(ns.metadata.annotations['helm.sh/resource-policy'],'keep');
});
test('network isolation denies ingress and allows only DNS, configured model routes and the hook API route',t=>{
 const objects=render(t),policies=objects.filter(o=>o.kind==='NetworkPolicy');assert.equal(policies.length,3);
 const deny=policies.find(o=>o.metadata.name.endsWith('-deny'));assert.deepEqual(deny.spec.policyTypes,['Ingress','Egress']);assert.deepEqual(deny.spec.ingress,[]);assert.deepEqual(deny.spec.egress,[]);
 const home=policies.find(o=>o.metadata.name.endsWith('-home-egress'));assert.equal(home.spec.egress.length,1);assert.deepEqual(home.spec.egress[0].ports,[{protocol:'UDP',port:53},{protocol:'TCP',port:53}]);
 const hook=policies.find(o=>o.metadata.name.endsWith('-api-egress'));assert.deepEqual(hook.spec.egress[1].to,[{ipBlock:{cidr:'10.0.0.1/32'}}]);assert.deepEqual(hook.spec.egress[1].ports,[{protocol:'TCP',port:443},{protocol:'TCP',port:6443}]);
 const v=configured();v.network.modelEgress=[{cidr:'203.0.113.0/24',port:443}];const allowed=render(t,v).find(o=>o.kind==='NetworkPolicy'&&o.metadata.name.endsWith('-home-egress'));assert.deepEqual(allowed.spec.egress[1],{to:[{ipBlock:{cidr:'203.0.113.0/24'}}],ports:[{protocol:'TCP',port:443}]});
});
}else{test('security rendering requires Helm when requested',t=>{assert.notEqual(process.env.BACKBONE_FLEET_REQUIRE_HELM,'1');t.diagnostic('Helm unavailable: schema and Compose properties run; rendering requires Helm.');});}
test('Compose uses private networks and the same container hardening and explicit trial acknowledgement',()=>{
 const compose=JSON.parse(readFileSync(join(root,'deploy/compose/fleet.yaml'),'utf8'));
 for(const [name,c] of Object.entries(compose.services)){
  assert.equal(c.environment.BACKBONE_KEYS,'plaintext');assert.equal(c.environment.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK,'1');assert.equal(c.user,'1000:1000');assert.equal(c.read_only,true);assert.deepEqual(c.cap_drop,['ALL']);assert.deepEqual(c.security_opt,['no-new-privileges:true']);assert.equal(c.ports,undefined);assert.deepEqual(c.networks,[name]);assert.equal(compose.networks[name].internal,true);assert.ok(c.environment.BACKBONE_PLAINTEXT_TRIAL_ACK.includes(':?'));assert.ok(c.tmpfs.some(v=>v.startsWith('/tmp:')));assert.ok(c.volumes.some(v=>v.endsWith(':/pg-runtime')));
 }
});
