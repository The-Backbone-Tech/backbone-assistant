// Opt-in: caller holds the shared heavy lock. Every resource belongs to this test's random cluster.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
const root = resolve(import.meta.dirname, '..');
if (process.env.BACKBONE_FLEET_RUNTIME === '1') {
  test('two homes retain work across serial upgrades, refuse a second writer, and recover by Helm rollback', {timeout:2_400_000}, async t => {
    const dir = mkdtempSync(join(tmpdir(),'fleet-kind-'));
    const name = `fleet-${process.pid}-${Date.now().toString(36)}`;
    const registry = `${name}-registry`, localImage = `${name}:base`, storage = `${name}-storage`;
    const config = join(dir,'kubeconfig');
    const tags = [localImage, `${name}:good`, `${name}:bad`];
    const env = {...process.env,KUBECONFIG:config};
    function run(bin,args,options={}) {
      const result = spawnSync(bin,args,{cwd:root,env,encoding:'utf8',timeout:600_000,...options});
      if(result.status!==0 && bin==='helm') {
        for(const args of [['get','pods'],['logs','job/fleet-backup','--all-containers=true'],['logs','job/fleet-rollout','--all-containers=true'],['get','events','--sort-by=.lastTimestamp']]) {
          const evidence=spawnSync('kubectl',['-n','fleet',...args],{env,encoding:'utf8',timeout:30000});
          t.diagnostic((evidence.stdout+evidence.stderr).slice(-14000));
        }
        const listing=spawnSync('kubectl',['-n','fleet','get','pods','-o','json'],{env,encoding:'utf8',timeout:30000});
        if(listing.status===0) for(const pod of JSON.parse(listing.stdout).items) {
          const logs=spawnSync('kubectl',['-n','fleet','logs',pod.metadata.name,'--all-containers=true'],{env,encoding:'utf8',timeout:30000});
          t.diagnostic(`${pod.metadata.name}:\n${logs.stdout+logs.stderr}`.slice(-14000));
        }
      }
      assert.equal(result.status,0,`${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    }
    const kube = args => run('kubectl',['-n','fleet',...args]);
    const json = args => JSON.parse(kube([...args,'-o','json']));
    const pod = home => json(['get','pod',`fleet-${home}-0`]);
    const helm = args => run('helm',[...args,'-n','fleet']);
    t.after(() => {
      spawnSync('kind',['delete','cluster','--name',name],{env,encoding:'utf8',timeout:120_000});
      spawnSync('docker',['rm','-fv',registry],{env,encoding:'utf8',timeout:30_000});
      spawnSync('docker',['volume','rm',storage],{env,encoding:'utf8',timeout:30_000});
      spawnSync('docker',['image','rm',...tags],{env,encoding:'utf8',timeout:30_000});
      rmSync(dir,{recursive:true,force:true});
    });
    run('docker',['info']);
    run('docker',['build','-f','deploy/docker/Dockerfile','-t',localImage,'.']);
    run('docker',['run','-d','--name',registry,'-p','127.0.0.1::5000','registry:2']);
    // A named volume gives kind's local-path claims ext4/XFS backing instead of the node's overlay.
    run('docker',['volume','create',storage]);
    const storageRoot=JSON.parse(run('docker',['volume','inspect',storage]))[0].Mountpoint;
    writeFileSync(join(dir,'kind.yaml'),JSON.stringify({
      kind:'Cluster',apiVersion:'kind.x-k8s.io/v1alpha4',
      nodes:[{role:'control-plane',extraMounts:[{hostPath:storageRoot,containerPath:'/var/local-path-provisioner'}]}],
      containerdConfigPatches:['[plugins."io.containerd.cri.v1.images".registry]\nconfig_path = "/etc/containerd/certs.d"'],
    }));
    run('kind',['create','cluster','--name',name,'--config',join(dir,'kind.yaml'),'--kubeconfig',config,'--wait','120s']);
    run('docker',['network','connect','kind',registry]);
    // Docker can reassign a dynamic published port when attaching another network.
    const inspect=JSON.parse(run('docker',['inspect',registry]))[0];
    const port=inspect.NetworkSettings.Ports['5000/tcp'][0].HostPort;
    const repository=`${registry}:5000/home`, hostRepo=`localhost:${port}/home`;
    run('docker',['exec',`${name}-control-plane`,'mkdir','-p',`/etc/containerd/certs.d/${registry}:5000`]);
    run('docker',['exec','-i',`${name}-control-plane`,'sh','-c',`cat > /etc/containerd/certs.d/${registry}:5000/hosts.toml`],{input:`[host."http://${registry}:5000"]\n  capabilities = ["pull", "resolve"]\n`});
    function publish(tag,dockerfile) {
      if (dockerfile) run('docker',['build','-t',`${name}:${tag}`,'-f','-','.'],{input:dockerfile});
      tags.push(`${hostRepo}:${tag}`);
      run('docker',['tag',dockerfile?`${name}:${tag}`:localImage,`${hostRepo}:${tag}`]);
      run('docker',['push',`${hostRepo}:${tag}`]);
      const digest=JSON.parse(run('docker',['image','inspect',`${hostRepo}:${tag}`]))[0].RepoDigests.find(d=>d.startsWith(hostRepo+'@')).split('@')[1];
      return digest;
    }
    const first=publish('base');
    const second=publish('good',`FROM ${localImage}\nLABEL fleet.test.revision="second"\n`);
    // Doctor fails only in the replacement image; backups still run with the previous good image.
    const wrapper=`if(process.argv.includes('doctor')){console.log(JSON.stringify({ok:false,checks:[]}));process.exit(1)}else{await import('./fleet-original.ts')}`;
    const bad=publish('bad',`FROM ${localImage}\nUSER root\nRUN mv packages/surfaces/cli/src/main.ts packages/surfaces/cli/src/fleet-original.ts\nCOPY --chown=root:root fleet-main.ts packages/surfaces/cli/src/main.ts\nUSER node\n`.replace('COPY --chown=root:root fleet-main.ts packages/surfaces/cli/src/main.ts',`RUN ${JSON.stringify(['node','-e',`require('fs').writeFileSync('packages/surfaces/cli/src/main.ts',${JSON.stringify(wrapper)})`])}`));
    const values=JSON.parse(readFileSync(join(root,'deploy/helm/backbone/values.yaml'),'utf8'));
    values.image={repository,digest:first}; values.rollout.timeoutSeconds=60;
    // Disposable local-path storage is not encrypted: these confirmations exercise the trial contract only.
    values.trial.plaintextKeysAcknowledged=true;
    values.storage={className:'standard',size:'1Gi',encryptionConfirmed:true};
    values.backups={className:'standard',size:'2Gi',encryptionConfirmed:true,retention:{maxArchives:2}};
    const api=JSON.parse(run('kubectl',['get','service','kubernetes','-n','default','-o','json']));
    const endpoints=JSON.parse(run('kubectl',['get','endpoints','kubernetes','-n','default','-o','json']));
    values.network.apiServerCidrs=[api.spec.clusterIP,...endpoints.subsets.flatMap(s=>s.addresses.map(a=>a.ip))].map(ip=>`${ip}/32`);
    // Real byte-preservation/ownership fixtures. C8 signature verification is enabled when integrated.
    for(const home of values.homes) home.policy={'managed-policy.json':'{"fixture":true}\n','managed-policy.json.sig':Buffer.alloc(64,7).toString('base64'),'policy-trust.json':'{"fixture":true}\n'};
    const file=join(dir,'values.json');
    const save=()=>writeFileSync(file,JSON.stringify(values)); save();
    helm(['install','fleet','deploy/helm/backbone','-f',file,'--create-namespace','--timeout','15m']);
    assert.ok(values.homes.every(h=>pod(h.name).status.conditions.some(c=>c.type==='Ready'&&c.status==='True')));
    const policy=json(['get','validatingadmissionpolicy']);
    for(const p of policy.items)assert.deepEqual(p.status?.typeChecking?.expressionWarnings??[],[],JSON.stringify(p.status));
    assert.equal(json(['get','namespace','fleet']).metadata.labels['pod-security.kubernetes.io/enforce'],'baseline');
    assert.equal(json(['get','networkpolicies']).items.length,3);
    const identity='system:serviceaccount:fleet:fleet-rollout';
    for(const [verb,resource,allowed] of [['get','pods/fleet-alpha-0',true],['delete','pods/unrelated',false],['patch','statefulsets.apps/unrelated',false],['get','secrets',false]]){
      const check=spawnSync('kubectl',['-n','fleet','auth','can-i',verb,resource,`--as=${identity}`],{env,encoding:'utf8'});
      assert.equal(check.stdout.trim(),allowed?'yes':'no');
    }
    // Server-side dry-run exercises admission as the actual hook identity without executing a backup.
    const original=pod('alpha'),worker=structuredClone(original.spec);
    delete worker.nodeName;delete worker.serviceAccount;delete worker.serviceAccountName;
    worker.restartPolicy='Never';worker.automountServiceAccountToken=false;
    const c=worker.containers[0];delete c.readinessProbe;delete c.startupProbe;delete c.args;
    c.command=['node','/fleet/backup.mjs','/backups/archives/revision-2'];
    c.env.push({name:'BACKBONE_BACKUP_ROOT',value:'/backups/archives'},{name:'BACKBONE_BACKUP_RETENTION',value:'2'});
    c.volumeMounts.push({name:'backups',mountPath:'/backups'});
    worker.volumes.push({name:'backups',persistentVolumeClaim:{claimName:'fleet-alpha-backups'}});
    const prep=worker.initContainers.find(c=>c.name==='prepare');prep.env=[{name:'BACKBONE_BACKUP_ROOT',value:'/backups/archives'}];prep.volumeMounts.push({name:'backups',mountPath:'/backups'});
    const candidate={apiVersion:'batch/v1',kind:'Job',metadata:{name:'fleet-alpha-backup'},spec:{parallelism:1,completions:1,backoffLimit:0,template:{metadata:{labels:{'app.kubernetes.io/instance':'fleet','app.kubernetes.io/component':'backup'}},spec:worker}}};
    const admit=object=>spawnSync('kubectl',['-n','fleet','create','--dry-run=server',`--as=${identity}`,'-f','-'],{env,input:JSON.stringify(object),encoding:'utf8'});
    const valid=admit(candidate);assert.equal(valid.status,0,valid.stderr);
    for(const mutate of [o=>o.metadata.name='unrelated',o=>o.spec.template.spec.automountServiceAccountToken=true,o=>o.spec.template.spec.containers[0].env.push({name:'NODE_OPTIONS',value:'--inspect'}),o=>o.spec.template.spec.volumes.find(v=>v.name==='data').persistentVolumeClaim.claimName='unrelated',o=>o.spec.template.spec.containers[0].volumeMounts[0].mountPath='/elsewhere',o=>o.spec.template.spec.containers[0].image='untrusted:latest']){
      const altered=structuredClone(candidate);mutate(altered);const denied=admit(altered);assert.notEqual(denied.status,0);assert.match(denied.stderr,/denied|forbidden/i);
    }
    t.diagnostic('baseline, named RBAC, admission refusal and NetworkPolicy resources verified; kindnet does not enforce packet filtering.');
    const cli=['node','packages/surfaces/cli/src/main.ts'];
    function job(home,command,{offline=false,backup=false}={}) {
      const original=pod(home), spec=structuredClone(original.spec);
      if(offline){kube(['scale','statefulset',`fleet-${home}`,'--replicas=0']);kube(['wait','--for=delete',`pod/fleet-${home}-0`,'--timeout=120s']);}
      const id=`${name}-${home}-${Date.now().toString(36)}`;
      const container=spec.containers[0];container.command=command;delete container.args;delete container.readinessProbe;delete container.startupProbe;
      container.env.push({name:'BACKBONE_HARNESS',value:'stub'});
      if(backup){spec.volumes.push({name:'backups',persistentVolumeClaim:{claimName:`fleet-${home}-backups`}});container.volumeMounts.push({name:'backups',mountPath:'/backups',readOnly:true});}
      const object={apiVersion:'batch/v1',kind:'Job',metadata:{name:id},spec:{backoffLimit:0,activeDeadlineSeconds:120,template:{spec:{restartPolicy:'Never',nodeName:original.spec.nodeName,automountServiceAccountToken:false,securityContext:spec.securityContext,containers:[container],initContainers:spec.initContainers,volumes:spec.volumes}}}};
      try {
        run('kubectl',['-n','fleet','create','-f','-'],{input:JSON.stringify(object)});
        kube(['wait','--for=condition=complete',`job/${id}`,'--timeout=150s']);
        return kube(['logs',`job/${id}`]);
      } catch(error) {
        const logs=spawnSync('kubectl',['-n','fleet','logs',`job/${id}`],{env,encoding:'utf8'});
        t.diagnostic(logs.stdout || logs.stderr);
        throw error;
      } finally {
        kube(['delete','job',id,'--wait=true']);
        if(offline){
          kube(['scale','statefulset',`fleet-${home}`,'--replicas=1']);
          kube(['wait','--for=create',`pod/fleet-${home}-0`,'--timeout=180s']);
          kube(['wait','--for=condition=Ready',`pod/fleet-${home}-0`,'--timeout=180s']);
        }
      }
    }
    const thread=JSON.parse(job('alpha',[...cli,'send','fleet preserved thread','--json'],{offline:true}));
    const humanEdit=`(async()=>{const req=require('module').createRequire(require('path').resolve('packages/surfaces/cli/package.json'));const {withHomeLock,assertHomeWriteAdmission}=await import(req.resolve('@backbone-next/platform/composition/home-lock'));await withHomeLock('/data/home',async()=>{assertHomeWriteAdmission('/data/home');require('fs').writeFileSync('/data/home/fleet-human-edit.txt','operator edit before upgrade');},0)})().catch(e=>{console.error(e);process.exit(1)})`;
    job('alpha',['node','-e',humanEdit],{offline:true});
    const preservedEdit=()=>assert.equal(kube(['exec','fleet-alpha-0','--','node','-e',`process.stdout.write(require('fs').readFileSync('/data/home/fleet-human-edit.txt','utf8'))`]),'operator edit before upgrade');

    const before=kube(['exec','fleet-alpha-0','--',...cli,'threads','list','--json']);
    assert.ok(JSON.parse(before).length>0);
    for(const home of values.homes) {
      const code=`const fs=require('fs');for(const f of ['managed-policy.json','managed-policy.json.sig','policy-trust.json']){const p='/etc/backbone/'+f,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&18))process.exit(1)}if(!fs.readFileSync('/etc/backbone/managed-policy.json.sig').equals(Buffer.alloc(64,7)))process.exit(1)`;
      kube(['exec',`fleet-${home.name}-0`,'--','node','-e',code]);
    }
    kube(['exec','fleet-alpha-0','--','node','-e',`try{require('fs').writeFileSync('/opt/backbone/fleet-write','x');process.exit(1)}catch(e){if(e.code!=='EROFS')throw e}`]);
    const refusal=`const r=require('child_process').spawnSync(process.execPath,${JSON.stringify([...cli.slice(1),'daemon','run'])},{stdio:'inherit',timeout:30000});process.exit(r.status===5?0:1)`;
    job('alpha',['node','-e',refusal]);
    values.image.digest=second; save();
    helm(['upgrade','fleet','deploy/helm/backbone','-f',file,'--timeout','15m']);
    const after=kube(['exec','fleet-alpha-0','--',...cli,'threads','list','--json']);
    assert.deepEqual(JSON.parse(after),JSON.parse(before)); assert.ok(thread);preservedEdit();
    job('alpha',['sh','-ec','test -s /backups/archives/revision-2/home.tar && test -d /backups/archives/revision-2/export && test -s /backups/archives/revision-2/complete.json'],{backup:true});
    values.image.digest=bad;save();
    const upgrade=spawn('helm',['-n','fleet','upgrade','fleet','deploy/helm/backbone','-f',file,'--timeout','15m'],{cwd:root,env,stdio:['ignore','pipe','pipe'],timeout:1_000_000});
    let status,output='',betaAfterBackup;
    upgrade.stdout.on('data',bytes=>output=(output+bytes).slice(-14000));
    upgrade.stderr.on('data',bytes=>output=(output+bytes).slice(-14000));
    const ended=new Promise(resolve=>{upgrade.on('error',error=>output+=error.message);upgrade.on('close',code=>{status=code;resolve(code);});});
    try {
      const end=Date.now()+1_000_000;
      while(status===undefined && Date.now()<end) {
        const current=spawnSync('kubectl',['-n','fleet','get','pod','fleet-alpha-0','-o','json'],{env,encoding:'utf8',timeout:30000});
        if(current.status===0 && JSON.parse(current.stdout).spec.containers[0].image===`${repository}@${bad}`) {
          // Backups restart old pods. Observe identity only after the first version replacement begins.
          const next=pod('beta');betaAfterBackup=next.metadata.uid;
          assert.equal(next.spec.containers[0].image,`${repository}@${second}`);
          break;
        }
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      assert.ok(betaAfterBackup,`the failing replacement must be observed: ${output}`);
      const failedStatus=await ended;
      assert.ok(Number.isInteger(failedStatus)&&failedStatus>0,`a failed doctor must fail the upgrade with a known exit status: ${output}`);
    } finally {if(status===undefined){upgrade.kill('SIGTERM');await ended;}}
    assert.equal(pod('beta').metadata.uid,betaAfterBackup,'later homes must not roll after failed readiness');
    helm(['rollback','fleet','2','--timeout','15m']);
    for(const home of values.homes)assert.equal(pod(home.name).spec.containers[0].image,`${repository}@${second}`);
    assert.deepEqual(JSON.parse(kube(['exec','fleet-alpha-0','--',...cli,'threads','list','--json'])),JSON.parse(before));preservedEdit();
  });
} else {
  test('fleet runtime acceptance has an explicit isolated-cluster command', t => {
    t.diagnostic('Run BACKBONE_FLEET_RUNTIME=1 node --test scripts/fleet-runtime.test.mjs under the shared heavy lock.');
  });
}
